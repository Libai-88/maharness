import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../agent';
import { isProviderCircuitOpen, LLMHttpError, noteProviderFailure, PROVIDER_CIRCUIT_RESET_MS, PROVIDER_CIRCUIT_THRESHOLD } from '../provider-health';
import type { EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, TraceStepInit, ToolDef } from '../../../kernel/types';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

function kernel(): KernelLike {
  const config = new Map<string, unknown>([
    ['agent.toolTimeoutMs', 1000], ['agent.reasoningBudget', 640], ['agent.reasoningTotalBudget', 2000],
    ['agent.maxTurns', 2], ['agent.thinkInEnglish', true], ['sandboxRoot', process.cwd()],
  ]);
  return {
    rootDir: process.cwd(), paths: { root: process.cwd(), data: process.cwd(), traces: process.cwd(), configFile: '', dbFile: '', cacheFile: '' },
    config: { get: <T>(key: string, def?: T): T => (config.has(key) ? config.get(key) as T : def as T) } as unknown as KernelLike['config'],
    trace: { startStep: (_init: TraceStepInit): StepHandle => ({ id: 'retry-step', finish: () => {}, fail: () => {}, cancel: () => {} }) } as unknown as KernelLike['trace'],
    cache: { l1Enabled: false, recordPrefixRepeat: () => {}, recordProviderCacheHit: () => {}, recordSavedCost: () => {} } as unknown as KernelLike['cache'],
    budget: { recordTask: () => {} } as unknown as KernelLike['budget'],
    plugins: { capabilities: (): [] => [] } as unknown as KernelLike['plugins'],
  };
}

function successProvider(id: string, calls: { count: number }): ProviderDef {
  return {
    id, label: id, defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      calls.count++;
      yield { type: 'delta', text: `${id}-ok` };
      yield { type: 'done' };
    },
  };
}

