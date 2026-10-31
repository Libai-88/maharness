import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from '../../core/chat/agent';
import { Store } from '../db';
import type { EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, ToolDef, TraceStepInit } from '../../kernel/types';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

function kernelStub(rootDir: string): KernelLike {
  const cfg = new Map<string, unknown>([
    ['agent.toolTimeoutMs', 5000], ['agent.reasoningBudget', 640], ['agent.reasoningTotalBudget', 2000],
    ['agent.maxTurns', 4], ['agent.thinkInEnglish', true], ['sandboxRoot', rootDir],
  ]);
  return {
    rootDir,
    paths: { root: rootDir, data: rootDir, traces: rootDir, configFile: '', dbFile: '', cacheFile: '' },
    config: { get: <T>(key: string, def?: T): T => (cfg.has(key) ? cfg.get(key) as T : def as T) } as unknown as KernelLike['config'],
    trace: { startStep: (_init: TraceStepInit): StepHandle => ({ id: 'step', finish: () => {}, fail: () => {}, cancel: () => {} }) } as unknown as KernelLike['trace'],
    cache: { l1Enabled: false, recordPrefixRepeat: () => {}, recordProviderCacheHit: () => {}, recordSavedCost: () => {} } as unknown as KernelLike['cache'],
    budget: { recordTask: () => {} } as unknown as KernelLike['budget'],
    plugins: { capabilities: (): [] => [] } as unknown as KernelLike['plugins'],
  };
}

function replayProvider(callId: string): ProviderDef {
  let call = 0;
  return {
    id: 'mock', label: 'MOCK', defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      if (call++ === 0) {
        yield { type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'record_effect', arguments: '{"value":7}' } } };
      } else {
        yield { type: 'delta', text: 'done' };
        yield { type: 'done' };
      }
    },
  };
}

function replayToolProvider(callId: string, name: string, args: unknown): ProviderDef {
  let call = 0;
  return {
    id: 'mock', label: 'MOCK', defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      if (call++ === 0) {
        yield { type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } } };
      } else {
        yield { type: 'delta', text: 'done' };
        yield { type: 'done' };
      }
    },
  };
}

const tool: ToolDef = {
  name: 'record_effect', description: 'record', parameters: { type: 'object', properties: { value: { type: 'number' } } },
  async handler(args) { return { ok: true, data: { accepted: (args as { value: number }).value } }; },
};

