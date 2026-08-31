/**
 * kernel/tests/approvals.spec.ts —— 审批共享注册表与执行器取消语义回归测试
 * 覆盖：
 *  - ApprovalBoard：register/approve/未知 ID/超时自动拒绝/dispose；
 *  - 子 runner 审批经共享 board 被"主 runner 入口"（approveApproval）可达——
 *    修复前子代理审批注册在私有 Map，服务端入口只能查到主 runner；
 *  - 工具超时取消：withToolTimeout 超时触发 AbortController，支持 signal 的
 *    handler 真正中断（fs 类不响应 signal 的工具行为不变）；
 *  - parallel 共享预算均分：总消耗 ≤ 剩余预算（不再每任务拷贝同一份）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBoard } from '../../core/chat/approvals';
import { AgentRunner } from '../../core/chat/agent';
import { splitBudget } from '../../core/parallel';
import type {
  EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, ToolDef, ToolResult, TraceStepInit,
} from '../types';

// ---------- 轻量 stub（AgentRunner 只消费 kernel 的最小面） ----------

function kernelStub(rootDir: string, toolTimeoutMs: number): KernelLike {
  const cfg = new Map<string, unknown>([
    ['agent.toolTimeoutMs', toolTimeoutMs],
    ['agent.reasoningBudget', 640],
    ['agent.reasoningTotalBudget', 2000],
    ['agent.maxTurns', 6],
    ['agent.thinkInEnglish', true],
    ['sandboxRoot', rootDir],
  ]);
  const trace = {
    startStep: (_init: TraceStepInit): StepHandle => ({ id: 's', finish: () => {}, fail: () => {}, cancel: () => {} }),
  };
  return {
    rootDir,
    paths: { root: rootDir, data: rootDir, traces: rootDir, configFile: '', dbFile: '', cacheFile: '' },
    config: {
      get: <T>(key: string, def?: T): T => (cfg.has(key) ? cfg.get(key) as unknown as T : def as unknown as T),
    } as unknown as KernelLike['config'],
    trace: trace as unknown as KernelLike['trace'],
    cache: {
      l1Enabled: false,
      recordPrefixRepeat: () => {},
      recordProviderCacheHit: () => {},
      recordSavedCost: () => {},
    } as unknown as KernelLike['cache'],
    budget: { recordTask: () => {} } as unknown as KernelLike['budget'],
    plugins: { capabilities: (): [] => [] } as unknown as KernelLike['plugins'],
  };
}

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

/** 按调用序号响应的 mock provider：第 1 次调用产出工具调用，此后产出完成 */
function scriptedProvider(script: ((i: number) => AsyncIterable<LLMChunk>)[], calls: { n: number }): ProviderDef {
  return {
    id: 'mock', label: 'MOCK', defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      const i = calls.n++;
      const gen = script[Math.min(i, script.length - 1)](i);
      for await (const c of gen) yield c;
    },
  };
}

const doneStream = async function* (): AsyncIterable<LLMChunk> {
  yield { type: 'delta', text: 'ok' };
  yield { type: 'usage', input: 5, output: 5 };
  yield { type: 'done' };
};

// ---------- ApprovalBoard ----------

