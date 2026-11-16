import { callModel } from '../../kernel/model-call';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Store } from '../db';
import { RunService, RunError } from '../run-service';
import type { AgentLoop, RunOptions } from '../../kernel/loop';
import type { ProviderDef } from '../../kernel/types';
import { registerRunRoutes } from '../routes/runs';
import type { RouteDeps } from '../routes/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../../kernel';
import { AgentRunner } from '../../core/chat/agent';
import type { KernelLike, ToolDef } from '../../kernel/types';

const provider: ProviderDef = { id: 'test', label: 'Test', defaultModel: 'test', async *chat() {} };
const done = { type: 'assistant_done' as const, content: 'complete', reasoning: '', usage: { input: 10, output: 2 }, cost: 0.02 };
function setup(runner: AgentLoop) {
  const store = new Store(':memory:');
  const session = store.createSession('test', 'test');
  const environment = { store, runner: () => runner, workspace: () => process.cwd(), provider: () => ({ id: 'test', model: 'test' }), prepare: () => ({ provider, model: 'test', messages: [], traceId: '' }) };
  const service = new RunService(environment);
  return { store, session, service, environment };
}
function terminal(service: RunService, id: string): Promise<void> {
  return new Promise(resolve => {
    const unsubscribe = service.subscribe(id, event => {
      if (event.type === 'state' && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(event.data.status))) { unsubscribe(); resolve(); }
    });
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('delegation call cancellation stops only its child while the parent remains usable', async () => {
  const ready=deferred(),holdParent=deferred();let options:RunOptions|undefined;
  const {service,store,session}=setup({approveApproval:()=>false,async *run(opts){
    if(!opts.parentRunId){options=opts;ready.resolve();await holdParent.promise;yield done;}
    else {await new Promise<void>(resolve=>{if(opts.signal?.aborted)resolve();else opts.signal?.addEventListener('abort',()=>resolve(),{once:true})});}
  }});
  try {
    const parent=service.create(session,{message:'parent'});await ready.promise;
    const ac=new AbortController();const child=options!.delegate!({objective:'child'},ac.signal);
    ac.abort('call_deadline');const result=await child;
    assert.equal(result.cancelled,true);assert.equal(service.get(parent.id,'default').status,'running');
    holdParent.resolve();await service.shutdown();
    assert.equal(store.runs.children(parent.id,'default').length,1);
  }finally{holdParent.resolve();await service.shutdown();store.close();}
});

test('enabled tool schemas survive database reopen and a queued supplement at recovery', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mh-enabled-recovery-'));
  const database = join(workspace, 'runs.db');
  const kernel = new Kernel(workspace);
  let store = new Store(database); let calls = 0; let writes = 0; const maxTurns = 5;
  const custom: ToolDef = { name: 'custom_export', description: 'Export a result', version: '2.0.0', permissions: ['workspace.write'], sideEffect: 'write', parameters: { type: 'object' }, outputSchema: { type: 'object' }, async handler() { writes++; return { ok: true, data: {} }; } };
  const source: ProviderDef = { id: 'mock', label: 'mock', defaultModel: 'mock', prices: { in: 0, out: 0 }, async *chat(_history, options) {
    calls++;
    if (calls === 1) yield { type: 'tool_call', toolCall: { id: 'enable-1', type: 'function', function: { name: 'enable_tools', arguments: '{"names":["custom_export"]}' } } };
    else if (calls === 2) throw new Error('fixture connection interruption');
    else if (calls === 3) {
      assert.equal(options.tools?.some(tool => tool.name === 'custom_export'), true);
      yield { type: 'tool_call', toolCall: { id: 'export-1', type: 'function', function: { name: 'custom_export', arguments: '{}' } } };
    } else yield { type: 'delta', text: 'exported' };
    yield { type: 'usage', input: 10, output: 5 }; yield { type: 'done' };
  } };
  const environment = () => ({ store, tools: () => [custom], runner: () => new AgentRunner(kernel as unknown as KernelLike, kernel.bus), workspace: () => workspace, provider: () => ({ id: 'mock', model: 'mock' }), prepare: () => ({ provider: source, model: 'mock', messages: [], traceId: '', tools: [custom, { ...custom, name: 'large_schema', description: 'x'.repeat(22000) }], maxTurns, systemPrompt: 'Use native tools.' }) });
  let service = new RunService(environment());
  try {
    const session = store.createSession('mock', 'mock');
    const run = service.create(session, { message: 'Export a result.' }); await terminal(service, run.id);
    assert.equal(service.get(run.id, 'default').status, 'interrupted');
    assert.ok(store.runs.checkpoint(run.id)?.enabledTools?.includes('custom_export'));
    await service.shutdown(); store.close(); store = new Store(database);
    service = new RunService(environment());
    const finished = terminal(service, run.id); service.resume(run.id, 'default');
    service.supplement(run.id, 'default', 'Preserve the export format.');
    await finished;
    assert.equal(service.get(run.id, 'default').status, 'completed');
    assert.equal(writes, 1); assert.equal(calls, 4);
    assert.ok(store.runs.checkpoint(run.id)?.enabledTools?.includes('custom_export'));
  } finally { await service.shutdown(); store.close(); await kernel.stop(); }
});

test('run outlives its subscribers; idempotency and event cursor do not execute twice', async () => {
  const gate = deferred();
  let calls = 0;
  const { service, store, session } = setup({ approveApproval: () => false, async *run() { calls++; yield { type: 'delta', text: 'a' }; await gate.promise; yield done; } });
  try {
    const run = service.create(session, { message: 'work', requestKey: 'request-1' });
    const finished = terminal(service, run.id);
    const unsubscribe = service.subscribe(run.id, () => {});
    unsubscribe();
    assert.equal(service.create(session, { message: 'work', requestKey: 'request-1' }).id, run.id);
    assert.throws(() => service.create(session, { message: 'different', requestKey: 'request-1' }), (error: unknown) => error instanceof RunError && error.code === 'IDEMPOTENCY_CONFLICT');
    gate.resolve();
    await finished;
    assert.equal(calls, 1);
    assert.equal(service.get(run.id, 'default').status, 'completed');
    const events = store.runs.events(run.id);
    assert.deepEqual(events.map(event => event.seq), events.map((_, i) => i + 1));
    assert.deepEqual(store.runs.events(run.id, events[1].seq), events.slice(2));
    assert.equal(store.listMessages(session.id).filter(message => message.role === 'assistant').length, 1);
  } finally { await service.shutdown(); store.close(); }
});

test('same-session exclusion and tenant isolation are enforced without subscribers', async () => {
  const gate = deferred();
  const { service, store, session } = setup({ approveApproval: () => false, async *run() { await gate.promise; yield done; } });
  try {
    const run = service.create(session, { message: 'work' });
    const finished = terminal(service, run.id);
    assert.throws(() => service.create(session, { message: 'other' }), (error: unknown) => error instanceof RunError && error.status === 409);
    assert.throws(() => service.get(run.id, 'another-tenant'), (error: unknown) => error instanceof RunError && error.status === 404);
    gate.resolve(); await finished;
  } finally { gate.resolve(); await service.shutdown(); store.close(); }
});

test('supplement is durable and delivered only at model boundary', async () => {
  const entered = deferred(); const proceed = deferred();
  let delivered: string[] = [];
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    entered.resolve(); await proceed.promise;
    delivered = (opts.takeMessages?.(opts.messages, 0) ?? []).map(message => String(message.content));
    assert.deepEqual(opts.takeMessages?.(opts.messages, 0), []);
    yield done;
  } });
  try {
    const run = service.create(session, { message: 'work' }); const finished = terminal(service, run.id);
    await entered.promise;
    const messageId = service.supplement(run.id, 'default', 'additional constraint', 'supplement-1');
    assert.equal(service.supplement(run.id, 'default', 'additional constraint', 'supplement-1'), messageId);
    assert.throws(() => service.supplement(run.id, 'default', 'different', 'supplement-1'), (error: unknown) => error instanceof RunError && error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(store.runs.events(run.id).filter(event => event.type === 'message_queued').length, 1);
    assert.deepEqual(delivered, []);
    proceed.resolve(); await finished;
    assert.deepEqual(delivered, ['additional constraint']);
    assert.equal(store.runs.checkpoint(run.id)?.history.at(-1)?.content, 'additional constraint');
  } finally { proceed.resolve(); await service.shutdown(); store.close(); }
});

