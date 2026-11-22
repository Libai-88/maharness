// server/run/executor-start.ts —— 一次 Run 的启动装配（ADR 0008）
//
// 从 executor.ts 抽出：只做"把记录变成一个可跑的 options + 账户"，语句顺序与事件
// 先后与原实现一致；审批/预算时序不得调整。
import { randomUUID } from 'node:crypto';
import type { AgentLoop, RunOptions } from '../../kernel/loop';
import type { ExecutionPool } from '../../kernel/execution-pool';
import type { ChildRunRequest, ChildRunResult, RunCheckpoint, RunRecord } from '../../kernel/run';
import type { TaskPluginSession } from '../../kernel/task-plugins';
import type { RecoveryRuntime } from './recovery';
import { RunAccount } from './usage';
import { mergeChildReceipts, modelHistoryOf, overlayPluginSession, resolveToolsFor } from './executor-support';

export interface ExecutorRuntime extends RecoveryRuntime {
  readonly modelPool: ExecutionPool;
  readonly pool: ExecutionPool;
  isClosing(): boolean;
  resumeChildren(parent: RunRecord, signal: AbortSignal): Promise<void>;
  delegate(parentId: string, tenant: string, request: ChildRunRequest, signal?: AbortSignal): Promise<ChildRunResult>;
}

export type RunsRepo = ExecutorRuntime['env']['store']['runs'];

export interface ExecutionContext {
  runner: AgentLoop;
  cp: RunCheckpoint;
  options: RunOptions;
  account: RunAccount;
  modelHistory: ReturnType<typeof modelHistoryOf>;
  plugins?: TaskPluginSession;
}

export async function startExecution(
  runtime: ExecutorRuntime,
  repo: RunsRepo,
  record: RunRecord,
  abort: AbortController,
  resumed: boolean,
): Promise<ExecutionContext | undefined> {
  if (abort.signal.aborted) return undefined;
  if (resumed) await runtime.resumeChildren(record, abort.signal);
  if (abort.signal.aborted) return undefined;
  const runner = runtime.env.runner();
  if (!runner) throw new Error('执行循环服务未加载');
  const cp = repo.checkpoint(record.id)!;
  const attemptId = randomUUID();
  const options = runtime.env.prepare(record);
  const children = resumed ? repo.children(record.id, record.tenantId) : [];
  mergeChildReceipts(options, children, repo, record);
  const resolveTools = resolveToolsFor(runtime, repo, record, options);
  options.tools = resolveTools();
  options.resolveTools = resolveTools;
  publishRuleResolution(repo, record, options);
  const plugins = await runtime.env.plugins?.open(record);
  attachInstructions(options, record);
  if (plugins) overlayPluginSession(runtime, repo, record, options, plugins);
  if (record.maxTurns === undefined) runtime.publish(repo.update(record, { maxTurns: options.maxTurns ?? 30 }));
  options.maxTurns = Math.max(0, record.maxTurns! - (cp.turn + 1));
  const modelHistory = modelHistoryOf(options);
  const account = openAccount(runtime, repo, record, cp, attemptId, plugins, abort.signal);
  runtime.publish(repo.update(record, { status: 'running' }));
  runtime.publish(repo.append(record.id, 'start', { traceId: record.id, runId: record.id }));
  return { runner, cp, options, account, modelHistory, plugins };
}

function publishRuleResolution(repo: RunsRepo, record: RunRecord, options: RunOptions): void {
  const resolution = options.ruleResolution;
  if (!resolution) return;
  repo.update(record, { ruleResolution: resolution }, 'rule_resolution', {
    applied: resolution.applied.map((rule) => rule.id),
    ignored: resolution.ignored.map((rule) => rule.id),
    conflicts: resolution.conflicts.length,
  });
}

function attachInstructions(options: RunOptions, record: RunRecord): void {
  if (!record.instructions) return;
  options.contextMessages = [
    ...(options.contextMessages ?? []),
    {
      role: 'user',
      content: record.instructions,
      context: { id: `delegation:${record.id}`, source: 'parent_agent', scope: 'run', trust: 'reference', retention: 'required' },
    },
  ];
}

function openAccount(
  runtime: ExecutorRuntime,
  repo: RunsRepo,
  record: RunRecord,
  cp: RunCheckpoint,
  attemptId: string,
  plugins: TaskPluginSession | undefined,
  signal: AbortSignal,
): RunAccount {
  return new RunAccount({
    repo,
    store: runtime.env.store,
    record,
    publish: (event) => runtime.publish(event),
    modelPool: runtime.modelPool,
    checkpoint: () => cp,
    attemptId,
    turn: { current: cp.turn + 1 },
    plugins: () => plugins,
    signal,
  });
}
