// server/run/recovery.ts —— 断点核对与分支恢复（ADR 0008）
//
// 恢复的硬规则：只有"可证明没有产生副作用"的调用才补结果；pending 的副作用一律拒绝自动重放，
// 因为重放等于替用户决定外部世界发生过什么。
import { randomUUID } from 'node:crypto';
import type { RunCheckpoint, RunEvent, RunRecord } from '../../kernel/run';
import type { ToolCall, ToolResult } from '../../kernel/types';
import type { RunEnvironment } from '../run-types';
import { RunError } from '../run-types';

export interface RecoveryRuntime {
  readonly env: RunEnvironment;
  publish(event: RunEvent): void;
  launch(record: RunRecord, resumed?: boolean): void;
  execution(id: string): { abort: AbortController; promise: Promise<void> } | undefined;
}

/** 断点里已经发出、但缺少结果的工具调用：能核对就补，不能核对就拒绝恢复。 */
export function recoverCheckpoint(runtime: RecoveryRuntime, run: RunRecord, cp: RunCheckpoint): void {
  const answered = new Set(cp.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  const missing = cp.history
    .flatMap((message) => (message.role === 'assistant' ? (message.tool_calls ?? []) : []))
    .filter((call) => !answered.has(call.id));
  if (!missing.length) {
    if (cp.pending) throw new RunError(409, 'CHECKPOINT_INCOMPLETE', '待执行断点缺少原生工具批次，请核对已有操作后发起新任务');
    return;
  }
  const pending = cp.pendingTool;
  if (!cp.pending || !pending || missing[0].id !== pending.toolCallId)
    throw new RunError(409, 'CHECKPOINT_INCOMPLETE', '断点缺少可核对的工具执行边界，请核对已有操作后发起新任务');
  const writable = pending.sideEffect !== 'read' && pending.sideEffect !== 'none';
  if (writable && !pending.effectKey)
    throw new RunError(409, 'CHECKPOINT_INCOMPLETE', '断点缺少副作用执行标识，请核对已有操作后发起新任务');
  const effect = pending.effectKey ? runtime.env.store.peekToolEffect(run.id, pending.effectKey) : undefined;
  if (effect?.state === 'pending') throw new RunError(409, 'EFFECT_OUTCOME_UNKNOWN', '操作执行结果未知，不能自动重放');
  if (effect?.state === 'done' && !effect.result) throw new RunError(409, 'CHECKPOINT_INCOMPLETE', '已完成操作缺少持久结果，不能自动重放');
  const recovered: { call: ToolCall; id: string; result: ToolResult }[] = missing.map((call, index) => ({
    call,
    id: index === 0 && pending.resultId ? pending.resultId : randomUUID(),
    result:
      index === 0 && effect?.state === 'done' && effect.result
        ? effect.result
        : index === 0 && pending.sideEffect === 'none' && ['run_parallel', 'run_subagent', 'run_review'].includes(pending.name)
          ? {
              ok: false,
              error: '委派等待已中断。请查看已存在的分工回执。',
              failure: { code: 'DELEGATION_INTERRUPTED', retryable: false, outcome: 'applied' },
            }
          : {
              ok: false,
              error: '服务中断，此调用没有可用观察；有副作用的操作尚未开始。',
              failure: { code: 'TOOL_INTERRUPTED', retryable: true, outcome: 'not_started' },
            },
  }));
  const events = runtime.env.store.runs.transaction(() => {
    const repo = runtime.env.store.runs;
    const recorded = new Set((repo.toolCalls(run.id) as { id: string }[]).map((call) => call.id));
    const events: RunEvent[] = [];
    for (const { call, id, result } of recovered) {
      if (!recorded.has(id)) repo.startTool(run.id, id, call.function.name, '中断恢复');
      repo.finishTool(run.id, id, result);
      cp.history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      cp.toolResults.push({ name: call.function.name, ok: result.ok, evidence: result.evidence });
      events.push(repo.append(run.id, 'tool_recovered', { id, name: call.function.name, outcome: result.failure?.outcome ?? 'applied' }));
    }
    repo.saveCheckpoint(run.id, { ...cp, turn: cp.turn + 1, pending: false, pendingTool: undefined });
    return events;
  });
  events.forEach((event) => {
    runtime.publish(event);
  });
}

/** 父任务恢复后，把仍满足授权与契约的子任务一并拉起；不满足的子任务保持中断并记录原因。 */
export async function resumeChildren(runtime: RecoveryRuntime, parent: RunRecord, signal: AbortSignal): Promise<void> {
  const repo = runtime.env.store.runs;
  const organization = runtime.env.store.organization;
  const children = repo
    .children(parent.id, parent.tenantId)
    .filter(
      (child) =>
        child.status === 'interrupted' &&
        child.assignmentContractId &&
        organization.getContract(child.assignmentContractId, parent.tenantId)?.status === 'active',
    );
  await Promise.all(
    children.map(async (child) => {
      if (signal.aborted) return;
      try {
        const checkpoint = repo.checkpoint(child.id);
        const role = child.organizationRoleId && organization.getRole(child.organizationRoleId, child.tenantId);
        if (
          !checkpoint ||
          !role ||
          role.employment !== 'active' ||
          (role.authority.workspace && role.authority.workspace !== parent.authorization.workspace)
        )
          throw new Error('分支断点或角色授权不可用');
        if (child.authorization.workspace !== parent.authorization.workspace) throw new Error('分支工作区授权已变更');
        child.authorization = {
          ...child.authorization,
          revision: parent.authorization.revision,
          profile:
            parent.authorization.profile === 'developer' && role.authority.profile !== 'standard'
              ? child.authorization.profile
              : 'standard',
          readOnly: child.authorization.readOnly || parent.authorization.readOnly || role.authority.readOnly,
        };
        child.principalRole = parent.principalRole;
        child.toolNames = child.toolNames?.filter(
          (name) =>
            (!parent.toolNames || parent.toolNames.includes(name)) &&
            (!role.authority.allowedTools.length || role.authority.allowedTools.includes(name)),
        );
        if (child.authorization.readOnly || child.authorization.profile !== 'developer' || !parent.authorization.pluginDevelopment?.enabled)
          child.authorization.pluginDevelopment = undefined;
        recoverCheckpoint(runtime, child, checkpoint);
        if ((repo.checkpoint(child.id)?.turn ?? -1) + 1 >= (child.maxTurns ?? runtime.env.prepare(child).maxTurns ?? 30))
          throw new Error('分支轮数已耗尽');
        const queued = repo.transaction(() => {
          const costRemaining = child.budgetUsd === undefined ? undefined : Math.max(0, child.budgetUsd - child.cost);
          const tokensRemaining =
            child.budgetTokens === undefined ? undefined : Math.max(0, child.budgetTokens - child.tokensIn - child.tokensOut);
          repo.reserveChild(parent, child.id, costRemaining);
          repo.reserveChildTokens(parent, child.id, tokensRemaining);
          return repo.update(child, { status: 'queued', error: undefined, problem: undefined });
        });
        runtime.publish(queued);
      } catch (error) {
        runtime.publish(repo.update(child, { status: 'interrupted', error: error instanceof Error ? error.message : String(error) }));
        runtime.env.organization?.finalizeRun(child);
        return;
      }
      runtime.launch(child, true);
      const execution = runtime.execution(child.id)!;
      const stopChild = () => execution.abort.abort(signal.reason);
      signal.addEventListener('abort', stopChild, { once: true });
      if (signal.aborted) stopChild();
      try {
        await execution.promise;
      } finally {
        signal.removeEventListener('abort', stopChild);
        repo.releaseChild(child.id);
      }
    }),
  );
}