test('creating a run rolls back dialogue and state when checkpoint cannot commit', async () => {
  const { service, store, session } = setup({ approveApproval: () => false, async *run() { yield done; } });
  const original = store.runs.saveCheckpoint;
  try {
    store.runs.saveCheckpoint = () => { throw new Error('disk failure'); };
    assert.throws(() => service.create(session, { message: 'work' }), /disk failure/);
    assert.deepEqual(store.runs.list('default'), []);
    assert.deepEqual(store.listMessages(session.id), []);
  } finally { store.runs.saveCheckpoint = original; await service.shutdown(); store.close(); }
});

test('recovery accounts for spend after the last checkpoint without double counting dialogue', async () => {
  let calls = 0;
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    calls++;
    if (calls === 1) {
      opts.onUsage?.({ input: 12, output: 3, cost: 0.03 });
      yield { type: 'error', error: 'turn limit', kind: 'max-turns' };
    } else {
      assert.equal(opts.restoredCostUsd, 0.03);
      assert.equal(opts.costBudget, 0.07);
      yield done;
    }
  } });
  try {
    const run = service.create(session, { message: 'work', budgetPolicy: 'enforce', budgetUsd: 0.1 });
    await terminal(service, run.id);
    assert.equal(service.get(run.id, 'default').status, 'interrupted');
    assert.equal(store.aggregateSessions()[0].cost, 0.03);
    const completed = terminal(service, run.id); service.resume(run.id, 'default'); await completed;
    const result = service.get(run.id, 'default');
    assert.equal(result.cost, 0.05);
    assert.equal(result.tokensIn, 22);
    assert.equal(result.tokensOut, 5);
    assert.equal(store.aggregateSessions()[0].cost, 0.05);
  } finally { await service.shutdown(); store.close(); }
});

