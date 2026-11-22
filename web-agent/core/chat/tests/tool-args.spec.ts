import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../agent';
import type {
  ChatOptions,
  EventBusLike,
  KernelLike,
  LLMChunk,
  ProviderDef,
  StepHandle,
  ToolDef,
  TraceStepInit,
} from '../../../kernel/types';

const bus: EventBusLike = {
  on: () => () => {},
  emit: () => {},
  emitAsync: async () => {},
  serial: async () => undefined,
  bail: () => undefined,
  parallel: async () => {},
  waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

function kernel(): KernelLike {
  const config = new Map<string, unknown>([
    ['agent.toolTimeoutMs', 1000],
    ['agent.reasoningBudget', 640],
    ['agent.reasoningTotalBudget', 2000],
    ['agent.maxTurns', 2],
    ['agent.thinkInEnglish', true],
    ['sandboxRoot', process.cwd()],
  ]);
  return {
    rootDir: process.cwd(),
    paths: { root: process.cwd(), data: process.cwd(), traces: process.cwd(), configFile: '', dbFile: '', cacheFile: '' },
    config: {
      get: <T>(key: string, def?: T): T => (config.has(key) ? (config.get(key) as T) : (def as T)),
    } as unknown as KernelLike['config'],
    trace: {
      startStep: (_init: TraceStepInit): StepHandle => ({
        id: 'tool-args-step',
        finish: () => {},
        fail: () => {},
        cancel: () => {},
      }),
    } as unknown as KernelLike['trace'],
    cache: {
      l1Enabled: false,
      l1Get: async () => ({ hit: false }),
      l1Set: async () => {},
      recordPrefixRepeat: () => {},
      recordProviderCacheHit: () => {},
      recordSavedCost: () => {},
    } as unknown as KernelLike['cache'],
    budget: { recordTask: () => {} } as unknown as KernelLike['budget'],
    plugins: { capabilities: (): [] => [] } as unknown as KernelLike['plugins'],
  };
}

function providerFor(argumentsText: string): { provider: ProviderDef; calls: { count: number } } {
  const calls = { count: 0 };
  const provider: ProviderDef = {
    id: 'tool-args-provider',
    label: 'tool-args-provider',
    defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      calls.count++;
      if (calls.count === 1) {
        yield { type: 'tool_call', toolCall: { id: 'call-1', type: 'function', function: { name: 'demo', arguments: argumentsText } } };
      } else {
        yield { type: 'delta', text: '参数已拒绝，未执行工具。' };
      }
      yield { type: 'done' };
    },
  };
  return { provider, calls };
}

function demoTool(handlerCalls: { count: number }): ToolDef {
  return {
    version: '2.0.0',
    permissions: [],
    sideEffect: 'external',
    outputSchema: {},
    name: 'demo',
    description: 'demo tool',
    parameters: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: { path: { type: 'string', pattern: '^[a-z/]+\\.md$' } },
    },
    handler: async () => {
      handlerCalls.count++;
      return { ok: true, data: 'should not happen' };
    },
  };
}

describe('工具参数契约', () => {
  test('schema 不符时 handler 不执行，错误回填给模型', async () => {
    const handlerCalls = { count: 0 };
    const { provider } = providerFor(JSON.stringify({ path: 123, extra: true }));
    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: 'run tool' }],
      traceId: 'tool-args-schema',
      tools: [demoTool(handlerCalls)],
    }))
      events.push(event as { type: string; [key: string]: unknown });

    assert.equal(handlerCalls.count, 0);
    const result = events.find((event) => event.type === 'tool_result');
    assert.equal(result?.ok, false);
    assert.match(String(result?.summary), /schema/);
    assert.ok(events.some((event) => event.type === 'assistant_done'));
  });

  test('非法 JSON 不进入工具执行', async () => {
    const handlerCalls = { count: 0 };
    const { provider } = providerFor('{not-json');
    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: 'run tool' }],
      traceId: 'tool-args-json',
      tools: [demoTool(handlerCalls)],
    }))
      events.push(event as { type: string; [key: string]: unknown });

    assert.equal(handlerCalls.count, 0);
    const result = events.find((event) => event.type === 'tool_result');
    assert.equal(result?.ok, false);
    assert.match(String(result?.summary), /合法 JSON/);
  });

  test('responseFormat 透传到 Provider', async () => {
    let seen: ChatOptions | undefined;
    const provider: ProviderDef = {
      id: 'response-format',
      label: 'response-format',
      defaultModel: 'm',
      async *chat(_messages, opts): AsyncIterable<LLMChunk> {
        seen = opts;
        yield { type: 'delta', text: '{"ok":true}' };
        yield { type: 'done' };
      },
    };
    for await (const _event of new AgentRunner(kernel(), bus).run({
      provider,
      model: 'm',
      messages: [{ role: 'user', content: 'json' }],
      traceId: 'response-format',
      responseFormat: { type: 'json_object' },
    })) {
      /* drain */
    }
    assert.deepEqual(seen?.responseFormat, { type: 'json_object' });
  });
});
