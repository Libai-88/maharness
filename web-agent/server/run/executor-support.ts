// server/run/executor-support.ts —— executeRun 的纯装配助手（ADR 0008 后续拆分）
// 只承接从 executeRun 抽出的闭包与回调工厂，语句顺序与语义与拆分前一致。
import type { LLMMessage } from '../../kernel/types';
import type { RunCheckpoint, RunEvent, RunRecord } from '../../kernel/run';
import type { AgentEvent } from '../../kernel/loop';
import type { TaskPluginSession } from '../../kernel/task-plugins';
import type { RunAccount } from './usage';
import type { ExecutorRuntime } from './executor';
import { terminalStatus } from './state';

type RunRepo = ExecutorRuntime['env']['store']['runs'];
type RunOptions = ReturnType<ExecutorRuntime['env']['prepare']>;
type TakeMessagesFn = NonNullable<RunOptions['takeMessages']>;
type CheckpointFn = NonNullable<RunOptions['onCheckpoint']>;

/** 恢复时把已交付的子任务回执并入上下文，避免重复分工。 */
export function mergeChildReceipts(options: RunOptions, children: RunRecord[], repo: RunRepo, record: RunRecord): void {
  if (!children.length) return;
  options.contextMessages = [
    ...(options.contextMessages ?? []),
    {
      role: 'user',
      content: `恢复时已存在的分工回执，请沿用已交付结果：\n${JSON.stringify(
        children.map((child) => ({
          runId: child.id,
          contractId: child.assignmentContractId,
          objective: child.objective,
          status: child.status,
          answer: child.answer?.slice(0, 4000),
          error: child.error,
          artifacts: repo.artifacts(child.id).map((asset) => asset.ref),
        })),
      )}`,
      context: { id: `child-receipts:${record.id}`, source: 'parent_agent', scope: 'run', trust: 'reference', retention: 'required' },
    },
  ];
}

/** 工具集在每次调用时按最新 Run 的 toolNames 与组织授权重算。 */
export function resolveToolsFor(runtime: ExecutorRuntime, repo: RunRepo, record: RunRecord, options: RunOptions) {
  return () => {
    const current = repo.get(record.id, record.tenantId) ?? record;
    const allowed = current.toolNames ? new Set(current.toolNames) : undefined;
    const tools = (runtime.env.tools?.() ?? options.tools ?? []).filter((tool) => !allowed || allowed.has(tool.name));
    return runtime.env.organization ? runtime.env.organization.authorizeTools(current, tools) : tools;
  };
}

/** 插件会话接管工具解析与能力边界。 */
export function overlayPluginSession(
  runtime: ExecutorRuntime,
  repo: RunRepo,
  record: RunRecord,
  options: RunOptions,
  plugins: TaskPluginSession,
): void {
  const base = options.tools ?? runtime.env.tools?.() ?? [];
  const session = plugins;
  const resolveBase = options.resolveTools ?? (() => base);
  options.resolveTools = () => {
    const current = repo.get(record.id, record.tenantId) ?? record;
    const allowed = current.toolNames ? new Set(current.toolNames) : undefined;
    return [
      ...resolveBase().filter((tool) => !['create_plugin', 'plugin_status', 'enable_plugin', 'disable_plugin'].includes(tool.name)),
      ...session.tools().filter((tool) => !allowed || allowed.has(tool.name)),
    ];
  };
  options.tools = options.resolveTools();
  options.scopedCapabilities = (kind) => session.capabilities(kind);
  options.scopedBus = session.bus;
  options.capabilityRevision = () => session.revision();
  options.capabilityBoundary = () => session.boundary();
}

/** 历史裁剪：去掉运行时系统消息与已被当成上下文注入的消息，避免重复。 */
export function modelHistoryOf(options: RunOptions): (history: LLMMessage[]) => LLMMessage[] {
  const contextIds = new Set((options.contextMessages ?? []).flatMap((message) => (message.context?.id ? [message.context.id] : [])));
  return (history: LLMMessage[]) =>
    [...history].filter(
      (message) =>
        !(
          message.role === 'system' &&
          message.context?.id === 'runtime' &&
          message.context.source === 'runtime' &&
          message.context.trust === 'core'
        ) &&
        (!message.context?.id || !contextIds.has(message.context.id)),
    );
}

/** takeMessages：把用户补充消息落库、发事件，并转成下一轮上下文。 */
export function takeMessagesHandler(
  runtime: ExecutorRuntime,
  repo: RunRepo,
  record: RunRecord,
  modelHistory: (history: LLMMessage[]) => LLMMessage[],
  cp: RunCheckpoint,
): TakeMessagesFn {
  return (history: LLMMessage[], turn: number) => {
    const current: RunCheckpoint = {
      history: modelHistory(history),
      turn: cp.turn + turn,
      costUsd: record.cost,
      toolResults: repo.checkpoint(record.id)?.toolResults ?? [],
      enabledTools: repo.checkpoint(record.id)?.enabledTools,
      releasedTools: repo.checkpoint(record.id)?.releasedTools,
      selectedCapabilities: repo.checkpoint(record.id)?.selectedCapabilities,
      capabilityConflicts: repo.checkpoint(record.id)?.capabilityConflicts,
    };
    const events: RunEvent[] = [];
    const delivered = repo.transaction(() => {
      const messages = repo.deliverMessages(record.id, current);
      for (const message of messages) {
        runtime.env.store.addMessage({ sessionId: record.sessionId, role: 'user', content: message.content, traceId: record.id });
        events.push(repo.append(record.id, 'message_delivered', { id: message.id }));
      }
      return messages;
    });
    events.forEach((event) => {
      runtime.publish(event);
    });
    return delivered.map((message) => ({
      role: 'user',
      content: message.content,
      context: { id: message.id, source: 'user-supplement', scope: 'run', trust: 'user', retention: 'required' },
    }));
  };
}