test('tool results persist with bounded pages and cannot cross run or tenant boundaries', async () => {
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    opts.toolJournal!.start('call-1', 'read_file', 'file.txt');
    opts.toolJournal!.finish('call-1', { ok: true, data: { text: 'x'.repeat(20000) } });
    opts.toolJournal!.start('call-2', 'command_start', 'command');
    opts.toolJournal!.finish('call-2', { ok: false, error: 'Unknown effect', failure: { code: 'TOOL_INTERRUPTED', retryable: false, outcome: 'unknown' } });
    const page = opts.toolJournal!.read('call-1', 10, 3000)!;
    assert.equal(page.content.length, 3000);
    assert.equal(page.nextOffset, 3010);
    assert.equal(page.truncated, true);
    yield done;
  } });
  try {
    const run = service.create(session, { message: 'work' }); await terminal(service, run.id);
    assert.ok(store.runs.readTool(run.id, 'call-1'));
    assert.equal(store.runs.readTool('other-run', 'call-1'), undefined);
    const tools = store.runs.toolCalls(run.id);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].failure, undefined);
    assert.equal(tools[1].status, 'unknown');
    assert.deepEqual(tools[1].failure, { code: 'TOOL_INTERRUPTED', retryable: false, outcome: 'unknown' });
    assert.throws(() => service.get(run.id, 'other-tenant'));
  } finally { await service.shutdown(); store.close(); }
});

test('children inherit provider, permissions, and cancellation and settle the shared budget', async () => {
  let childRuns = 0;
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    if (opts.parentRunId) {
      childRuns++;
      assert.equal(opts.provider.id, 'test'); assert.equal(opts.model, 'test');
      assert.equal(opts.authorization?.profile, 'standard');
      assert.equal(opts.authorization?.readOnly, true);
      opts.onUsage?.({ input: 10, output: 2, cost: 0.02 });
      yield done;
    } else {
      const child = await opts.delegate!({ objective: 'inspect', tools: 'read', budgetUsd: 0.06 });
      assert.equal(child.cost, 0.02);
      assert.equal(store.runs.get(opts.runId!, 'default')!.cost, 0.02);
      assert.equal(opts.availableBudget!(), 0.08);
      yield done;
    }
  } });
  try {
    const run = service.create(session, { message: 'work', budgetPolicy: 'enforce', budgetUsd: 0.1 }); await terminal(service, run.id);
    assert.equal(childRuns, 1);
    assert.equal(service.get(run.id, 'default').cost, 0.04);
    assert.equal(store.aggregateSessions()[0].cost, 0.04);
    assert.equal(store.runs.children(run.id, 'default')[0].status, 'completed');
    assert.equal(store.listMessages(session.id).filter(message => message.role === 'assistant').length, 1);
  } finally { await service.shutdown(); store.close(); }
});

test('parallel reservations cannot spend the same parent budget twice', async () => {
  const entered = deferred(); const release = deferred();
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    if (opts.parentRunId) { entered.resolve(); await release.promise; yield done; }
    else {
      const first = opts.delegate!({ objective: 'first', budgetUsd: 0.06 });
      await entered.promise;
      await assert.rejects(opts.delegate!({ objective: 'second', budgetUsd: 0.06 }), /预算/);
      release.resolve(); await first; yield done;
    }
  } });
  try { const run = service.create(session, { message: 'work', budgetPolicy: 'enforce', budgetUsd: 0.1 }); await terminal(service, run.id); assert.equal(store.runs.children(run.id, 'default').length, 1); }
  finally { release.resolve(); await service.shutdown(); store.close(); }
});

