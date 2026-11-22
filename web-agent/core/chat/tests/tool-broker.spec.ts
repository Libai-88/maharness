import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolBroker, forwardToolEvents } from '../tool-broker';
import { ToolExecutor } from '../tool-executor';
import { assessToolApproval } from '../agent';
import { ApprovalBoard } from '../approvals';
import { ExecutionPool } from '../../../kernel/execution-pool';
import type { AgentEvent, AgentHookCtx, RunOptions } from '../../../kernel/loop';
import type { ToolContext, ToolDef, ToolResult } from '../../../kernel/types';

function fixture() {
  const board = new ApprovalBoard(5000),
    pool = new ExecutionPool(1),
    events: AgentEvent[] = [];
  const effects = new Map<string, { state: 'done' | 'pending'; result?: ToolResult }>();
  let count = 0;
  const leaf: ToolDef = {
    name: 'write_leaf',
    version: '2.0.0',
    description: 'write',
    permissions: ['workspace.write'],
    sideEffect: 'write',
    approval: true,
    parameters: { type: 'object' },
    outputSchema: { type: 'object' },
    async handler(_args, ctx) {
      assert.equal(ctx.approved, true);
      return { ok: true, data: { value: ++count } };
    },
  };
  const outer: ToolDef = {
    ...leaf,
    name: 'composite',
    approval: false,
    invokesTools: true,
    async handler(_args, ctx) {
      return ctx.invoke!('write_leaf', {});
    },
  };
  const context = { turn: 0, sandboxRoot: 'broker-fixture', principal: { role: 'admin' } } as ToolContext;
  const options: RunOptions = {
    runId: 'broker',
    acquireExecution: (signal) => pool.acquire('broker', signal),
    effectJournal: {
      claim: (key) => {
        const prior = effects.get(key);
        if (prior) return prior;
        effects.set(key, { state: 'pending' });
        return { state: 'new' };
      },
      complete: (key, result) => {
        effects.set(key, { state: 'done', result });
      },
    },
  } as RunOptions;
  const broker = (
    emit = (event: AgentEvent) => {
      events.push(event);
    },
    caller = outer,
  ) =>
    createToolBroker({
      tools: [leaf, outer],
      caller,
      context,
      options,
      key: 'same-checkpoint',
      board,
      timeoutMs: 1000,
      assess: assessToolApproval,
      redact: (value) => value,
      emit,
      before: async (tool, args) => ({ tool: { name: tool.name, args } }) as AgentHookCtx,
      after: async (_tool, _args, result) => result,
    });
  return { board, events, effects, leaf, outer, context, options, broker, count: () => count };
}

test('composite calls stream nested approval and use a single physical execution slot', async () => {
  const f = fixture();
  const run = forwardToolEvents((emit) => {
    f.context.invoke = f.broker(emit);
    return new ToolExecutor({
      tool: f.outer,
      args: {},
      context: f.context,
      runId: 'broker',
      acquireExecution: f.options.acquireExecution,
      effectStarted: false,
      timeoutMs: 1000,
      policyApproved: false,
    }).invoke(false);
  });
  for (;;) {
    const event = await run.next();
    if (event.done) {
      assert.equal(event.value.ok, true);
      break;
    }
    if (event.value.type === 'approval_required') {
      assert.equal(f.count(), 0);
      f.board.approve(event.value.approvalId, true);
    }
  }
  assert.equal(f.count(), 1);
  const replay = await f.broker((event) => {
    if (event.type === 'approval_required') f.board.approve(event.approvalId, true);
  })('write_leaf', {});
  assert.equal(replay.ok, true);
  assert.equal(f.count(), 1);
  f.board.dispose();
});

test('nested calls cannot inherit outer approval or expand permissions', async () => {
  const f = fixture();
  f.context.approved = true;
  const denied = await f.broker(undefined, { ...f.outer, permissions: [] })('write_leaf', {});
  assert.equal(denied.failure?.code, 'TOOL_PERMISSION');
  const rejected = await f.broker((event) => {
    if (event.type === 'approval_required') f.board.approve(event.approvalId, false);
  })('write_leaf', {});
  assert.equal(rejected.ok, false);
  assert.equal(f.count(), 0);
  f.board.dispose();
});

test('composite handlers are never automatically retried after nested effects', async () => {
  const f = fixture();
  let attempts = 0;
  const tool: ToolDef = {
    ...f.outer,
    sideEffect: 'read',
    idempotent: true,
    retry: { maxAttempts: 3, backoffMs: 1 },
    async handler() {
      attempts++;
      await f.broker((event) => {
        if (event.type === 'approval_required') f.board.approve(event.approvalId, true);
      })('write_leaf', {});
      throw new Error('ECONNRESET');
    },
  };
  try {
    const result = await new ToolExecutor({
      tool,
      args: {},
      context: f.context,
      timeoutMs: 1000,
      effectStarted: false,
      policyApproved: false,
    }).invoke(false);
    assert.equal(result.ok, false);
    assert.equal(result.failure?.retryable, false);
    assert.equal(result.failure?.outcome, 'unknown');
    assert.equal(attempts, 1);
    assert.equal(f.count(), 1);
  } finally {
    f.board.dispose();
  }
});

test('cancellation withdraws nested approval and pending effects never replay', async () => {
  const f = fixture();
  const abort = new AbortController();
  f.context.signal = abort.signal;
  const stopped = await f.broker((event) => {
    if (event.type === 'approval_required') abort.abort();
  })('write_leaf', {});
  assert.equal(stopped.ok, false);
  assert.equal(f.board.size, 0);
  assert.equal(f.count(), 0);
  f.context.signal = undefined;
  f.leaf.approval = false;
  // Simulate a crash after a write was claimed but before its result was durable.
  const broker = f.broker();
  const key = 'same-checkpoint:nested:0:write_leaf:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  f.effects.set(key, { state: 'pending' });
  const result = await broker('write_leaf', {});
  assert.equal(result.failure?.code, 'EFFECT_OUTCOME_UNKNOWN');
  assert.equal(f.count(), 0);
  f.board.dispose();
});