describe('ApprovalBoard 共享注册表', () => {
  test('register → approve 可达并解除挂起；未知 ID 返回 false', () => {
    const board = new ApprovalBoard(1000);
    let resolved: boolean | null = null;
    board.register('a1', { name: 't', summary: 's' }, (v) => { resolved = v; });
    assert.equal(board.size, 1);
    assert.equal(board.has('a1'), true);
    assert.equal(board.approve('missing', true), false);
    assert.equal(board.approve('a1', true), true);
    assert.equal(resolved, true);
    assert.equal(board.size, 0);
  });

  test('超时自动拒绝（resolve(false)）并清理条目', async () => {
    const board = new ApprovalBoard(30);
    let resolved: boolean | null = null;
    board.register('a2', { name: 't', summary: 's' }, (v) => { resolved = v; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(resolved, false);
    assert.equal(board.size, 0);
  });

  test('dispose 拒绝全部挂起审批', () => {
    const board = new ApprovalBoard(10000);
    const got: boolean[] = [];
    board.register('a3', { name: 't', summary: 's' }, (v) => got.push(v));
    board.register('a4', { name: 't', summary: 's' }, (v) => got.push(v));
    board.dispose();
    assert.deepEqual(got, [false, false]);
    assert.equal(board.size, 0);
  });
});

// ---------- AgentRunner 审批可达性 ----------

describe('AgentRunner 审批（共享 board）', () => {
  test('未批准前 handler 被执行器拦截；审批超时自动拒绝后任务继续', async () => {
    let handledWithApproval: boolean | null = null;
    const tool: ToolDef = {
      name: 'need_ok',
      description: '需审批工具',
      parameters: { type: 'object', properties: {} },
      approval: true,
      async handler(_args, tctx) {
        handledWithApproval = tctx.approved ?? false;
        return { ok: true, data: { ok: true } };
      },
    };
    const calls = { n: 0 };
    const provider = scriptedProvider([
      async function* (): AsyncIterable<LLMChunk> {
        yield { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'need_ok', arguments: '{}' } } };
      },
      doneStream,
    ], calls);

    const kernel = kernelStub(process.cwd(), 5000);
    // 独立短超时 board：无人批准时自动拒绝（默认 10 分钟会挂死测试）
    const child = new AgentRunner(kernel, bus, new ApprovalBoard(60));

    const events: string[] = [];
    // 审批等待期 board 定时器 unref 不保持事件循环（产品语义），测试需保活
    const keepAlive = setInterval(() => {}, 1000);
    try {
      for await (const ev of child.run({
        provider, model: 'm',
        messages: [{ role: 'user', content: '帮我做件事' }],
        tools: [tool], traceId: 't1', sessionId: 's1', maxTurns: 3,
      })) {
        events.push(ev.type);
      }
    } finally {
      clearInterval(keepAlive);
    }

    assert.ok(events.includes('approval_required'), '应产出 approval_required');
    assert.ok(events.includes('tool_result'), '审批拒绝应回填 governed 错误结果');
    assert.ok(events.includes('assistant_done'), '审批拒绝不阻断整轮对话');
    assert.equal(handledWithApproval, null, '未批准前 handler 不应执行（执行器侧拦截）');
  });

  test('子 runner 审批经主 runner 入口批准后继续执行（修复前：主入口 404、子 runner 只能等超时）', async () => {
    let handledWithApproval: boolean | null = null;
    let approvalId: string | null = null;
    const tool: ToolDef = {
      name: 'need_ok2',
      description: '需审批工具',
      parameters: { type: 'object', properties: {} },
      approval: true,
      async handler(_args, tctx) {
        handledWithApproval = tctx.approved ?? false;
        return { ok: true, data: { ok: true } };
      },
    };
    const calls = { n: 0 };
    const provider = scriptedProvider([
      async function* (): AsyncIterable<LLMChunk> {
        yield { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'need_ok2', arguments: '{}' } } };
      },
      doneStream,
    ], calls);

    const kernel = kernelStub(process.cwd(), 5000);
    // 子/主 runner 共享同一独立 board（模拟进程级共享注册表）
    const board = new ApprovalBoard(5000);
    const child = new AgentRunner(kernel, bus, board);
    const main = new AgentRunner(kernel, bus, board);

    // 审批等待期 board 定时器 unref 不保持事件循环（产品语义），测试需保活
    const keepAlive = setInterval(() => {}, 1000);
    const consume = async () => {
      for await (const ev of child.run({
        provider, model: 'm',
        messages: [{ role: 'user', content: '帮我做件事' }],
        tools: [tool], traceId: 't2', sessionId: 's2', maxTurns: 3,
      })) {
        if (ev.type === 'approval_required') approvalId = ev.approvalId;
      }
    };
    try {
      const running = consume();

      // 等审批出现（最长 2s），经"主 runner"入口批准——共享 board 使子 runner 审批可达
      const deadline = Date.now() + 2000;
      while (!approvalId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.notEqual(approvalId, null, '应出现审批请求');
      const ok = main.approveApproval(approvalId!, true);
      assert.equal(ok, true, '主 runner 入口应能批准子 runner 的审批');
      await running;

      assert.equal(handledWithApproval, true, '批准后 handler 应以 approved=true 执行');
    } finally {
      clearInterval(keepAlive);
    }
  });
});