test('nested delegation, failed child and recovery account each execution exactly once', async () => {
  let roots = 0;
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    const objective = String(opts.messages.at(-1)?.content);
    if (!opts.parentRunId) {
      if (++roots === 1) {
        await opts.delegate!({ objective: 'child' });
        opts.onUsage?.({ input: 5, output: 1, cost: 0.01 });
        yield { type: 'error', error: 'limit', kind: 'max-turns' };
      } else yield done;
    } else if (objective === 'child') {
      await opts.delegate!({ objective: 'grandchild' });
      opts.onUsage?.({ input: 5, output: 1, cost: 0.01 });
      yield { type: 'error', error: 'child failed', kind: 'upstream' };
    } else {
      opts.onUsageStatus?.('estimated');
      opts.onUsage?.({ input: 10, output: 2, cost: 0.02 });
      yield done;
    }
  } });
  try {
    const root = service.create(session, { message: 'root', budgetUsd: 1 });
    await terminal(service, root.id);
    assert.equal(service.get(root.id, 'default').cost, 0.04);
    assert.equal(service.get(root.id, 'default').usageStatus, 'estimated');
    const finished = terminal(service, root.id); service.resume(root.id, 'default'); await finished;
    assert.ok(Math.abs(service.get(root.id, 'default').cost - 0.06) < 1e-10);
    assert.equal(service.get(root.id, 'default').tokensIn, 30);
    assert.ok(Math.abs(store.aggregateSessions()[0].cost - 0.06) < 1e-10);
  } finally { await service.shutdown(); store.close(); }
});

test('raw history survives compaction and temporary context cannot remove identical user text', async () => {
  const context = { role: 'user' as const, content: 'same text', context: { id: 'rules', source: 'rules', scope: 'workspace' as const, trust: 'user' as const, retention: 'required' as const } };
  const { service, store, session, environment } = setup({ approveApproval: () => false, async *run(opts) {
    opts.historyArchive!.save!([...opts.messages, context, { role: 'assistant', content: 'raw answer' }]);
    opts.onCheckpoint!(0, [...opts.messages, context, { role: 'user', content: 'summary' }]);
    yield done;
  } });
  environment.prepare = () => ({ provider, model: 'test', traceId: '', messages: [], contextMessages: [context] });
  try {
    const run = service.create(session, { message: 'same text' }); await terminal(service, run.id);
    const history = store.runs.searchHistory(run.id, 'raw answer');
    assert.equal(history.length, 1); assert.equal(history[0].context.trust, 'reference');
    const checkpoint = store.runs.checkpoint(run.id)!;
    assert.equal(checkpoint.history.filter(message => message.content === 'same text').length, 1);
    assert.equal(store.runs.searchHistory(run.id, 'rules').length, 0);
  } finally { await service.shutdown(); store.close(); }
});

test('parent cancellation propagates to child runs', async () => {
  const entered = deferred();
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    if (opts.parentRunId) {
      entered.resolve();
      await new Promise<void>(resolve => { if (opts.signal?.aborted) resolve(); else opts.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      yield { type: 'error', error: 'stopped', kind: 'aborted' };
    } else { await opts.delegate!({ objective: 'child' }); yield { type: 'error', error: 'stopped', kind: 'aborted' }; }
  } });
  try { const run = service.create(session, { message: 'work' }); const stopped = terminal(service, run.id); await entered.promise; service.cancel(run.id, 'default'); await stopped; assert.equal(store.runs.children(run.id, 'default')[0].status, 'cancelled'); }
  finally { await service.shutdown(); store.close(); }
});

test('cancel aborts execution; shutdown leaves manually recoverable interruption', async () => {
  for (const stop of ['cancel', 'shutdown']) {
    const entered = deferred();
    const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
      entered.resolve();
      await new Promise<void>(resolve => { if (opts.signal?.aborted) resolve(); else opts.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      yield { type: 'error', error: 'stopped', kind: 'aborted' };
    } });
    try {
      const run = service.create(session, { message: 'work' }); const finished = terminal(service, run.id);
      await entered.promise;
      if (stop === 'cancel') service.cancel(run.id, 'default'); else await service.shutdown();
      await finished;
      assert.equal(service.get(run.id, 'default').status, stop === 'cancel' ? 'cancelled' : 'interrupted');
    } finally { await service.shutdown(); store.close(); }
  }
});

