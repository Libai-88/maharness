// server/run/recovery.ts 的分支级用例：断点核对（recoverCheckpoint）与分支恢复（resumeChildren）。
// 全部用内存 fake，不启动真实执行链：这里要验证的是"哪种断点允许补结果、哪种必须拒绝"。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunCheckpoint, RunEvent, RunRecord } from '../../kernel/run';
import { RunError } from '../run-types';
import { recoverCheckpoint, resumeChildren, type RecoveryRuntime } from '../run/recovery';

const RUN_ID = 'run-1';
const TENANT = 't1';

function record(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID,
    tenantId: TENANT,
    sessionId: 's1',
    status: 'interrupted',
    objective: 'obj',
    authorization: { workspace: '/w', revision: 3, profile: 'standard', readOnly: false } as RunRecord['authorization'],
    principalRole: 'member',
    maxTurns: 30,
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...patch,
  } as unknown as RunRecord;
}

function checkpoint(patch: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return { history: [], turn: 0, costUsd: 0, toolResults: [], ...patch } as RunCheckpoint;
}

function call(id: string, name = 'write_file') {
  return { id, type: 'function', function: { name, arguments: '{}' } } as unknown as
    | { id: string; type: 'function'; function: { name: string; arguments: string } }
    | never;
}

type Fake = {
  runtime: RecoveryRuntime;
  events: RunEvent[];
  log: string[];
  effects: Map<string, { state: string; result?: unknown }>;
};

function fakeRuntime(): Fake {
  const events: RunEvent[] = [];
  const log: string[] = [];
  const effects = new Map<string, { state: string; result?: unknown }>();
  const runs = {
    transaction: <T>(fn: () => T): T => fn(),
    toolCalls: () => [],
    startTool: (_runId: string, id: string) => log.push(`start:${id}`),
    finishTool: (_runId: string, id: string, result: { ok: boolean }) => log.push(`finish:${id}:${result.ok}`),
    append: (_id: string, type: string, data: Record<string, unknown>) => ({ seq: 1, type, data }) as unknown as RunEvent,
    saveCheckpoint: (_id: string, cp: RunCheckpoint) => log.push(`cp:turn=${cp.turn}:pending=${String(cp.pending)}`),
  };
  const runtime = {
    env: {
      store: { runs, organization: {}, peekToolEffect: (_id: string, key: string) => effects.get(key) },
      prepare: () => ({ maxTurns: 30 }),
    },
    publish: (event: RunEvent) => events.push(event),
    launch: () => undefined,
    execution: () => undefined,
  } as unknown as RecoveryRuntime;
  return { runtime, events, log, effects };
}

