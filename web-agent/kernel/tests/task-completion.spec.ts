import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../core/chat/agent';
import { compactHistory, SUMMARY_MARK } from '../../core/chat/compact';
import type { EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, TraceStepInit } from '../types';
import type { TaskContract } from '../loop';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

function fixture(answer: string, contextMaxTokens = 60_000) {
  const rootDir = process.cwd();
  const recorded: { failed: boolean }[] = [];
  let cacheWrites = 0;
  const cfg = new Map<string, unknown>([
    ['agent.toolTimeoutMs', 1000], ['agent.reasoningBudget', 640], ['agent.reasoningTotalBudget', 2000],
    ['agent.maxTurns', 2], ['agent.thinkInEnglish', true], ['context.maxTokens', contextMaxTokens], ['sandboxRoot', rootDir],
  ]);
  const kernel = {
    rootDir,
    paths: { root: rootDir, data: rootDir, traces: rootDir, configFile: '', dbFile: '', cacheFile: '' },
    config: { get: <T>(key: string, def?: T): T => (cfg.has(key) ? cfg.get(key) as T : def as T) },
    trace: { startStep: (_init: TraceStepInit): StepHandle => ({ id: 'step', finish: () => {}, fail: () => {}, cancel: () => {} }) },
    cache: {
      l1Enabled: true, l1Get: () => undefined, l1Set: async () => { cacheWrites++; },
      recordPrefixRepeat: () => {}, recordProviderCacheHit: () => {}, recordSavedCost: () => {},
    },
    budget: { recordTask: (row: { failed: boolean }) => recorded.push({ failed: row.failed }) },
    plugins: { capabilities: (): [] => [] },
  } as unknown as KernelLike;
  const provider: ProviderDef = {
    id: 'mock', label: 'MOCK', defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      yield { type: 'delta', text: answer };
      yield { type: 'done' };
    },
  };
  return { kernel, provider, recorded, cacheWrites: () => cacheWrites };
}

async function run(answer: string, task: TaskContract) {
  const f = fixture(answer);
  const events: import('../loop').AgentEvent[] = [];
  for await (const event of new AgentRunner(f.kernel, bus).run({
    provider: f.provider, model: 'm', messages: [{ role: 'user', content: 'Complete the requested work' }],
    traceId: 'task-completion', maxTurns: 2, task,
  })) events.push(event);
  return { ...f, events };
}