test('startup interrupts orphaned runs and never automatically executes them', async () => {
  let calls = 0;
  const runner: AgentLoop = { approveApproval: () => false, async *run() { calls++; yield done; } };
  const { service, store, session, environment } = setup(runner);
  const initial = service.create(session, { message: 'work' });
  // Cancel before the queued microtask executes; seed a durable orphan explicitly.
  service.cancel(initial.id, 'default'); await service.shutdown();
  const record = service.get(initial.id, 'default');
  store.runs.update(record, { status: 'running' });
  const next = new RunService(environment);
  try {
    assert.equal(next.get(record.id, 'default').status, 'interrupted');
    assert.equal(calls, 0);
    const finished = terminal(next, record.id);
    next.resume(record.id, 'default'); await finished;
    assert.equal(calls, 1);
  } finally { await next.shutdown(); store.close(); }
});

test('unknown side effects fail closed on resume', async () => {
  const { service, store, session, environment } = setup({ approveApproval: () => false, async *run() { yield done; } });
  const initial = service.create(session, { message: 'write' });
  service.cancel(initial.id, 'default'); await service.shutdown();
  const record = service.get(initial.id, 'default');
  store.runs.update(record, { status: 'interrupted' });
  store.runs.saveCheckpoint(record.id, { history: [], turn: 0, costUsd: 0, toolResults: [], pending: true });
  store.claimToolEffect(record.id, 'write-effect');
  const next = new RunService(environment);
  try { assert.throws(() => next.resume(record.id, 'default'), (error: unknown) => error instanceof RunError && error.code === 'EFFECT_OUTCOME_UNKNOWN'); }
  finally { await next.shutdown(); store.close(); }
});

test('HTTP subscription disconnect does not cancel run; Last-Event-ID replays committed events', async () => {
  const entered = deferred(); const proceed = deferred();
  let signal: AbortSignal | undefined;
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts: RunOptions) { signal = opts.signal; entered.resolve(); yield { type: 'delta', text: 'first' }; await proceed.promise; yield done; } });
  const app = express(); app.use(express.json());
  registerRunRoutes(app, { store, kernel: { rootDir: process.cwd() } } as RouteDeps, service);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2`;
  try {
    const created = await fetch(`${base}/sessions/${session.id}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'work' }) });
    assert.equal(created.status, 202);
    const { runId } = await created.json() as { runId: string };
    await entered.promise; const finished = terminal(service, runId);
    const ac = new AbortController();
    const stream = await fetch(`${base}/runs/${runId}/events`, { signal: ac.signal });
    await stream.body!.getReader().read(); ac.abort();
    assert.equal(signal?.aborted, false);
    proceed.resolve(); await finished;
    const replay = await fetch(`${base}/runs/${runId}/events`, { headers: { 'Last-Event-ID': '2' } });
    const body = await replay.text();
    assert.ok(!body.includes('id: 1\n'));
    assert.ok(body.includes('event: done'));
    assert.ok(body.includes('completed'));
  } finally { proceed.resolve(); await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});


test('advisory budget permits completion and accounts auxiliary calls without duplicate settlement', async () => {
  const billed: ProviderDef = { id: 'billed', label: 'Billed', defaultModel: 'm', prices: { in: 1, out: 2 }, priceSource: 'configured', async *chat() { yield { type: 'usage', input: 10, output: 2 }; yield { type: 'done' }; } };
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    for await (const _ of callModel(billed, [], { model: 'm' })) {}
    for await (const _ of callModel(billed, [], { model: 'm' }, 'vision')) {}
    opts.onUsage?.({ input: 999, output: 999, cost: 999 });
    yield done;
  } });
  try {
    const run = service.create(session, { message: 'work', budgetUsd: 0.000001 }); await terminal(service, run.id);
    const result = service.get(run.id, 'default');
    assert.equal(result.status, 'completed'); assert.equal(result.budgetPolicy, 'advisory');
    assert.ok(Math.abs(result.cost - 0.000028) < 1e-12);
    assert.equal(result.tokensIn, 20); assert.match(result.billingNotice!, /超过/);
    assert.deepEqual(store.runs.modelCalls(run.id).map(call => call.purpose), ['agent', 'vision']);
    store.runs.acknowledgeBilling(result);
    assert.equal(service.get(run.id, 'default').billingNotice, undefined);
    assert.equal(store.runs.modelCalls(run.id).length, 2);
  } finally { await service.shutdown(); store.close(); }
});

