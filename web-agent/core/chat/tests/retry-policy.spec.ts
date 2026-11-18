import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../agent';
import { ExecutionPool } from '../../../kernel/execution-pool';
import { acquireWriteLock } from '../../../kernel/write-lock';
import { isProviderCircuitOpen, LLMHttpError, noteProviderFailure, PROVIDER_CIRCUIT_RESET_MS, PROVIDER_CIRCUIT_THRESHOLD } from '../provider-health';
import type { AgentEvent, EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, TraceStepInit, ToolDef } from '../../../kernel/types';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

test('timed-out handlers retain their execution slot and workspace lock until physical completion', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const pool = new ExecutionPool(1);
  let calls = 0;
  const provider: ProviderDef = { id: 'timeout-lock', label: 'test', defaultModel: 'm', async *chat() {
    if (++calls === 1) yield { type: 'tool_call', toolCall: { id: 'call', type: 'function', function: { name: 'write_file', arguments: '{}' } } };
    else yield { type: 'delta', text: 'finished' };
  } };
  const workspace = `${process.cwd()}/test-timeout-${Date.now()}`;
  let lockAcquired = false;
  try {
    for await (const _event of new AgentRunner(kernel(), bus).run({
      runId: 'run-lock', provider, model: 'm', traceId: 'lock', messages: [{ role: 'user', content: 'write' }], sandboxRoot: workspace,
      acquireExecution: signal => pool.acquire('root', signal),
      tools: [{version: '2.0.0', permissions: [], outputSchema: {},  name: 'write_file', description: 'write', parameters: { type: 'object' }, sideEffect: 'write', timeoutMs: 10, async handler() { await held; return { ok: true }; } }],
    })) {
      if (_event.type === 'tool_result') break;
    }
    assert.equal(pool.occupied, 1);
    const next = acquireWriteLock(workspace, 'other').then(release => { lockAcquired = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(lockAcquired, false);
    finish(); const release = await next; release();
    assert.equal(pool.occupied, 0);
  } finally { finish(); }
});

test('readonly principal cannot obtain write authority through approval', async () => {
  let invoked = false; let calls = 0; let approval = false;
  const provider: ProviderDef = { id: 'readonly-principal', label: 'test', defaultModel: 'm', async *chat() {
    if (++calls === 1) yield { type: 'tool_call', toolCall: { id: 'call', type: 'function', function: { name: 'write_test', arguments: '{}' } } };
    else yield { type: 'delta', text: 'finished' };
  } };
  for await (const event of new AgentRunner(kernel(), bus).run({
    provider, model: 'm', traceId: 'readonly', principalRole: 'readonly', messages: [{ role: 'user', content: 'write' }],
    tools: [{version: '2.0.0', permissions: [], outputSchema: {},  name: 'write_test', description: 'write', parameters: { type: 'object' }, sideEffect: 'write', async handler() { invoked = true; return { ok: true }; } }],
  })) { if (event.type === 'approval_required') approval = true; }
  assert.equal(invoked, false); assert.equal(approval, false);
});

test('known tool precondition failures remain observations and allow corrective retry', async () => {
  let calls = 0;
  let sawExplicitFailure = false;
  const provider: ProviderDef = {
    id: 'edit-no-match', label: 'test', defaultModel: 'm',
    async *chat(messages) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', toolCall: { id: 'edit-1', type: 'function', function: { name: 'edit_file', arguments: '{}' } } };
      } else {
        const observation = messages.findLast(message => message.role === 'tool');
        sawExplicitFailure = /"code":"EDIT_NO_MATCH"/.test(observation?.content ?? '')
          && /"outcome":"not_started"/.test(observation?.content ?? '');
        yield { type: 'delta', text: '已改用准确原文重试' };
      }
      yield { type: 'done' };
    },
  };
  const events: AgentEvent[] = [];
  for await (const event of new AgentRunner(kernel(), bus).run({
    provider, model: 'm', traceId: 'edit-no-match', messages: [{ role: 'user', content: '修改文件' }], maxTurns: 3,
    tools: [{
      version: '2.0.0', permissions: ['workspace.write'], outputSchema: {}, name: 'edit_file', description: 'edit file',
      parameters: { type: 'object' }, sideEffect: 'write',
      async handler() {
        return { ok: false, error: '第 1 处编辑未找到匹配文本（文件未改动）', failure: { code: 'EDIT_NO_MATCH', retryable: false, outcome: 'not_started' as const } };
      },
    }],
  })) events.push(event);
  assert.equal(calls, 2);
  assert.equal(sawExplicitFailure, true);
  assert.equal(events.some(event => event.type === 'error' && event.kind === 'policy'), false);
  assert.equal(events.some(event => event.type === 'assistant_done' && event.content === '已改用准确原文重试'), true);
});