// ---------- 工具超时取消（B4）：signal 传导 ----------

describe('AgentRunner 工具超时取消', () => {
  test('超时触发 AbortController：等待 signal 的 handler 真正中断', async () => {
    let sawAbort = false;
    const tool: ToolDef = {
      name: 'slow_tool',
      description: '挂起工具',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 80,
      async handler(_args, tctx): Promise<ToolResult> {
        await new Promise<never>((_res, rej) => {
          tctx.signal?.addEventListener('abort', () => { sawAbort = true; rej(new Error('handler-cancelled')); });
          if (tctx.signal?.aborted) { sawAbort = true; rej(new Error('handler-cancelled')); }
        });
        throw new Error('unreachable'); // Promise<never> 永不 resolve
      },
    };
    const calls = { n: 0 };
    const provider = scriptedProvider([
      async function* (): AsyncIterable<LLMChunk> {
        yield { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'slow_tool', arguments: '{}' } } };
      },
      doneStream,
    ], calls);

    const kernel = kernelStub(process.cwd(), 300); // 工具自身 80ms，覆盖超时
    const runner = new AgentRunner(kernel, bus);
    const evs: string[] = [];
    for await (const ev of runner.run({
      provider, model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool], traceId: 't3', maxTurns: 3,
    })) evs.push(ev.type);

    assert.equal(sawAbort, true, '超时应向 handler 传导取消信号');
    assert.ok(evs.includes('tool_result'), '超时结果应回填为工具失败');
    assert.ok(evs.includes('assistant_done'), '超时不阻断整轮对话');
  });

  test('慢速 handler 超时后迟到 rejection 不产生 unhandledRejection', async () => {
    // 场景：withToolTimeout 已抛超时，handler 迟到 reject——应被预标记 catch 消费
    let unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const tool: ToolDef = {
        name: 'late_reject',
        description: '超时后迟到拒绝',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 40,
        async handler() {
          await new Promise((r) => setTimeout(r, 60));
          throw new Error('late-failure');
        },
      };
      const calls = { n: 0 };
      const provider = scriptedProvider([
        async function* (): AsyncIterable<LLMChunk> {
          yield { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'late_reject', arguments: '{}' } } };
        },
        doneStream,
      ], calls);
      const kernel = kernelStub(process.cwd(), 300);
      const runner = new AgentRunner(kernel, bus);
      for await (const _ev of runner.run({
        provider, model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool], traceId: 't4', maxTurns: 3,
      })) { /* 消费完 */ }
      await new Promise((r) => setTimeout(r, 80)); // 让迟到的 rejection 有机会触发
      assert.equal(unhandled.length, 0, '迟到 rejection 不应成为 unhandledRejection');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

// ---------- parallel 预算均分 ----------

describe('parallel splitBudget 均分', () => {
  test('floor 分配、余数归最后一项，总和 = 剩余预算', () => {
    const shares = splitBudget(10, 3);
    assert.deepEqual(shares, [3, 3, 4]);
    assert.equal(shares.reduce((s: number, x) => s + (x ?? 0), 0), 10);
  });

  test('每份都不超过剩余预算（不再每任务拷贝同一份）', () => {
    const shares = splitBudget(0.05, 4);
    for (const s of shares) {
      assert.ok((s ?? 0) <= 0.05);
    }
    assert.equal(shares.reduce((sum: number, s) => sum + (s ?? 0), 0), 0.05);
  });

  test('无预算（undefined）时全部无上限（维持现状语义）', () => {
    assert.deepEqual(splitBudget(undefined, 3), [undefined, undefined, undefined]);
  });
});