import { randomUUID } from 'node:crypto';

import type { ChildRunFallback, ChildRunRequest, ChildRunResult, RunEvent, RunRecord } from '../../kernel/run';
import { RunError } from '../run-types';
import type { RunService } from '../run-service';

type Host = RunService;

/** 父链路前置检查：父任务必须在跑、深度与团队预算都还有余量。 */
function guardParent(host: Host, parentId: string, tenant: string, request: ChildRunRequest, signal?: AbortSignal) {
  const parent = host.get(parentId, tenant);
  const execution = host.active.get(parentId);
  if (host.closing || !execution || execution.abort.signal.aborted || signal?.aborted)
    throw new RunError(409, 'PARENT_NOT_RUNNING', '父任务未运行');
  if (parent.depth >= (host.env.maxDepth ?? 4)) throw new RunError(429, 'DELEGATION_DEPTH', '已达到最大委派深度');
  if (!request.objective.trim()) throw new RunError(400, 'INVALID_OBJECTIVE', '子任务目标不能为空');
  if (
    parent.budgetPolicy === 'enforce' &&
    ((parent.budgetUsd !== undefined && parent.cost >= parent.budgetUsd * 0.8) ||
      (parent.budgetTokens !== undefined && parent.tokensIn + parent.tokensOut >= parent.budgetTokens * 0.8))
  )
    throw new RunError(409, 'TEAM_BUDGET_INSUFFICIENT', '团队预算已使用至少 80%，不再启动新分支；已完成结果会保留');
  return { parent, execution };
}

/** 子任务记录：只继承父任务的只读/工作区/预算类别，工具按只读授权过滤。 */
function buildChild(parent: RunRecord, tenant: string, request: ChildRunRequest, readOnly: boolean, toolNames: string[]): RunRecord {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    sessionId: parent.sessionId,
    tenantId: tenant,
    parentId: parent.id,
    rootId: parent.rootId,
    depth: parent.depth + 1,
    objective: request.objective,
    providerId: parent.providerId,
    model: parent.model,
    status: 'queued',
    authorization: {
      workspace: parent.authorization.workspace,
      revision: parent.authorization.revision,
      profile: parent.authorization.profile,
      readOnly,
    },
    principalRole: parent.principalRole,
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    createdAt: now,
    updatedAt: now,
    parentStepId: request.parentStepId,
    toolNames,
    instructions: request.instructions,
    maxTurns: request.maxTurns,
    deadlineAt: parent.deadlineAt,
  };
}

/** 分工契约预算与请求预算取小，并同时预留父子两侧额度。 */
function reserveBudgets(host: Host, parent: RunRecord, child: RunRecord, request: ChildRunRequest, contractId?: string, tenant?: string) {
  const contract = contractId ? host.env.store.organization.getContract(contractId, tenant ?? parent.tenantId) : undefined;
  const money = moneyBudget(request, contract);
  const tokens = tokenBudget(request, contract);
  child.budgetTokens = host.env.store.runs.reserveChildTokens(parent, child.id, tokens);
  if (
    child.budgetTokens !== undefined &&
    parent.budgetTokens !== undefined &&
    tokens !== undefined &&
    child.budgetTokens > parent.budgetTokens
  )
    throw new RunError(409, 'TEAM_BUDGET_INSUFFICIENT', '子任务 token 预算不能超过父任务预算');
  child.budgetUsd = host.env.store.runs.reserveChild(parent, child.id, money);
  child.budgetPolicy = parent.budgetPolicy;
}

function moneyBudget(request: ChildRunRequest, contract: { budgetUsd?: number } | undefined): number | undefined {
  if (contract?.budgetUsd !== undefined && request.budgetUsd !== undefined && request.budgetUsd > contract.budgetUsd + 1e-10)
    throw new RunError(409, 'TEAM_BUDGET_INSUFFICIENT', '子任务预算不能超过分工契约预算');
  if (request.budgetUsd === undefined) return contract?.budgetUsd;
  return Math.min(request.budgetUsd, contract?.budgetUsd ?? request.budgetUsd);
}

function tokenBudget(request: ChildRunRequest, contract: { budgetTokens?: number } | undefined): number | undefined {
  if (contract?.budgetTokens !== undefined && request.budgetTokens !== undefined && request.budgetTokens > contract.budgetTokens)
    throw new RunError(409, 'TEAM_BUDGET_INSUFFICIENT', '子任务 token 预算不能超过分工契约预算');
  if (request.budgetTokens === undefined) return contract?.budgetTokens;
  return Math.min(request.budgetTokens, contract?.budgetTokens ?? request.budgetTokens);
}