describe('AgentRunner 任务完成验收', () => {
  test('只有预算的任务耗尽时不调用 Provider', async () => {
    const f = fixture('done');
    let calls = 0;
    const events: import('../loop').AgentEvent[] = [];
    const provider: ProviderDef = { ...f.provider, async *chat() { calls++; yield { type: 'done' as const }; } };
    for await (const event of new AgentRunner(f.kernel, bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'finish within budget' }],
      traceId: 'budget-only', task: { objective: 'finish', acceptance: [], costBudgetUsd: 0 },
    })) events.push(event);
    assert.equal(calls, 0);
    assert.ok(events.some((event) => event.type === 'budget_hit'));
    assert.equal(events.some((event) => event.type === 'assistant_done'), false);
  });

  test('只有期限的过期任务停止执行，未过期任务也不能凭空通过验收', async () => {
    const expired = await run('done', { objective: 'finish', acceptance: [], deadlineAt: Date.now() - 1 });
    assert.ok(expired.events.some((event) => event.type === 'error' && event.kind === 'deadline'));
    const unverified = await run('done', { objective: 'finish', acceptance: [], deadlineAt: Date.now() + 60_000 });
    assert.equal(unverified.events.some((event) => event.type === 'task_verified' || event.type === 'assistant_done'), false);
    assert.ok(unverified.events.some((event) => event.type === 'error' && /缺少可检查的验收条件/.test(event.error)));
    assert.equal(unverified.cacheWrites(), 0);
    assert.deepEqual(unverified.recorded, [{ failed: true }]);
  });
  const task: TaskContract = { objective: 'Return the expected marker', acceptance: [{ type: 'output_contains', value: 'verified marker' }] };

  test('验收失败时不发 assistant_done、不缓存答案并记录失败', async () => {
    const result = await run('unsupported claim', task);
    assert.ok(result.events.some((event) => event.type === 'task_failed'));
    assert.ok(result.events.some((event) => event.type === 'error'));
    assert.equal(result.events.some((event) => event.type === 'assistant_done'), false);
    assert.equal(result.cacheWrites(), 0);
    assert.deepEqual(result.recorded, [{ failed: true }]);
  });

  test('验收成功后按 task_verified → assistant_done 顺序完成并缓存', async () => {
    const result = await run('verified marker', task);
    const verified = result.events.find((event) => event.type === 'task_verified') as { evidence?: { traceStepId?: string }[] } | undefined;
    assert.ok(verified);
    assert.ok(verified.evidence?.length);
    assert.ok(verified.evidence?.every((e) => e.traceStepId === 'step'));
    const done = result.events.find((event) => event.type === 'assistant_done') as { content?: string } | undefined;
    assert.match(done?.content ?? '', /【验证证据】/);
    assert.match(done?.content ?? '', /Trace step/);
    assert.equal(result.events.findIndex((event) => event.type === 'task_verified') < result.events.findIndex((event) => event.type === 'assistant_done'), true);
    assert.equal(result.cacheWrites(), 1);
    assert.deepEqual(result.recorded, [{ failed: false }]);
  });

  test('截止时间已过时停止执行并报告 deadline 终态', async () => {
    const result = await run('verified marker', { ...task, deadlineAt: Date.now() - 1 });
    assert.ok(result.events.some((event) => event.type === 'task_failed'));
    assert.ok(result.events.some((event) => event.type === 'error'));
    assert.equal(result.events.some((event) => event.type === 'assistant_done'), false);
    assert.equal(result.cacheWrites(), 0);
    assert.deepEqual(result.recorded, [{ failed: true }]);
  });

  test('部分满足验收条件时发 task_partial，不发 assistant_done', async () => {
    const result = await run('verified marker', { objective: 'Two conditions', acceptance: [
      { type: 'output_contains', value: 'verified marker' },
      { type: 'output_contains', value: 'missing marker' },
    ] });
    assert.ok(result.events.some((event) => event.type === 'task_partial'));
    assert.equal(result.events.some((event) => event.type === 'assistant_done'), false);
    assert.deepEqual(result.recorded, [{ failed: true }]);
  });

  test('长上下文压缩后仍保留任务、验收和长期记忆约束', async () => {
    const f = fixture('verified marker', 1_000);
    const seen: import('../types').LLMMessage[][] = [];
    let calls = 0;
    const provider: ProviderDef = {
      id: 'compact-e2e', label: 'COMPACT-E2E', defaultModel: 'm',
      async *chat(messages) {
        seen.push(messages.map((message) => ({ ...message })));
        calls++;
        if (messages[0]?.role === 'system' && String(messages[0].content).includes('历史摘要器')) {
          yield { type: 'delta', text: `${SUMMARY_MARK}早期任务事实。` };
        } else {
          yield { type: 'delta', text: 'verified marker' };
        }
        yield { type: 'done' };
      },
    };
    const task: TaskContract = {
      objective: '保留任务约束并返回标记',
      acceptance: [{ type: 'output_contains', value: 'verified marker' }],
    };
    const events: import('../loop').AgentEvent[] = [];
    for await (const event of new AgentRunner(f.kernel, bus).run({
      provider, model: 'm', traceId: 'compact-e2e', maxTurns: 2,
      messages: [
        { role: 'system', content: '【任务约束】必须在工作区完成任务。' },
        { role: 'system', content: '【验收条件】最终答案必须包含 verified marker。' },
        { role: 'system', content: '【长期记忆】项目主目录是 maharness。' },
        ...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant' as const, content: `历史消息 ${i}：${'长文本'.repeat(40)}` })),
        { role: 'user', content: '请完成这项长任务，并基于最新约束执行。' },
      ],
      contextMessages: [],
      task,
      compactFn: (history) => compactHistory(history, 100, { provider, model: 'm' }).then((result) => result.messages),
    })) events.push(event);
    assert.ok(calls >= 2, '应包含一次摘要调用和一次真实任务调用');
    const taskRequest = seen.find((messages) => !String(messages[0]?.content ?? '').includes('历史摘要器'));
    assert.ok(taskRequest, '应捕获压缩后的真实任务请求');
    for (const required of ['【任务约束】必须在工作区完成任务。', '【验收条件】最终答案必须包含 verified marker。', '【长期记忆】项目主目录是 maharness。']) {
      assert.ok(taskRequest!.some((message) => message.content === required), `压缩后仍应保留：${required}`);
    }
    assert.ok(events.some((event) => event.type === 'task_verified'));
    assert.ok(events.some((event) => event.type === 'assistant_done'));
  });
});