/** onCheckpoint：落检查点并按需记录能力解析。 */
export function checkpointHandler(
  repo: RunRepo,
  record: RunRecord,
  modelHistory: (history: LLMMessage[]) => LLMMessage[],
  account: RunAccount,
): CheckpointFn {
  return (turn, history, evidence, step) => {
    repo.saveCheckpoint(record.id, {
      history: modelHistory(history),
      turn: step?.phase === 'tool_pending' ? turn - 1 : turn,
      costUsd: account.managed ? record.cost : (evidence?.costUsd ?? record.cost),
      toolResults: evidence?.toolResults ?? [],
      enabledTools: evidence?.enabledTools ?? repo.checkpoint(record.id)?.enabledTools,
      releasedTools: evidence?.releasedTools ?? repo.checkpoint(record.id)?.releasedTools,
      selectedCapabilities: evidence?.selectedCapabilities ?? repo.checkpoint(record.id)?.selectedCapabilities,
      capabilityConflicts: evidence?.capabilityConflicts ?? repo.checkpoint(record.id)?.capabilityConflicts,
      pending: step?.phase === 'tool_pending',
      pendingTool: step?.phase === 'tool_pending' ? step.pendingTool : undefined,
    });
    if (evidence?.selectedCapabilities?.length) {
      const resolution = {
        selected: evidence.selectedCapabilities,
        tools: evidence.enabledTools ?? [],
        reason: 'agent_enabled_capability',
        conflicts: evidence.capabilityConflicts ?? [],
      };
      if (JSON.stringify(record.capabilityResolution) !== JSON.stringify(resolution))
        repo.update(record, { capabilityResolution: resolution }, 'capability_resolution', resolution);
    }
  };
}

/** 循环结束后的终态结算：预算/轮数耗尽与正常完成共用一条事务。 */
export function finishRun(
  runtime: ExecutorRuntime,
  repo: RunRepo,
  record: RunRecord,
  options: RunOptions,
  completed: boolean,
  nonRecoverable: boolean,
): void {
  const exhausted = (repo.checkpoint(record.id)?.turn ?? -1) + 1 >= (record.maxTurns ?? options.maxTurns ?? 30);
  const terminal = repo.transaction(() => {
    const state = repo.update(record, { status: terminalStatus({ completed, nonRecoverable, exhausted }) });
    runtime.env.organization?.finalizeRun(record);
    return state;
  });
  runtime.publish(terminal);
}

/** assistant_done 的交付判定：空交付、验收缺口、用量结算与最终消息落库。 */
export function settleAssistantDone(
  runtime: ExecutorRuntime,
  repo: RunRepo,
  record: RunRecord,
  account: RunAccount,
  event: Extract<AgentEvent, { type: 'assistant_done' }>,
  reasoning: string,
): 'empty' | { completed: boolean } {
  if (!event.content.trim()) {
    record.error = '模型未返回有效交付，任务可恢复。';
    record.problem = { code: 'EMPTY_RESPONSE', stage: 'model', hint: '工具事实与检查点已保留，可继续任务。' };
    runtime.publish(
      repo.update(record, { error: record.error, problem: record.problem }, 'error', {
        error: record.error,
        code: 'EMPTY_RESPONSE',
      }),
    );
    return 'empty';
  }
  const current = repo.get(record.id, record.tenantId)!;
  const gaps = runtime.env.organization?.deliveryGaps(current) ?? [];
  const verification = record.verification as { type?: string; checks?: { ok: boolean; reason: string }[] } | undefined;
  if (verification?.type === 'task_failed' || verification?.type === 'task_partial') {
    const failed = verification.checks?.filter((check) => !check.ok).map((check) => check.reason) ?? [];
    gaps.push(...(failed.length ? failed : ['任务验收未通过']));
  }
  const completed = gaps.length === 0;
  const patch = account.managed
    ? { cost: record.cost, tokensIn: record.tokensIn, tokensOut: record.tokensOut }
    : account.patch(event.cost, event.usage.input, event.usage.output);
  const persisted = repo.transaction(() => {
    if (!record.parentId && record.origin?.kind !== 'society')
      runtime.env.store.addMessage({
        sessionId: record.sessionId,
        role: 'assistant',
        content: event.content,
        reasoning: event.reasoning || reasoning,
        traceId: record.id,
      });
    const payload = { ...event, cost: patch.cost, usage: { input: patch.tokensIn, output: patch.tokensOut } };
    if (completed) return account.account({ answer: event.content, ...patch }, 'done', payload);
    const error = [...new Set(gaps)].join('；');
    return account.account(
      { answer: event.content, ...patch, error, problem: { code: 'DELIVERY_INCOMPLETE', stage: 'verification', hint: error } },
      'error',
      { ...payload, error, code: 'DELIVERY_INCOMPLETE' },
    );
  });
  account.publishUsage(persisted);
  return { completed };
}

/** error 事件：记录问题描述，并判断是否属于不可恢复的上游错误。 */
export function applyErrorEvent(record: RunRecord, event: Extract<AgentEvent, { type: 'error' }>): boolean {
  record.error = event.error;
  record.problem = {
    code: event.code ?? (event.kind ?? 'upstream').toUpperCase(),
    stage: event.stage ?? 'execution',
    hint: '已保存的草稿可检查和下载；继续任务前会检查版本、权限、截止时间和剩余额度。',
  };
  return event.kind === 'upstream' && record.origin?.kind === 'society';
}