describe('recoverCheckpoint', () => {
  test('断点没有未答复调用且不是 pending 时直接返回', () => {
    const { runtime, log } = fakeRuntime();
    recoverCheckpoint(runtime, record(), checkpoint());
    assert.equal(log.length, 0);
  });

  test('pending 但缺少原生工具批次 → 409', () => {
    const { runtime } = fakeRuntime();
    assert.throws(
      () => recoverCheckpoint(runtime, record(), checkpoint({ pending: true })),
      (error: unknown) => error instanceof RunError && error.code === 'CHECKPOINT_INCOMPLETE',
    );
  });

  test('有未答复调用但断点不是 pending → 拒绝', () => {
    const { runtime } = fakeRuntime();
    const cp = checkpoint({ history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'] });
    assert.throws(() => recoverCheckpoint(runtime, record(), cp), /可核对的工具执行边界/);
  });

  test('pendingTool 与缺失调用不一致 → 拒绝', () => {
    const { runtime } = fakeRuntime();
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: { name: 'write_file', toolCallId: 'c2', sideEffect: 'write' } as RunCheckpoint['pendingTool'],
    });
    assert.throws(() => recoverCheckpoint(runtime, record(), cp), /工具执行边界/);
  });

  test('写操作缺 effectKey → 拒绝', () => {
    const { runtime } = fakeRuntime();
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: { name: 'write_file', toolCallId: 'c1', sideEffect: 'write' } as RunCheckpoint['pendingTool'],
    });
    assert.throws(() => recoverCheckpoint(runtime, record(), cp), /副作用执行标识/);
  });

  test('副作用结果未知（pending）→ 不能自动重放', () => {
    const { runtime, effects } = fakeRuntime();
    effects.set('k1', { state: 'pending' });
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: { name: 'write_file', toolCallId: 'c1', sideEffect: 'write', effectKey: 'k1' } as RunCheckpoint['pendingTool'],
    });
    assert.throws(() => recoverCheckpoint(runtime, record(), cp), /不能自动重放/);
  });

  test('副作用已完成但缺结果 → 拒绝', () => {
    const { runtime, effects } = fakeRuntime();
    effects.set('k2', { state: 'done' });
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: {
        name: 'write_file',
        toolCallId: 'c1',
        sideEffect: 'write',
        effectKey: 'k2',
        resultId: 'r1',
      } as RunCheckpoint['pendingTool'],
    });
    assert.throws(() => recoverCheckpoint(runtime, record(), cp), /缺少持久结果/);
  });

  test('副作用已完成且有结果 → 复用持久结果并补一个 tool 消息', () => {
    const { runtime, events, log, effects } = fakeRuntime();
    effects.set('k3', { state: 'done', result: { ok: true, evidence: { path: 'a' } } });
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: {
        name: 'write_file',
        toolCallId: 'c1',
        sideEffect: 'write',
        effectKey: 'k3',
        resultId: 'r1',
      } as RunCheckpoint['pendingTool'],
    });
    recoverCheckpoint(runtime, record(), cp);
    assert.equal(cp.history.filter((message) => message.role === 'tool').length, 1);
    assert.match(log.join(','), /cp:turn=1:pending=false/);
    assert.match(log.join(','), /start:r1/);
    assert.match(log.join(','), /finish:r1:true/);
    assert.equal(events[0]?.type, 'tool_recovered');
  });

  test('委派类调用（sideEffect=none）中断 → 标记 DELEGATION_INTERRUPTED', () => {
    const { runtime, events } = fakeRuntime();
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1', 'run_subagent')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: { name: 'run_subagent', toolCallId: 'c1', sideEffect: 'none' } as RunCheckpoint['pendingTool'],
    });
    recoverCheckpoint(runtime, record(), cp);
    const tool = cp.history.find((message) => message.role === 'tool');
    const payload = JSON.parse(String(tool?.content)) as { failure: { code: string; outcome: string } };
    assert.equal(payload.failure.code, 'DELEGATION_INTERRUPTED');
    assert.equal(payload.failure.outcome, 'applied');
    assert.equal(events.length, 1);
  });

  test('普通读调用中断 → 标记 TOOL_INTERRUPTED 且可重试', () => {
    const { runtime } = fakeRuntime();
    const cp = checkpoint({
      history: [{ role: 'assistant', content: '', tool_calls: [call('c1', 'read_file')] }] as RunCheckpoint['history'],
      pending: true,
      pendingTool: { name: 'read_file', toolCallId: 'c1', sideEffect: 'read' } as RunCheckpoint['pendingTool'],
    });
    recoverCheckpoint(runtime, record(), cp);
    const payload = JSON.parse(String(cp.history.find((message) => message.role === 'tool')?.content)) as {
      failure: { code: string; retryable: boolean; outcome: string };
    };
    assert.equal(payload.failure.code, 'TOOL_INTERRUPTED');
    assert.equal(payload.failure.retryable, true);
    assert.equal(payload.failure.outcome, 'not_started');
  });
});

type ChildFixture = {
  child?: Record<string, unknown>;
  contractStatus?: string | undefined;
  role?: Record<string, unknown> | undefined;
  cp?: RunCheckpoint | undefined;
  released?: string[];
  launched?: string[];
  updated?: string[];
};