test('reasoning-only model responses retry and never complete with an empty answer', async () => {
  let calls = 0;
  const provider: ProviderDef = {
    id: 'empty-response', label: 'test', defaultModel: 'm',
    async *chat() {
      calls++;
      yield { type: 'reasoning', text: 'I should inspect the workspace.' };
      yield { type: 'done' };
    },
  };
  const events: AgentEvent[] = [];
  for await (const event of new AgentRunner(kernel(), bus).run({
    provider, model: 'm', traceId: 'empty-response', messages: [{ role: 'user', content: '查看工作区文件' }], maxTurns: 3,
  })) events.push(event);
  assert.equal(calls, 2);
  assert.equal(events.some(event => event.type === 'assistant_done'), false);
  assert.equal(events.some(event => event.type === 'error' && event.code === 'EMPTY_RESPONSE'), true);
});

for (const length of [1999, 2000, 2001, 3999, 4000, 4001, 7999, 8000, 8001]) {
  test(`tool result boundary ${length} preserves inline content and paging`, async () => {
    let calls = 0;
    let observation = '';
    const envelope = { ok: true, data: { text: '' } };
    const text = 'x'.repeat(length - JSON.stringify(envelope).length);
    const result = { ok: true, data: { text } };
    const provider: ProviderDef = { id: 'boundary', label: 'test', defaultModel: 'm', async *chat(messages) {
      if (++calls === 1) yield { type: 'tool_call', toolCall: { id: 'read', type: 'function', function: { name: 'list_dir', arguments: '{}' } } };
      else { observation = messages.findLast(message => message.role === 'tool')?.content ?? ''; yield { type: 'delta', text: '目录已查看' }; }
      yield { type: 'done' };
    } };
    let reads = 0;
    for await (const _event of new AgentRunner(kernel(), bus).run({ provider, model: 'm', traceId: `boundary-${length}`, messages: [{ role: 'user', content: '查看根目录' }], tools: [{ version: '1.0.0', permissions: [], outputSchema: {}, name: 'list_dir', description: 'list', parameters: {}, sideEffect: 'read', async handler() { reads++; return result; } }] })) {}
    const parsed = JSON.parse(observation);
    if (length <= 8000) { assert.deepEqual(parsed, result); assert.equal((parsed as { resultRef?: string }).resultRef, undefined); }
    else { assert.equal(parsed.content, JSON.stringify(result).slice(0, 8000)); assert.equal(parsed.nextOffset, 8000); assert.ok(parsed.resultRef); }
    assert.equal(calls, 2); assert.equal(reads, 1);
  });
}

test('one empty response recovers into a valid answer', async () => {
  let calls = 0;
  const provider: ProviderDef = { id: 'recover-empty', label: 'test', defaultModel: 'm', async *chat() {
    if (++calls === 1) yield { type: 'reasoning', text: 'thinking' };
    else yield { type: 'delta', text: '结果已交付' };
    yield { type: 'done' };
  } };
  const events = [];
  for await (const event of new AgentRunner(kernel(), bus).run({ provider, model: 'm', traceId: 'recover-empty', messages: [{ role: 'user', content: '回答' }], tools: [] })) events.push(event);
  assert.equal(calls, 2); assert.ok(events.some(event => event.type === 'assistant_done' && event.content === '结果已交付'));
});