describe('AgentRunner Provider 重试策略', () => {
  test('连续瞬时失败打开熔断、跳过主线路；冷却后允许半开探测', async () => {
    const id = 'circuit-open-test';
    let primaryCalls = 0;
    const primary: ProviderDef = {
      id, label: id, defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> { primaryCalls++; throw new LLMHttpError(503, 'upstream unavailable'); },
    };
    const runner = new AgentRunner(kernel(), bus);
    for (let i = 0; i < PROVIDER_CIRCUIT_THRESHOLD; i++) {
      for await (const _event of runner.run({ provider: primary, model: 'm', messages: [{ role: 'user', content: 'fail' }], traceId: `circuit-failure-${i}` })) { /* drain */ }
    }
    assert.equal(primaryCalls, PROVIDER_CIRCUIT_THRESHOLD * 2, '每次请求最多进行两次尝试');
    assert.equal(isProviderCircuitOpen(id), true);
    const fallbackCalls = { count: 0 };
    const events: string[] = [];
    for await (const event of runner.run({
      provider: primary, fallbackProviders: [successProvider('circuit-fallback', fallbackCalls)], model: 'm',
      messages: [{ role: 'user', content: 'answer' }], traceId: 'circuit-failover',
    })) events.push(event.type);
    assert.equal(primaryCalls, PROVIDER_CIRCUIT_THRESHOLD * 2, '熔断期间不应再调用主线路');
    assert.equal(fallbackCalls.count, 1);
    assert.ok(events.includes('assistant_done'));
    assert.equal(isProviderCircuitOpen(id, Date.now() + PROVIDER_CIRCUIT_RESET_MS), false);
  });

  test('认证、参数和取消错误不会打开 Provider 熔断', () => {
    const id = 'circuit-non-transient-test';
    for (let i = 0; i < PROVIDER_CIRCUIT_THRESHOLD + 1; i++) noteProviderFailure(id, new LLMHttpError(401, 'unauthorized'));
    assert.equal(isProviderCircuitOpen(id), false);
  });

  test('瞬时 500 在同一线路只重试一次后成功', async () => {
    let calls = 0;
    const provider: ProviderDef = {
      id: 'flaky', label: 'flaky', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> {
        calls++;
        if (calls === 1) throw new LLMHttpError(500, 'temporary outage');
        yield { type: 'delta', text: 'recovered' };
        yield { type: 'done' };
      },
    };
    const events: string[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'answer' }], traceId: 'retry-transient',
    })) events.push(event.type);
    assert.equal(calls, 2);
    assert.ok(events.includes('retry'));
    assert.ok(events.includes('assistant_done'));
  });

  test('AgentRunner 按 Retry-After 等待后再重试限流 Provider', async () => {
    const callTimes: number[] = [];
    const provider: ProviderDef = {
      id: 'retry-after-runner', label: 'retry-after-runner', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> {
        callTimes.push(Date.now());
        if (callTimes.length === 1) throw new LLMHttpError(429, 'rate limited', 40);
        yield { type: 'delta', text: 'recovered' };
        yield { type: 'done' };
      },
    };
    const events: string[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'answer' }], traceId: 'retry-after-runner',
    })) events.push(event.type);
    assert.equal(callTimes.length, 2);
    assert.ok(callTimes[1] - callTimes[0] >= 35, '二次调用应遵循 Retry-After 等待');
    assert.ok(events.includes('assistant_done'));
  });

  test('401 不在同一线路重试，但可切换备用 Provider', async () => {
    const primary = { count: 0 };
    const fallback = { count: 0 };
    const first: ProviderDef = {
      id: 'primary', label: 'primary', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> { primary.count++; throw new LLMHttpError(401, 'unauthorized'); },
    };
    const events: string[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider: first, fallbackProviders: [successProvider('fallback', fallback)], model: 'm',
      messages: [{ role: 'user', content: 'answer' }], traceId: 'retry-auth',
    })) events.push(event.type);
    assert.equal(primary.count, 1);
    assert.equal(fallback.count, 1);
    assert.ok(events.includes('retry'));
    assert.ok(events.includes('assistant_done'));
  });

  test('只有幂等工具按声明重试瞬时失败，副作用工具默认不重试', async () => {
    let calls = 0;
    let providerCalls = 0;
    const provider: ProviderDef = {
      id: 'tool-provider', label: 'tool-provider', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> {
        providerCalls++;
        if (providerCalls === 1) {
          yield { type: 'tool_call', toolCall: { id: 'tool-1', type: 'function', function: { name: 'read_remote', arguments: '{}' } } };
        } else {
          yield { type: 'delta', text: 'done' };
          yield { type: 'done' };
        }
      },
    };
    const tool: ToolDef = {
      name: 'read_remote', description: 'read', parameters: { type: 'object', properties: {} },
      idempotent: true, retry: { maxAttempts: 2, backoffMs: 1 },
      async handler() { calls++; if (calls === 1) throw new Error('ETIMEDOUT'); return { ok: true, data: { value: 1 } }; },
    };
    const events: string[] = [];
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'read' }], tools: [tool], traceId: 'tool-retry',
    })) events.push(event.type);
    assert.equal(calls, 2);
    assert.ok(events.includes('tool_result'));
    assert.ok(events.includes('assistant_done'));
  });

  test('Provider 退避期间取消会清理等待且不发起下一次请求', async () => {
    let calls = 0;
    const provider: ProviderDef = {
      id: 'cancel-retry', label: 'cancel-retry', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> { calls++; setTimeout(() => controller.abort(), 10); throw new LLMHttpError(500, 'temporary outage'); },
    };
    const controller = new AbortController();
    const events: string[] = [];
    const started = Date.now();
    for await (const event of new AgentRunner(kernel(), bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'answer' }], traceId: 'cancel-provider-retry', signal: controller.signal,
    })) {
      events.push(event.type);
    }
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 500, '取消不应等待 Provider 退避时长');
    assert.ok(events.some((event) => event === 'error'));
  });

  test('幂等工具退避期间取消会结束等待且不重放 handler', async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    let signalFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>((resolve) => { signalFirstAttempt = resolve; });
    const provider: ProviderDef = {
      id: 'cancel-tool-retry', label: 'cancel-tool-retry', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> {
        providerCalls++;
        yield { type: 'tool_call', toolCall: { id: 'tool-1', type: 'function', function: { name: 'read_remote', arguments: '{}' } } };
      },
    };
    const tool: ToolDef = {
      name: 'read_remote', description: 'read', parameters: { type: 'object', properties: {} },
      idempotent: true, retry: { maxAttempts: 2, backoffMs: 5_000 },
      async handler() { toolCalls++; signalFirstAttempt(); return { ok: false, error: 'ETIMEDOUT' }; },
    };
    const controller = new AbortController();
    const events: string[] = [];
    const running = (async () => {
      for await (const event of new AgentRunner(kernel(), bus).run({
        provider, model: 'm', messages: [{ role: 'user', content: 'read' }], tools: [tool], traceId: 'cancel-tool-retry', signal: controller.signal,
      })) events.push(event.type);
    })();
    await firstAttempt;
    const started = Date.now();
    controller.abort();
    await running;
    assert.equal(toolCalls, 1);
    assert.equal(providerCalls, 1);
    assert.ok(Date.now() - started < 500, '取消不应等待工具退避时长');
    assert.ok(events.includes('error'));
  });
});