function childRuntime(f: ChildFixture = {}) {
  const released: string[] = [];
  const launched: string[] = [];
  const updated: string[] = [];
  const events: RunEvent[] = [];
  const child = {
    id: 'child-1',
    tenantId: TENANT,
    status: 'interrupted',
    assignmentContractId: 'c-1',
    authorization: { workspace: '/w', revision: 1, profile: 'standard', readOnly: false },
    organizationRoleId: 'role-1',
    principalRole: 'member',
    maxTurns: 30,
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...(f.child ?? {}),
  };
  const runs = {
    children: () => [child],
    checkpoint: () => (f.cp === undefined ? checkpoint({ turn: 0 }) : f.cp),
    transaction: <T>(fn: () => T): T => fn(),
    reserveChild: () => undefined,
    reserveChildTokens: () => undefined,
    update: (_child: unknown, patch: Record<string, unknown>) => {
      updated.push(String(patch.status ?? ''));
      return { ...child, ...patch } as unknown as RunRecord;
    },
    releaseChild: (id: string) => {
      released.push(id);
    },
    append: () => ({ seq: 1 }) as unknown as RunEvent,
    startTool: () => undefined,
    finishTool: () => undefined,
    toolCalls: () => [],
    saveCheckpoint: () => undefined,
    peekToolEffect: () => undefined,
  };
  const organization = {
    getContract: () => (f.contractStatus === undefined ? { status: 'active' } : { status: f.contractStatus }),
    getRole: () => f.role,
    finalizeRun: () => undefined,
  };
  const runtime = {
    env: { store: { runs, organization }, prepare: () => ({ maxTurns: 30 }) },
    publish: (event: RunEvent) => events.push(event),
    launch: (rec: RunRecord) => launched.push(rec.id),
    execution: () => ({ abort: new AbortController(), promise: Promise.resolve() }),
  } as unknown as RecoveryRuntime;
  return { runtime, released, launched, updated, events, child };
}

const activeRole = { employment: 'active', authority: { workspace: '/w', profile: 'standard', readOnly: false, allowedTools: [] } };

describe('resumeChildren', () => {
  test('子任务契约失效时保持中断', async () => {
    const { runtime, launched, updated } = childRuntime({ contractStatus: 'revoked', role: activeRole });
    await resumeChildren(runtime, record(), new AbortController().signal);
    assert.equal(launched.length, 0);
    assert.equal(updated.length, 0);
  });

  test('角色停用 → 记录原因并 finalize，不拉起', async () => {
    const { runtime, launched, updated } = childRuntime({ role: { ...activeRole, employment: 'retired' } });
    await resumeChildren(runtime, record(), new AbortController().signal);
    assert.equal(launched.length, 0);
    assert.deepEqual(updated, ['interrupted']);
  });

  test('分支工作区与父任务不一致 → 不拉起', async () => {
    const { runtime, launched, updated } = childRuntime({
      role: activeRole,
      child: { authorization: { workspace: '/other', revision: 1 } },
    });
    await resumeChildren(runtime, record(), new AbortController().signal);
    assert.equal(launched.length, 0);
    assert.deepEqual(updated, ['interrupted']);
  });

  test('轮数已耗尽 → 不拉起', async () => {
    const { runtime, launched, updated } = childRuntime({ role: activeRole, cp: checkpoint({ turn: 30 }) });
    await resumeChildren(runtime, record(), new AbortController().signal);
    assert.equal(launched.length, 0);
    assert.deepEqual(updated, ['interrupted']);
  });

  test('条件齐备 → 重新排队、拉起并释放预算', async () => {
    const { runtime, launched, updated, released } = childRuntime({ role: activeRole });
    await resumeChildren(runtime, record(), new AbortController().signal);
    assert.deepEqual(updated, ['queued']);
    assert.deepEqual(launched, ['child-1']);
    assert.deepEqual(released, ['child-1']);
  });

  test('信号已 abort → 不再排队的子任务直接跳过', async () => {
    const { runtime, launched } = childRuntime({ role: activeRole });
    const controller = new AbortController();
    controller.abort('parent_cancelled');
    await resumeChildren(runtime, record(), controller.signal);
    assert.equal(launched.length, 0);
  });
});