test('parent ledger includes child model requests exactly once and propagates uncertainty', async () => {
  const billed: ProviderDef = { id: 'billed', label: 'Billed', defaultModel: 'm', priceSource: 'unknown', async *chat() { yield { type: 'usage', input: 10, output: 2 }; yield { type: 'done' }; } };
  const { service, store, session } = setup({ approveApproval: () => false, async *run(opts) {
    if (!opts.parentRunId) await opts.delegate!({ objective: 'child' });
    for await (const _ of callModel(billed, [], { model: 'm' })) {}
    yield done;
  } });
  try {
    const run = service.create(session, { message: 'work' }); await terminal(service, run.id);
    const result = service.get(run.id, 'default');
    assert.equal(result.status, 'completed'); assert.equal(result.tokensIn, 20);
    assert.equal(result.usageStatus, 'unknown'); assert.ok(result.billingNotice);
    assert.equal(store.runs.modelCalls(run.id).length, 1);
    const child = store.runs.children(run.id, 'default')[0];
    assert.equal(child.tokensIn, 10); assert.equal(store.runs.modelCalls(child.id)[0].parentRunId, run.id);
  } finally { await service.shutdown(); store.close(); }
});


test('an explicit deadline cancels an in-flight model request and reports failure', async () => {
  let stopped = false;
  const slow: ProviderDef = { id: 'slow', label: 'Slow', defaultModel: 'm', async *chat(_messages, options) {
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => { stopped = true; reject(new Error('deadline')); }, { once: true }));
  } };
  const { service, store, session } = setup({ approveApproval: () => false, async *run() {
    for await (const _ of callModel(slow, [], { model: 'm' }, 'vision')) {}
    yield done;
  } });
  try {
    const run = service.create(session, { message: 'work', deadlineAt: Date.now() + 100 });
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = service.get(run.id, 'default');
    assert.equal(stopped, true); assert.equal(result.status, 'failed'); assert.match(result.error!, /截止/);
    assert.equal(store.runs.modelCalls(run.id)[0].status, 'cancelled');
  } finally { await service.shutdown(); store.close(); }
});

test('resume rejects expired deadlines and exhausted original turn limits before launch', async () => {
  let executions = 0;
  const fixture = setup({ approveApproval: () => false, async *run(options) { executions++; options.onCheckpoint?.(0, options.messages, { costUsd: 0, toolResults: [] }); yield { type: 'error', error: 'interrupted', kind: 'upstream' }; } });
  try {
    const first = fixture.service.create(fixture.session, { message: 'deadline' }); await terminal(fixture.service, first.id);
    fixture.store.runs.update(first, { deadlineAt: Date.now() - 1 });
    assert.throws(() => fixture.service.resume(first.id, 'default'), (e: any) => e.code === 'DEADLINE_EXCEEDED');
    const second = fixture.service.create(fixture.session, { message: 'turns' }); await terminal(fixture.service, second.id);
    fixture.store.runs.update(second, { maxTurns: 1 });
    assert.throws(() => fixture.service.resume(second.id, 'default'), (e: any) => e.code === 'TURN_LIMIT_REACHED');
    assert.equal(executions, 2); assert.equal(fixture.service.get(first.id, 'default').status, 'interrupted');
  } finally { await fixture.service.shutdown(); fixture.store.close(); }
});
test('resume keeps original total turns and structured timeout reason across database state', async () => {
  let attempt = 0; const limits: (number | undefined)[] = [];
  const fixture = setup({ approveApproval: () => false, async *run(options) { attempt++; limits.push(options.maxTurns); if (attempt === 1) { options.onCheckpoint?.(2, options.messages, { costUsd: 0, toolResults: [] }); yield { type: 'error', error: '请求超时', kind: 'transient', code: 'REQUEST_TIMEOUT', stage: 'model' }; } else yield done; } });
  try {
    const run = fixture.service.create(fixture.session, { message: 'work' }); await terminal(fixture.service, run.id);
    assert.equal(fixture.service.get(run.id, 'default').problem?.code, 'REQUEST_TIMEOUT');
    const finished = terminal(fixture.service, run.id); fixture.service.resume(run.id, 'default'); await finished;
    assert.deepEqual(limits, [30, 27]); assert.equal(fixture.service.get(run.id, 'default').status, 'completed');
  } finally { await fixture.service.shutdown(); fixture.store.close(); }
});