describe('AgentRunner 副作用恢复账本', () => {
  test('多次重启累计费用并扣减工具预算，完成事件只结算当前调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-cost-restart-'));
    const dbPath = join(root, 'agent.db');
    let store = new Store(dbPath);
    try {
      const session = store.createSession('m');
      const task = { objective: 'done', acceptance: [{ type: 'output_contains' as const, value: 'done' }], costBudgetUsd: 0.5 };
      const budgets: number[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const cp = store.loadCheckpoint(session.id);
        for await (const _event of new AgentRunner(kernelStub(root), bus).run({
          provider: replayProvider(`call-${attempt}`), model: 'm',
          messages: cp?.history as import('../../kernel/types').LLMMessage[] ?? [{ role: 'user', content: 'record' }],
          task: cp?.task ?? task, restoredCostUsd: cp?.costUsd, restoredToolResults: cp?.toolResults,
          turnOffset: cp ? cp.turn + 1 : 0, traceId: `cost-${attempt}`, maxTurns: 1,
          tools: [{ ...tool, async handler(_args, ctx) {
            budgets.push((ctx as typeof ctx & { remainingBudget: number }).remainingBudget);
            return { ok: true, data: { subagentCost: { cost: 0.2 } } };
          } }],
          onCheckpoint: (turn, history, evidence) => store.saveCheckpoint(session.id, turn, history, 'cost-run', task, evidence?.toolResults, evidence?.costUsd),
        })) { /* consume until checkpoint */ }
        store.close();
        store = new Store(dbPath);
        assert.ok(Math.abs(store.loadCheckpoint(session.id)!.costUsd! - (attempt + 1) * 0.2) < 1e-9);
      }
      assert.deepEqual(budgets, [0.5, 0.3]);
      const cp = store.loadCheckpoint(session.id)!;
      const provider: ProviderDef = {
        id: 'priced', label: 'priced', defaultModel: 'm', prices: { in: 1, out: 0 },
        async *chat() {
          yield { type: 'delta' as const, text: 'done' };
          yield { type: 'usage' as const, input: 50_000, output: 0 };
          yield { type: 'done' as const };
        },
      };
      let completed = false;
      for await (const event of new AgentRunner(kernelStub(root), bus).run({
        provider, model: 'm', messages: cp.history as import('../../kernel/types').LLMMessage[],
        traceId: 'cost-final', task: cp.task, restoredCostUsd: cp.costUsd, restoredToolResults: cp.toolResults,
      })) {
        if (event.type === 'assistant_done') {
          completed = true;
          assert.equal(event.cost, 0.05);
        }
      }
      assert.equal(completed, true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('已耗尽的任务预算在重启后阻止 Provider 调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-cost-exhausted-'));
    const dbPath = join(root, 'agent.db');
    let store = new Store(dbPath);
    try {
      const session = store.createSession('m');
      const task = { objective: 'done', acceptance: [{ type: 'output_contains' as const, value: 'done' }], costBudgetUsd: 0.2 };
      for await (const _event of new AgentRunner(kernelStub(root), bus).run({
        provider: replayProvider('cost-call'), model: 'm', messages: [{ role: 'user', content: 'record' }],
        task, traceId: 'cost-first', maxTurns: 1,
        tools: [{ ...tool, async handler() { return { ok: true, data: { subagentCost: { cost: 0.2 } } }; } }],
        onCheckpoint: (turn, history, evidence) => store.saveCheckpoint(session.id, turn, history, 'exhausted-run', task, evidence?.toolResults, evidence?.costUsd),
      })) { /* consume until checkpoint */ }
      store.close();
      store = new Store(dbPath);
      const cp = store.loadCheckpoint(session.id)!;
      let calls = 0;
      const provider: ProviderDef = {
        id: 'counted', label: 'counted', defaultModel: 'm',
        async *chat() { calls++; yield { type: 'done' as const }; },
      };
      const events: string[] = [];
      for await (const event of new AgentRunner(kernelStub(root), bus).run({
        provider, model: 'm', messages: cp.history as import('../../kernel/types').LLMMessage[],
        task: cp.task, restoredCostUsd: cp.costUsd, traceId: 'cost-blocked',
      })) events.push(event.type === 'error' ? `error:${event.kind}` : event.type);
      assert.equal(calls, 0);
      assert.ok(events.includes('budget_hit'));
      assert.ok(events.includes('error:budget'));
      assert.equal(events.includes('assistant_done'), false);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('恢复已完成工具的验收证据，不重复执行 handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-evidence-restart-'));
    const dbPath = join(root, 'agent.db');
    let store = new Store(dbPath);
    let executions = 0;
    try {
      const session = store.createSession('m');
      const task = { objective: '记录结果', acceptance: [{ type: 'tool_succeeded' as const, name: 'record_effect' }] };
      for await (const _event of new AgentRunner(kernelStub(root), bus).run({
        provider: replayProvider('original-call'), model: 'm', messages: [{ role: 'user', content: 'record' }],
        traceId: 'before-restart', task, maxTurns: 1,
        tools: [{ ...tool, async handler() { executions++; return { ok: true }; } }],
        onCheckpoint: (turn, history, evidence) => store.saveCheckpoint(session.id, turn, history, 'run-evidence', task, evidence?.toolResults),
      })) { /* consume until turn limit */ }
      store.close();
      store = new Store(dbPath);
      const cp = store.loadCheckpoint(session.id)!;
      assert.deepEqual(cp.toolResults, [{ name: 'record_effect', ok: true }]);
      const events: string[] = [];
      const provider: ProviderDef = {
        id: 'mock', label: 'mock', defaultModel: 'm',
        async *chat() { yield { type: 'delta' as const, text: 'recorded' }; yield { type: 'done' as const }; },
      };
      for await (const event of new AgentRunner(kernelStub(root), bus).run({
        provider, model: 'm', messages: cp.history as import('../../kernel/types').LLMMessage[],
        traceId: 'after-restart', task: cp.task, restoredToolResults: cp.toolResults, turnOffset: cp.turn + 1,
      })) events.push(event.type);
      assert.ok(events.includes('task_verified'));
      assert.ok(events.includes('assistant_done'));
      assert.equal(executions, 1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('重启后原任务验收和截止时间仍生效', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-contract-restart-'));
    const dbPath = join(root, 'agent.db');
    const original = new Store(dbPath);
    const session = original.createSession('m');
    const task = { objective: '必须有 marker', acceptance: [{ type: 'output_contains' as const, value: 'marker' }], deadlineAt: Date.now() + 60_000 };
    original.saveCheckpoint(session.id, -1, [{ role: 'user', content: 'finish task' }], 'contract-run', task);
    original.close();
    const restarted = new Store(dbPath);
    try {
      const cp = restarted.loadCheckpoint(session.id)!;
      assert.deepEqual(cp.task, task);
      const provider: ProviderDef = {
        id: 'mock', label: 'mock', defaultModel: 'm',
        async *chat() { yield { type: 'delta' as const, text: 'unsupported completion' }; yield { type: 'done' as const }; },
      };
      const execute = async (contract: typeof cp.task) => {
        const events: string[] = [];
        for await (const event of new AgentRunner(kernelStub(root), bus).run({
          provider, model: 'm', messages: [{ role: 'user', content: 'finish task' }], traceId: 'restored-contract', task: contract,
        })) events.push(event.type === 'error' ? `error:${event.kind}` : event.type);
        return events;
      };
      const failed = await execute(cp.task);
      assert.ok(failed.includes('task_failed'));
      assert.equal(failed.includes('assistant_done'), false);
      const expired = await execute({ ...cp.task!, deadlineAt: Date.now() - 1 });
      assert.deepEqual(expired, ['task_failed', 'error:deadline']);
    } finally { restarted.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('Store 重开后回放已完成结果，忽略新的 tool-call ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-effect-'));
    const dbPath = join(root, 'agent.db');
    let executions = 0;
    const countedTool: ToolDef = { ...tool, async handler(args) { executions++; return { ok: true, data: { accepted: (args as { value: number }).value } }; } };
    try {
      const firstStore = new Store(dbPath);
      const execute = async (store: Store, callId: string) => {
        const runner = new AgentRunner(kernelStub(root), bus);
        const events: string[] = [];
        for await (const event of runner.run({
          provider: replayProvider(callId), model: 'm', messages: [{ role: 'user', content: 'do it' }],
          tools: [countedTool], traceId: `trace-${callId}`, sessionId: 'session', maxTurns: 3,
          executionId: 'execution-1', effectJournal: {
            claim: (key) => store.claimToolEffect('execution-1', key),
            complete: (key, result) => store.completeToolEffect('execution-1', key, result),
          },
        })) events.push(event.type);
        return events;
      };
      const firstEvents = await execute(firstStore, 'call-first');
      firstStore.close();
      const restartedStore = new Store(dbPath);
      try {
        const resumedEvents = await execute(restartedStore, 'call-after-restart');
        assert.equal(executions, 1, '恢复后不应再次执行 handler');
        assert.ok(firstEvents.includes('tool_result'));
        assert.ok(resumedEvents.includes('tool_result'));
        assert.equal(restartedStore.hasPendingToolEffects('execution-1'), false);
      } finally { restartedStore.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('pending 结果未知时发出 policy 错误并阻止 handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-effect-pending-'));
    const store = new Store(join(root, 'agent.db'));
    let executions = 0;
    const args = { value: 7 };
    const key = `0:0:record_effect:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`;
    store.claimToolEffect('execution-pending', key);
    try {
      const runner = new AgentRunner(kernelStub(root), bus);
      const events: { type: string; kind?: string }[] = [];
      for await (const event of runner.run({
        provider: replayProvider('call-pending'), model: 'm', messages: [{ role: 'user', content: 'do it' }],
        tools: [{ ...tool, async handler() { executions++; return { ok: true }; } }],
        traceId: 'trace-pending', maxTurns: 3, executionId: 'execution-pending',
        effectJournal: {
          claim: (effectKey) => store.claimToolEffect('execution-pending', effectKey),
          complete: (effectKey, result) => store.completeToolEffect('execution-pending', effectKey, result),
        },
      })) events.push(event);
      assert.equal(executions, 0);
      assert.ok(events.some((event) => event.type === 'error' && event.kind === 'policy'));
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('真实文件、HTTP、子进程副作用恢复不重复执行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-effect-real-'));
    const dbPath = join(root, 'agent.db');
    const filePath = join(root, 'file-effect.txt');
    const processPath = join(root, 'process-effect.txt');
    let httpCalls = 0;
    const httpServer = createServer((req, res) => {
      if (req.method === 'POST') httpCalls++;
      req.resume();
      req.on('end', () => { res.statusCode = 204; res.end(); });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = (httpServer.address() as { port: number }).port;
    const httpUrl = `http://127.0.0.1:${httpPort}/effect`;
    const specs: { name: string; args: unknown; tool: ToolDef; expected: () => void }[] = [
      {
        name: 'write_file_effect', args: { value: 'file\n' },
        tool: { name: 'write_file_effect', description: 'file', parameters: { type: 'object' }, async handler(args) {
          appendFileSync(filePath, (args as { value: string }).value);
          return { ok: true };
        } },
        expected: () => assert.equal(readFileSync(filePath, 'utf8'), 'file\n'),
      },
      {
        name: 'http_effect', args: { value: 'http' },
        tool: { name: 'http_effect', description: 'http', parameters: { type: 'object' }, async handler() {
          await fetch(httpUrl, { method: 'POST', body: 'effect' });
          return { ok: true };
        } },
        expected: () => assert.equal(httpCalls, 1),
      },
      {
        name: 'process_effect', args: { value: 'process' },
        tool: { name: 'process_effect', description: 'process', parameters: { type: 'object' }, async handler() {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', `require('node:fs').appendFileSync(${JSON.stringify(processPath)}, 'process\\n')`], { stdio: 'ignore' });
            child.once('error', reject);
            child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
          });
          return { ok: true };
        } },
        expected: () => assert.equal(readFileSync(processPath, 'utf8'), 'process\n'),
      },
    ];
    let store = new Store(dbPath);
    try {
      for (const [index, spec] of specs.entries()) {
        const executionId = `real-effect-${index}`;
        const execute = async (current: Store, callId: string) => {
          const events: string[] = [];
          for await (const event of new AgentRunner(kernelStub(root), bus).run({
            provider: replayToolProvider(callId, spec.name, spec.args), model: 'm',
            messages: [{ role: 'user', content: 'do it' }], tools: [spec.tool], traceId: `${executionId}-${callId}`,
            sessionId: 'real-effects', maxTurns: 3, executionId,
            effectJournal: {
              claim: (key) => current.claimToolEffect(executionId, key),
              complete: (key, result) => current.completeToolEffect(executionId, key, result),
            },
          })) events.push(event.type);
          return events;
        };
        const first = await execute(store, 'first');
        assert.ok(first.includes('tool_result'));
        spec.expected();
        store.close();
        store = new Store(dbPath);
        const resumed = await execute(store, 'after-restart');
        assert.ok(resumed.includes('tool_result'));
        spec.expected();
      }
    } finally {
      store.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('文件、HTTP、子进程副作用部分完成后失败，恢复时回放失败结果而不重放副作用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-effect-partial-'));
    const dbPath = join(root, 'agent.db');
    const filePath = join(root, 'partial-file.txt');
    const processPath = join(root, 'partial-process.txt');
    let httpCalls = 0;
    const httpServer = createServer((req, res) => {
      if (req.method === 'POST') httpCalls++;
      req.resume();
      req.on('end', () => { res.statusCode = 204; res.end(); });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = (httpServer.address() as { port: number }).port;
    const httpUrl = `http://127.0.0.1:${httpPort}/partial`;
    const specs: { name: string; handler: () => Promise<void> | void; verify: () => void }[] = [
      {
        name: 'partial_file',
        handler: () => { appendFileSync(filePath, 'written\n'); throw new Error('failure after file write'); },
        verify: () => assert.equal(readFileSync(filePath, 'utf8'), 'written\n'),
      },
      {
        name: 'partial_http',
        handler: async () => { await fetch(httpUrl, { method: 'POST', body: 'once' }); throw new Error('failure after HTTP response'); },
        verify: () => assert.equal(httpCalls, 1),
      },
      {
        name: 'partial_process',
        handler: async () => {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', `require('node:fs').appendFileSync(${JSON.stringify(processPath)}, 'spawned\\n')`], { stdio: 'ignore' });
            child.once('error', reject);
            child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
          });
          throw new Error('failure after process effect');
        },
        verify: () => assert.equal(readFileSync(processPath, 'utf8'), 'spawned\n'),
      },
    ];
    let store = new Store(dbPath);
    try {
      for (const [index, spec] of specs.entries()) {
        const executionId = `partial-effect-${index}`;
        let handlerCalls = 0;
        const sideEffectTool: ToolDef = {
          name: spec.name, description: 'partial side effect', parameters: { type: 'object' },
          async handler() { handlerCalls++; await spec.handler(); return { ok: true }; },
        };
        const execute = async (current: Store, callId: string) => {
          const events: { type: string; ok?: boolean; summary?: string }[] = [];
          for await (const event of new AgentRunner(kernelStub(root), bus).run({
            provider: replayToolProvider(callId, spec.name, { effect: true }), model: 'm',
            messages: [{ role: 'user', content: 'go' }], tools: [sideEffectTool],
            traceId: `${executionId}-${callId}`, maxTurns: 3, executionId,
            effectJournal: {
              claim: (key) => current.claimToolEffect(executionId, key),
              complete: (key, result) => current.completeToolEffect(executionId, key, result),
            },
          })) events.push(event.type === 'tool_result' ? { type: event.type, ok: event.ok, summary: event.summary } : { type: event.type });
          return events;
        };
        const first = await execute(store, 'first');
        assert.ok(first.some((event) => event.type === 'tool_result' && event.ok === false));
        spec.verify();
        store.close();
        store = new Store(dbPath);
        const resumed = await execute(store, 'recovered');
        assert.ok(resumed.some((event) => event.type === 'tool_result' && event.ok === false && event.summary?.includes('恢复账本回放')));
        spec.verify();
        assert.equal(handlerCalls, 1);
      }
    } finally {
      store.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
