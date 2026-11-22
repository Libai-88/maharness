// server/run/executor-flow.ts —— 执行循环的输入装配、事件消费与收尾（ADR 0008）
//
// 从 executor.ts 抽出：语句顺序、事务边界、事件先后与原实现一致。
import type { AgentEvent, RunOptions } from '../../kernel/loop';
import type { RunRecord } from '../../kernel/run';
import { RUN_TERMINAL } from '../../kernel/run';
import type { TaskPluginSession } from '../../kernel/task-plugins';
import { takeMessagesHandler, checkpointHandler, applyErrorEvent, settleAssistantDone } from './executor-support';
import { statusAfterAbort, statusOnEvent } from './state';
import type { ExecutionContext, ExecutorRuntime, RunsRepo } from './executor-start';

export interface RunLoopState {
  reasoning: string;
  completed: boolean;
  nonRecoverable: boolean;
}

export function buildRunnerInput(
  runtime: ExecutorRuntime,
  repo: RunsRepo,
  record: RunRecord,
  abort: AbortController,
  ctx: ExecutionContext,
): RunOptions {
  const { options, account, modelHistory, cp } = ctx;
  const budget =
    record.budgetPolicy !== 'enforce' || record.budgetUsd === undefined ? undefined : Math.max(0, record.budgetUsd - record.cost);
  return {
    ...options,
    modelCallsManaged: true,
    messages: modelHistory(cp.history),
    traceId: record.id,
    runId: record.id,
    executionId: record.id,
    sessionId: record.sessionId,
    tenantId: record.tenantId,
    principalRole: record.principalRole,
    workOrderId: record.workOrderId,
    assignmentContractId: record.assignmentContractId,
    organizationRoleId: record.organizationRoleId,
    teamCycleId: record.teamCycleId,
    parentRunId: record.parentId,
    parentStepId: record.parentStepId,
    authorization: record.authorization,
    sandboxRoot: record.authorization.workspace,
    signal: abort.signal,
    costBudget: budget,
    restoredCostUsd: record.cost,
    restoredToolResults: cp.toolResults,
    restoredEnabledTools: cp.enabledTools,
    restoredReleasedTools: cp.releasedTools,
    turnOffset: cp.turn + 1,
    acquireExecution: (signal) => runtime.pool.acquire(record.rootId, signal),
    availableBudget: () => (record.budgetPolicy === 'enforce' ? repo.availableBudget(record) : undefined),
    delegate: (request, signal) => runtime.delegate(record.id, record.tenantId, request, signal),
    onModelInput: (input) => {
      account.setTurn(input.turn);
    },
    ...(runtime.env.historyArchive === false ? {} : { historyArchive: historyArchiveOf(repo, record, modelHistory) }),
    toolJournal: {
      start: (id, name, args, meta) => repo.startTool(record.id, id, name, args, meta),
      finish: (id, result) => repo.finishTool(record.id, id, result),
      read: (id, offset, limit) => repo.readTool(record.id, id, offset, limit),
    },
    task: taskOf(record),
    effectJournal: {
      peek: (key) => runtime.env.store.peekToolEffect(record.id, key),
      claim: (key) => runtime.env.store.claimToolEffect(record.id, key),
      release: (key) => runtime.env.store.releaseToolEffect(record.id, key),
      complete: (key, result) => runtime.env.store.completeToolEffect(record.id, key, result),
    },
    takeMessages: takeMessagesHandler(runtime, repo, record, modelHistory, cp),
    onCheckpoint: checkpointHandler(repo, record, modelHistory, account),
    onUsage: (usage) => account.recordUsage(usage),
    onUsageStatus: (status) => account.recordUsageStatus(status),
  };
}

function historyArchiveOf(repo: RunsRepo, record: RunRecord, modelHistory: ExecutionContext['modelHistory']) {
  return {
    save: (history: Parameters<typeof modelHistory>[0]) => repo.archiveHistory(record.id, modelHistory(history)),
    search: (query: string, offset: number, limit: number) => repo.searchHistory(record.id, query, offset, limit),
    read: (id: string, offset: number, limit: number) => repo.readHistory(record.id, id, offset, limit),
  };
}

function taskOf(record: RunRecord): RunOptions['task'] {
  if (!record.acceptance?.length && !record.deadlineAt) return undefined;
  return { objective: record.objective, acceptance: record.acceptance ?? [], deadlineAt: record.deadlineAt };
}

/** 单个事件的副作用：状态推进、交付结算、错误落账、验收结果、事件发布。 */
export function consumeEvent(
  runtime: ExecutorRuntime,
  repo: RunsRepo,
  record: RunRecord,
  event: AgentEvent,
  account: ExecutionContext['account'],
  state: RunLoopState,
): void {
  const nextStatus = statusOnEvent(record.status, event.type);
  if (nextStatus) runtime.publish(repo.update(record, { status: nextStatus }));
  if (event.type === 'reasoning') state.reasoning += event.text;
  if (event.type === 'assistant_done') {
    const settled = settleAssistantDone(runtime, repo, record, account, event, state.reasoning);
    if (settled !== 'empty') state.completed = settled.completed;
  } else if (event.type === 'error') {
    if (applyErrorEvent(record, event)) state.nonRecoverable = true;
  } else if (event.type === 'task_verified' || event.type === 'task_partial' || event.type === 'task_failed') {
    record.verification = event;
  }
  if (event.type !== 'assistant_done') {
    const { type, ...data } = event;
    runtime.publish(repo.update(record, {}, type, data as unknown as Record<string, unknown>));
  }
}

/** 收尾：释放插件会话、等待子任务、落终态、交给组织服务定稿、收会话。 */
export async function shutdownRun(
  runtime: ExecutorRuntime,
  repo: RunsRepo,
  record: RunRecord,
  abort: AbortController,
  plugins: TaskPluginSession | undefined,
): Promise<void> {
  await plugins?.dispose();
  if (abort.signal.aborted)
    await Promise.allSettled(repo.children(record.id, record.tenantId).flatMap((child) => runtime.execution(child.id)?.promise ?? []));
  if (abort.signal.aborted && record.status !== 'completed') settleAborted(runtime, repo, record, abort);
  const terminal = repo.get(record.id, record.tenantId);
  if (
    terminal &&
    RUN_TERMINAL.has(terminal.status) &&
    (terminal.status === 'cancelled' || abort.signal.aborted || terminal.status === 'failed')
  )
    runtime.env.organization?.finalizeRun(terminal);
  runtime.env.store.touchSession(record.sessionId);
  if (!abort.signal.aborted) abort.abort('run_finished');
}

function settleAborted(runtime: ExecutorRuntime, repo: RunsRepo, record: RunRecord, abort: AbortController): void {
  const deadlineExceeded = abort.signal.reason === 'deadline_exceeded';
  runtime.publish(
    repo.update(record, {
      status: statusAfterAbort(abort.signal.reason, runtime.isClosing()),
      ...(deadlineExceeded
        ? {
            error: '任务已超过用户设置的截止时间',
            problem: {
              code: 'DEADLINE_EXCEEDED',
              stage: 'execution',
              hint: '截止时间已过，已保存草稿仍可检查和下载；请发起新任务继续。',
            },
          }
        : {}),
    }),
  );
}