test('call-specific read-only side effect lets a failed shell observation recover without an unknown-effect stop', async () => {
  let calls = 0;
  let sawNotStarted = false;
  const provider: ProviderDef = {
    id: 'dynamic-read-shell', label: 'test', defaultModel: 'm',
    async *chat(messages) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', toolCall: { id: 'shell-1', type: 'function', function: { name: 'powershell_execute', arguments: '{"command":"Get-ChildItem"}' } } };
      } else {
        const observation = messages.findLast(message => message.role === 'tool');
        sawNotStarted = /"code":"TOOL_EXECUTION"/.test(observation?.content ?? '')
          && /"outcome":"not_started"/.test(observation?.content ?? '');
        yield { type: 'delta', text: '已改用文件工具读取' };
      }
      yield { type: 'done' };
    },
  };
  const events: AgentEvent[] = [];
  for await (const event of new AgentRunner(kernel(), bus).run({
    provider, model: 'm', traceId: 'dynamic-read-shell', messages: [{ role: 'user', content: '查看文件' }], maxTurns: 3,
    tools: [{
      version: '2.0.0', permissions: ['process'], outputSchema: {}, name: 'powershell_execute', description: 'shell',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, sideEffect: 'irreversible',
      classifySideEffect(args) { return String((args as { command?: string }).command ?? '').startsWith('Get-') ? 'read' : 'irreversible'; },
      async handler() { throw new Error('cmdlet unavailable'); },
    }],
  })) events.push(event);
  assert.equal(calls, 2);
  assert.equal(sawNotStarted, true);
  assert.equal(events.some(event => event.type === 'error' && event.kind === 'policy'), false);
  assert.equal(events.some(event => event.type === 'assistant_done' && event.content === '已改用文件工具读取'), true);
});

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
    const tool: ToolDef = {version: '2.0.0', permissions: [], outputSchema: {},
      name: 'read_remote', description: 'read', parameters: { type: 'object', properties: {} }, sideEffect: 'read',
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
    const tool: ToolDef = {version: '2.0.0', permissions: [], outputSchema: {},
      name: 'read_remote', description: 'read', parameters: { type: 'object', properties: {} }, sideEffect: 'read',
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

test('two truncated tool batches never execute writes or report assistant completion', async () => {
  let writes = 0;
  const source: ProviderDef = { id: 'length-fixture', label: 'test', defaultModel: 'm', async *chat() { yield { type: 'tool_call', toolCall: { id: 'incomplete', type: 'function', function: { name: 'write_test', arguments: '{}' } } }; yield { type: 'done', reason: 'length' }; } };
  const events = [];
  for await (const event of new AgentRunner(kernel(), bus).run({ provider: source, model: 'm', traceId: 'length', messages: [{ role: 'user', content: 'write long document' }], maxTurns: 4, tools: [{ version: '1.0.0', permissions: [], outputSchema: {}, name: 'write_test', description: 'write', parameters: { type: 'object' }, sideEffect: 'write', async handler() { writes++; return { ok: true }; } }] })) events.push(event);
  assert.equal(writes, 0); assert.equal(events.some(e => e.type === 'assistant_done'), false); assert.ok(events.some(e => e.type === 'error' && e.code === 'OUTPUT_TRUNCATED'));
});
test('truncated prose continues without losing the saved prefix', async () => {
  let calls = 0;
  const source: ProviderDef = { id: 'prose-fixture', label: 'test', defaultModel: 'm', async *chat() { calls++; yield { type: 'delta', text: calls === 1 ? 'first portion. ' : 'last portion.' }; yield { type: 'done', reason: calls === 1 ? 'length' : 'stop' }; } };
  const events = [];
  for await (const event of new AgentRunner(kernel(), bus).run({ provider: source, model: 'm', traceId: 'prose', messages: [{ role: 'user', content: 'continue prose' }], tools: [] })) events.push(event);
  const done = events.find(e => e.type === 'assistant_done'); assert.ok(done && done.content === 'first portion. last portion.'); assert.equal(calls, 2);
});