/** 插件继承：跟随显式请求并补齐依赖；只读子任务不允许继承写插件。 */
function inheritPlugins(host: Host, parent: RunRecord, child: RunRecord, request: ChildRunRequest, readOnly: boolean): void {
  const available = host.env.store.runs.plugins(parent.id).filter((binding) => binding.state === 'active');
  const selected = new Set(request.plugins ?? []);
  const include = (id: string) => {
    for (const dependency of available.find((binding) => binding.id === id)?.manifest.requires ?? [])
      if (!selected.has(dependency)) {
        selected.add(dependency);
        include(dependency);
      }
  };
  for (const id of selected) include(id);
  const inherited = available.filter((binding) => selected.has(binding.id));
  if (request.plugins?.some((plugin) => !inherited.some((binding) => binding.id === plugin)))
    throw new RunError(400, 'PLUGIN_NOT_INHERITABLE', '只能委派当前活动的任务插件');
  if (inherited.length && readOnly)
    throw new RunError(403, 'PLUGIN_INHERITANCE_REQUIRES_WRITE_GRANT', '运行生成代码需要允许写入的子任务授权');
  host.env.store.runs.putPlugins(
    child.id,
    inherited.map((binding) => ({ ...binding, owner: child.id })),
  );
}

/** 子任务在一个事务里落库：组织挂接、预算预留、插件继承、初始检查点。 */
function persistChild(
  host: Host,
  parent: RunRecord,
  child: RunRecord,
  request: ChildRunRequest,
  readOnly: boolean,
  tools: string[],
): RunEvent {
  let contractId = request.assignmentContractId;
  return host.env.store.runs.transaction(() => {
    if (host.env.organization) {
      try {
        contractId = host.env.organization.prepareDelegation(parent, child, request, tools).id;
      } catch (error) {
        if (error instanceof Error && 'code' in error && 'status' in error) {
          throw new RunError(Number((error as { status: number }).status), String((error as { code: string }).code), error.message);
        }
        throw error;
      }
    }
    reserveBudgets(host, parent, child, request, contractId, parent.tenantId);
    const event = host.env.store.runs.create(child);
    inheritPlugins(host, parent, child, request, readOnly);
    host.env.store.runs.saveCheckpoint(child.id, {
      history: [
        {
          role: 'user',
          content: request.objective,
          context: { id: `task:${child.id}`, source: 'user', scope: 'run', trust: 'user', retention: 'required' },
        },
      ],
      turn: -1,
      costUsd: 0,
      toolResults: [],
    });
    return event;
  });
}

/** 等待子任务结束，并在失败时回退单人接管。 */
async function awaitChild(
  host: Host,
  parent: RunRecord,
  child: RunRecord,
  execution: { abort: AbortController },
  signal?: AbortSignal,
): Promise<ChildRunResult> {
  const abort = () =>
    host.active
      .get(child.id)
      ?.abort.abort(execution.abort.signal.aborted ? execution.abort.signal.reason : (signal?.reason ?? 'delegation_cancelled'));
  execution.abort.signal.addEventListener('abort', abort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  if (execution.abort.signal.aborted || signal?.aborted) abort();
  try {
    await host.active.get(child.id)!.promise;
  } finally {
    execution.abort.signal.removeEventListener('abort', abort);
    signal?.removeEventListener('abort', abort);
    host.env.store.runs.releaseChild(child.id);
  }
  const finished = host.get(child.id, parent.tenantId);
  let fallback: ChildRunFallback | undefined;
  if (finished.status !== 'completed' && !execution.abort.signal.aborted) {
    const reason = finished.error ?? `分支状态：${finished.status}`;
    host.env.organization?.collapseToSolo(parent, reason);
    const current = host.get(parent.id, parent.tenantId);
    if (current.fallbackReason === 'ROLLBACK_TO_SOLO') fallback = host.env.organization?.soloTakeoverContract(current, reason);
  }
  return {
    runId: child.id,
    traceId: child.id,
    answer: finished.answer ?? '',
    cost: finished.cost,
    tokensIn: finished.tokensIn,
    tokensOut: finished.tokensOut,
    toolCalls: host.env.store.runs.toolCalls(child.id).length,
    error: finished.error ?? (finished.status === 'completed' ? undefined : `子任务状态: ${finished.status}`),
    cancelled: finished.status === 'cancelled',
    ...(fallback ? { fallback } : {}),
  };
}

/** 子任务委派与等待（父链路、并发、取消与回执），从 RunService 迁出（ADR 0008） */
export async function delegateRun(
  host: Host,
  parentId: string,
  tenant: string,
  request: ChildRunRequest,
  signal?: AbortSignal,
): Promise<ChildRunResult> {
  const { parent, execution } = guardParent(host, parentId, tenant, request, signal);
  const readOnly = parent.authorization.readOnly || request.tools !== 'all' || parent.authorization.profile !== 'developer';
  const tools = (host.env.tools?.() ?? []).filter((tool) => !parent.toolNames || parent.toolNames.includes(tool.name));
  const toolNames = tools
    .filter((tool) => !readOnly || tool.delegates || tool.sideEffect === 'none' || tool.sideEffect === 'read')
    .map((tool) => tool.name);
  const child = buildChild(parent, tenant, request, readOnly, toolNames);
  const event = persistChild(
    host,
    parent,
    child,
    request,
    readOnly,
    tools.map((tool) => tool.name),
  );
  host.publish(event);
  host.publish(host.env.store.runs.append(parent.id, 'child_created', { runId: child.id, objective: child.objective }));
  host.launch(child);
  return awaitChild(host, parent, child, execution, signal);
}
