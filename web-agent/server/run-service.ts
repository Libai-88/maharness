import { createHash, randomUUID } from 'node:crypto';
import { describeModelInput } from '../kernel/input-diagnostics';
import type { ToolCall, ToolResult } from '../kernel/types';
import type { AgentLoop, RunOptions } from '../kernel/loop';
import type { LLMMessage, Session } from '../kernel/types';
import { RUN_TERMINAL, type RunRecord, type RunEvent, type RunCheckpoint } from '../kernel/run';
import type { Store } from './db';
import { ACTIVE_RUN_STATES } from './run-store';
import { ExecutionPool } from '../kernel/execution-pool';
import type { ChildRunRequest, ChildRunResult } from '../kernel/run';

export class RunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface RunEnvironment {
  store: Store;
  prepare(record: RunRecord): RunOptions;
  runner(): AgentLoop | undefined;
  workspace(tenantId: string): string;
  provider(session: Session, providerId?: string): { id: string; model: string } | undefined;
  activity?(active: boolean): void;
  tools?(): import('../kernel/types').ToolDef[];
  maxDepth?: number;
  executionSlots?: number;
}

/** Owns executions; HTTP connections are independent readers of the event journal. */
export class RunService {
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void>; record: RunRecord }>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();
  private closing = false;
  private readonly pool: ExecutionPool;
  constructor(private readonly env: RunEnvironment) { env.store.runs.interruptActive(); this.pool = new ExecutionPool(env.executionSlots ?? 16); }
  private publish(event: RunEvent): void {
    const active = this.active.get(event.runId);
    if (active) Object.assign(active.record, this.env.store.runs.get(event.runId, active.record.tenantId));
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try { listener(event); } catch { /* A failed reader cannot change execution state. */ }
    }
  }
  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, set = new Set());
    set.add(listener);
    return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(id); };
  }
  get(id: string, tenant: string): RunRecord {
    const record = this.env.store.runs.get(id, tenant);
    if (!record) throw new RunError(404, 'RUN_NOT_FOUND', '任务不存在');
    return record;
  }
  create(session: Session, input: { message: string; provider?: string; model?: string; requestKey?: string; budgetUsd?: number; deadlineAt?: number; acceptance?: RunRecord['acceptance']; principalRole?: RunRecord['principalRole']; frameworkChange?: { id: string; workspace: string } }): RunRecord {
    const tenantId = session.tenantId ?? 'default';
    const requestFingerprint = createHash('sha256').update(JSON.stringify([input.message, input.provider ?? null, input.model ?? null, input.budgetUsd ?? null, input.deadlineAt ?? null, input.acceptance ?? null, input.frameworkChange?.id ?? null])).digest('hex');
    if (input.requestKey) {
      const prior = this.env.store.runs.byRequest(tenantId, session.id, input.requestKey);
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint) throw new RunError(409, 'IDEMPOTENCY_CONFLICT', '该请求标识已用于不同的任务');
        return prior;
      }
    }
    if (this.closing) throw new RunError(503, 'RUNTIME_STOPPING', '运行服务正在关闭');
    const running = this.env.store.runs.active(tenantId, session.id).find(run => !run.parentId);
    if (running) throw new RunError(409, 'SESSION_BUSY', `该会话已有任务 ${running.id}，请补充当前任务或停止后新建`);
    const provider = this.env.provider(session, input.provider);
    if (!provider) throw new RunError(400, 'PROVIDER_UNAVAILABLE', '所选模型供应商不可用');
    const tenant = this.env.store.getTenant(tenantId);
    if (tenant?.maxActiveRuns && this.env.store.runs.active(tenantId).length >= tenant.maxActiveRuns)
      throw new RunError(429, 'TENANT_CAPACITY', '租户活动任务配额已用尽');
    const spent = this.env.store.aggregateSessions(tenantId).reduce((total, row) => total + row.cost, 0);
    if (tenant?.maxCostUsd && spent >= tenant.maxCostUsd) throw new RunError(429, 'TENANT_BUDGET', '租户费用配额已用尽');
    const workspace = this.env.workspace(tenantId);
    const permission = this.env.store.runs.permission(tenantId, workspace);
    if (input.frameworkChange && (permission.profile !== 'developer' || input.principalRole && input.principalRole !== 'admin')) throw new RunError(403, 'DEVELOPER_AUTHORIZATION_REQUIRED', '框架修改需要用户开启开发者权限');
    const id = randomUUID();
    const now = Date.now();
    const record: RunRecord = {
      id, sessionId: session.id, tenantId, rootId: id, depth: 0, objective: input.message,
      providerId: provider.id, model: input.model || session.model || provider.model, status: 'queued',
      authorization: { workspace: input.frameworkChange?.workspace ?? workspace, ...permission, readOnly: session.mode === 'plan' || input.principalRole === 'readonly', frameworkChangeId: input.frameworkChange?.id },
      createdAt: now, updatedAt: now, cost: 0, tokensIn: 0, tokensOut: 0,
      budgetUsd: input.budgetUsd, deadlineAt: input.deadlineAt, acceptance: input.acceptance, principalRole: input.principalRole,
      requestFingerprint,
    };
    // Initial history is a run snapshot; later tasks never reconstruct transient context from dialogue.
    const history: LLMMessage[] = this.env.store.listMessages(session.id)
      .filter(message => message.role === 'user' || message.role === 'assistant' && !message.toolCalls?.length)
      .map(message => ({ role: message.role, content: message.content }));
    history.push({ role: 'user', content: input.message, context: { id: `task:${id}`, source: 'user', scope: 'run', trust: 'user', retention: 'required' } });
    const event = this.env.store.runs.transaction(() => {
      record.usageMessageId = this.env.store.addMessage({ sessionId: session.id, role: 'user', content: input.message, traceId: id }).id;
      const event = this.env.store.runs.create(record, input.requestKey);
      this.env.store.runs.saveCheckpoint(id, { history, turn: -1, costUsd: 0, toolResults: [] });
      this.env.store.touchSession(session.id);
      return event;
    });
    this.publish(event);
    this.launch(record);
    return record;
  }
  supplement(id: string, tenant: string, content: string, requestKey?: string): string {
    const run = this.get(id, tenant);
    if (requestKey) {
      const prior = this.env.store.runs.messageByRequest(id, requestKey);
      if (prior) {
        if (prior.content !== content) throw new RunError(409, 'IDEMPOTENCY_CONFLICT', '该请求标识已用于不同的补充消息');
        return prior.id;
      }
    }
    if (!ACTIVE_RUN_STATES.has(run.status) || run.status === 'stopping') throw new RunError(409, 'RUN_NOT_ACTIVE', '只能补充活动任务');
    let messageId = '';
    const event = this.env.store.runs.transaction(() => {
      messageId = this.env.store.runs.addMessage(id, content, requestKey);
      return this.env.store.runs.append(id, 'message_queued', { id: messageId, content });
    });
    this.publish(event);
    return messageId;
  }
  cancel(id: string, tenant: string): RunRecord {
    const run = this.get(id, tenant);
    if (RUN_TERMINAL.has(run.status)) return run;
    this.publish(this.env.store.runs.update(run, { status: 'stopping' }));
    const active = this.active.get(id);
    if (active) active.abort.abort('user_cancel');
    else this.publish(this.env.store.runs.update(run, { status: 'cancelled' }));
    for (const child of this.env.store.runs.children(id, tenant)) if (!RUN_TERMINAL.has(child.status)) this.cancel(child.id, tenant);
    return run;
  }
  async delegate(parentId: string, tenant: string, request: ChildRunRequest): Promise<ChildRunResult> {
    const parent = this.get(parentId, tenant);
    const execution = this.active.get(parentId);
    if (this.closing || !execution || execution.abort.signal.aborted) throw new RunError(409, 'PARENT_NOT_RUNNING', '父任务未运行');
    if (parent.depth >= (this.env.maxDepth ?? 4)) throw new RunError(429, 'DELEGATION_DEPTH', '已达到最大委派深度');
    if (!request.objective.trim()) throw new RunError(400, 'INVALID_OBJECTIVE', '子任务目标不能为空');
    const id = randomUUID();
    const tools = (this.env.tools?.() ?? []).filter(tool => !parent.toolNames || parent.toolNames.includes(tool.name));
    const readOnly = parent.authorization.readOnly || request.tools !== 'all' || parent.authorization.profile !== 'developer';
    const toolNames = tools.filter(tool => !readOnly || tool.delegates || tool.sideEffect === 'none' || tool.sideEffect === 'read').map(tool => tool.name);
    const now = Date.now();
    const child: RunRecord = {
      id, sessionId: parent.sessionId, tenantId: tenant, parentId, rootId: parent.rootId, depth: parent.depth + 1,
      objective: request.objective, providerId: parent.providerId, model: parent.model, status: 'queued',
      authorization: { ...parent.authorization, readOnly }, principalRole: parent.principalRole,
      cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now,
      parentStepId: request.parentStepId, toolNames, instructions: request.instructions, maxTurns: request.maxTurns, deadlineAt: parent.deadlineAt,
    };
    const event = this.env.store.runs.transaction(() => {
      child.budgetUsd = this.env.store.runs.reserveChild(parent, id, request.budgetUsd);
      const event = this.env.store.runs.create(child);
      this.env.store.runs.saveCheckpoint(id, { history: [{ role: 'user', content: request.objective, context: { id: `task:${id}`, source: 'user', scope: 'run', trust: 'user', retention: 'required' } }], turn: -1, costUsd: 0, toolResults: [] });
      return event;
    });
    this.publish(event);
    this.publish(this.env.store.runs.append(parent.id, 'child_created', { runId: child.id, objective: child.objective }));
    this.launch(child);
    const abort = () => this.active.get(id)?.abort.abort(execution.abort.signal.reason);
    execution.abort.signal.addEventListener('abort', abort, { once: true });
    if (execution.abort.signal.aborted) abort();
    try { await this.active.get(id)!.promise; }
    finally { execution.abort.signal.removeEventListener('abort', abort); this.env.store.runs.releaseChild(id); }
    const finished = this.get(id, tenant);
    return { runId: id, traceId: id, answer: finished.answer ?? '', cost: finished.cost, tokensIn: finished.tokensIn, tokensOut: finished.tokensOut, toolCalls: this.env.store.runs.toolCalls(id).length, error: finished.error ?? (finished.status === 'completed' ? undefined : `子任务状态: ${finished.status}`), cancelled: finished.status === 'cancelled' };
  }
  resume(id: string, tenant: string, principalRole?: RunRecord['principalRole']): RunRecord {
    const run = this.get(id, tenant);
    if (this.closing) throw new RunError(503, 'RUNTIME_STOPPING', '运行服务正在关闭');
    if (run.status !== 'interrupted') throw new RunError(409, 'RUN_NOT_RESUMABLE', '只有中断任务可以恢复');
    if (run.parentId) throw new RunError(409, 'CHILD_RESUME_REQUIRES_PARENT', '子任务由父任务管理，不能单独恢复');
    if (this.env.store.runs.active(tenant, run.sessionId).length)
      throw new RunError(409, 'SESSION_BUSY', '该会话已有活动任务');
    const cp = this.env.store.runs.checkpoint(id);
    if (!cp) throw new RunError(409, 'CHECKPOINT_MISSING', '任务没有可用断点');
    const descendants: RunRecord[] = [];
    const visit = (parent: string) => { for (const child of this.env.store.runs.children(parent, tenant)) { descendants.push(child); visit(child.id); } };
    visit(id);
    if ([run, ...descendants].some(task => this.env.store.hasPendingToolEffects(task.id)))
      throw new RunError(409, 'EFFECT_OUTCOME_UNKNOWN', '存在执行结果未知的操作，请先核对外部结果，不能自动重放');
    this.recoverCheckpoint(run, cp);
    const permission = this.env.store.runs.permission(tenant, this.env.workspace(tenant));
    // Recovery cannot expand the authorization snapshot, including after profile changes.
    run.authorization = { ...run.authorization, profile: run.authorization.profile === 'developer' ? permission.profile : 'standard', revision: permission.revision, readOnly: run.authorization.readOnly || principalRole === 'readonly' };
    if (principalRole) run.principalRole = principalRole;
    this.publish(this.env.store.runs.update(run, { status: 'queued', error: undefined }));
    this.launch(run);
    return run;
  }
  private launch(record: RunRecord): void {
    const abort = new AbortController();
    const promise = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(record, abort))
      .finally(() => { this.active.delete(record.id); this.env.activity?.(false); });
    this.active.set(record.id, { abort, promise, record });
    this.env.activity?.(true);
  }
  private recoverCheckpoint(run: RunRecord, cp: RunCheckpoint): void {
    const answered = new Set(cp.history.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    const missing = cp.history.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []).filter(call => !answered.has(call.id));
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
    const effect = pending.effectKey ? this.env.store.peekToolEffect(run.id, pending.effectKey) : undefined;
    if (effect?.state === 'pending') throw new RunError(409, 'EFFECT_OUTCOME_UNKNOWN', '操作执行结果未知，不能自动重放');
    if (effect?.state === 'done' && !effect.result) throw new RunError(409, 'CHECKPOINT_INCOMPLETE', '已完成操作缺少持久结果，不能自动重放');
    const recovered: { call: ToolCall; id: string; result: ToolResult }[] = missing.map((call, index) => ({
      call, id: index === 0 && pending.resultId ? pending.resultId : randomUUID(),
      result: index === 0 && effect?.state === 'done' && effect.result ? effect.result : { ok: false, error: '服务中断，此调用没有可用观察；有副作用的操作尚未开始。', failure: { code: 'TOOL_INTERRUPTED', retryable: true, outcome: 'not_started' } },
    }));
    const events = this.env.store.runs.transaction(() => {
      const repo = this.env.store.runs;
      const recorded = new Set((repo.toolCalls(run.id) as { id: string }[]).map(call => call.id));
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
    events.forEach(event => this.publish(event));
  }
  workspacePermission(tenant: string) {
    const workspace = this.env.workspace(tenant);
    return { workspace, ...this.env.store.runs.permission(tenant, workspace) };
  }
  setWorkspacePermission(tenant: string, profile: 'standard' | 'developer', revision: number) {
    const current = this.workspacePermission(tenant);
    if (current.revision !== revision) throw new RunError(409, 'PERMISSION_CONFLICT', '权限档已变化，请刷新后重试');
    if (this.env.store.runs.active(tenant).some(run => run.authorization.workspace === current.workspace || run.authorization.frameworkChangeId)) throw new RunError(409, 'WORKSPACE_BUSY', '请先停止工作区内的活动任务再修改权限');
    this.env.store.runs.setPermission(tenant, current.workspace, profile);
    return this.workspacePermission(tenant);
  }
  private async execute(record: RunRecord, abort: AbortController): Promise<void> {
    const repo = this.env.store.runs;
    let reasoning = '';
    try {
      if (abort.signal.aborted) return;
      const runner = this.env.runner();
      if (!runner) throw new Error('执行循环服务未加载');
      const cp = repo.checkpoint(record.id)!;
      const attemptId = randomUUID();
      let ownUsage = { cost: 0, input: 0, output: 0 };
      const options = this.env.prepare(record);
      if (record.instructions) options.contextMessages = [...(options.contextMessages ?? []), {
        role: 'user', content: record.instructions,
        context: { id: `delegation:${record.id}`, source: 'parent_agent', scope: 'run', trust: 'reference', retention: 'required' },
      }];
      if (record.toolNames) options.tools = (this.env.tools?.() ?? []).filter(tool => record.toolNames!.includes(tool.name));
      if (record.maxTurns !== undefined) options.maxTurns = record.maxTurns;
      const modelHistory = (history: LLMMessage[]) => {
        const result = [...history];
        const contextIds = new Set((options.contextMessages ?? []).flatMap(message => message.context?.id ? [message.context.id] : []));
        return result.filter(message => !(message.role === 'system' && message.context?.id === 'runtime' && message.context.source === 'runtime' && message.context.trust === 'core') && (!message.context?.id || !contextIds.has(message.context.id)));
      };
      const usagePatch = (cost: number, input: number, output: number) => {
        const current = repo.get(record.id, record.tenantId)!;
        const patch = { cost: current.cost + Math.max(0, cost - ownUsage.cost), tokensIn: current.tokensIn + Math.max(0, input - ownUsage.input), tokensOut: current.tokensOut + Math.max(0, output - ownUsage.output) };
        ownUsage = { cost: Math.max(cost, ownUsage.cost), input: Math.max(input, ownUsage.input), output: Math.max(output, ownUsage.output) };
        return patch;
      };
      const saveUsage = () => {
        if (record.usageMessageId) this.env.store.updateMessageStats(record.usageMessageId, { tokensIn: record.tokensIn, tokensOut: record.tokensOut, cost: record.cost, traceId: record.id });
      };
      let ancestorEvents: RunEvent[] = [];
      const publishUsage = (event: RunEvent) => {
        for (const ancestor of ancestorEvents) this.publish(ancestor);
        ancestorEvents = []; this.publish(event);
      };
      const accountUsage = (patch: Partial<RunRecord>, type: string, data: Record<string, unknown>): RunEvent => {
        const current = repo.get(record.id, record.tenantId)!;
        const delta = { cost: (patch.cost ?? current.cost) - current.cost, tokensIn: (patch.tokensIn ?? current.tokensIn) - current.tokensIn, tokensOut: (patch.tokensOut ?? current.tokensOut) - current.tokensOut };
        const event = repo.update(record, patch, type, data);
        for (const ancestorEvent of repo.accountAncestors(record, delta)) {
          ancestorEvents.push(ancestorEvent);
          const ancestor = repo.get(ancestorEvent.runId, record.tenantId)!;
          if (ancestor.usageMessageId) this.env.store.updateMessageStats(ancestor.usageMessageId, { tokensIn: ancestor.tokensIn, tokensOut: ancestor.tokensOut, cost: ancestor.cost, traceId: ancestor.id });
        }
        saveUsage(); return event;
      };
      this.publish(repo.update(record, { status: 'running' }));
      this.publish(repo.append(record.id, 'start', { traceId: record.id, runId: record.id }));
      let completed = false;
      for await (const event of runner.run({
        ...options, messages: modelHistory(cp.history), traceId: record.id, runId: record.id, executionId: record.id,
        sessionId: record.sessionId, tenantId: record.tenantId, principalRole: record.principalRole,
        parentRunId: record.parentId, parentStepId: record.parentStepId,
        authorization: record.authorization, sandboxRoot: record.authorization.workspace, signal: abort.signal,
        costBudget: record.budgetUsd === undefined ? undefined : Math.max(0, record.budgetUsd - record.cost),
        restoredCostUsd: record.cost, restoredToolResults: cp.toolResults, restoredEnabledTools: cp.enabledTools, turnOffset: cp.turn + 1,
        acquireExecution: signal => this.pool.acquire(record.rootId, signal),
        availableBudget: () => repo.availableBudget(record),
        delegate: request => this.delegate(record.id, record.tenantId, request),
        onModelInput: input => repo.saveModelInput(record.id, { ...input, diagnostics: { ...(input.diagnostics ?? describeModelInput(input.messages, input.tools, options.provider.tokenizer)), attemptId, resumedFromTurn: cp.turn } }),
        historyArchive: { save: history => repo.archiveHistory(record.id, modelHistory(history)), search: (query, offset, limit) => repo.searchHistory(record.id, query, offset, limit), read: (id, offset, limit) => repo.readHistory(record.id, id, offset, limit) },
        toolJournal: { start: (id, name, args) => repo.startTool(record.id, id, name, args), finish: (id, result) => repo.finishTool(record.id, id, result), read: (id, offset, limit) => repo.readTool(record.id, id, offset, limit) },
        task: record.acceptance?.length || record.deadlineAt ? { objective: record.objective, acceptance: record.acceptance ?? [], deadlineAt: record.deadlineAt } : undefined,
        effectJournal: { peek: key => this.env.store.peekToolEffect(record.id, key), claim: key => this.env.store.claimToolEffect(record.id, key), release: key => this.env.store.releaseToolEffect(record.id, key), complete: (key, result) => this.env.store.completeToolEffect(record.id, key, result) },
        takeMessages: (history, turn) => {
          const current: RunCheckpoint = { history: modelHistory(history), turn: cp.turn + turn, costUsd: record.cost, toolResults: repo.checkpoint(record.id)?.toolResults ?? [], enabledTools: repo.checkpoint(record.id)?.enabledTools };
          const events: RunEvent[] = [];
          const delivered = repo.transaction(() => {
            const messages = repo.deliverMessages(record.id, current);
            for (const message of messages) {
              this.env.store.addMessage({ sessionId: record.sessionId, role: 'user', content: message.content, traceId: record.id });
              events.push(repo.append(record.id, 'message_delivered', { id: message.id }));
            }
            return messages;
          });
          events.forEach(event => this.publish(event));
          return delivered.map(message => ({ role: 'user', content: message.content, context: { id: message.id, source: 'user-supplement', scope: 'run', trust: 'user', retention: 'required' } }));
        },
        onCheckpoint: (turn, history, evidence, step) => {
          repo.saveCheckpoint(record.id, { history: modelHistory(history), turn: step?.phase === 'tool_pending' ? turn - 1 : turn, costUsd: evidence?.costUsd ?? record.cost, toolResults: evidence?.toolResults ?? [], enabledTools: evidence?.enabledTools ?? repo.checkpoint(record.id)?.enabledTools, pending: step?.phase === 'tool_pending', pendingTool: step?.phase === 'tool_pending' ? step.pendingTool : undefined });
        },
        onUsage: usage => {
          const event = repo.transaction(() => {
            return accountUsage(usagePatch(usage.cost, usage.input, usage.output), 'usage', usage);
          });
          publishUsage(event);
        },
        onUsageStatus: status => {
          const rank = { reported: 0, estimated: 1, unknown: 2 };
          let current: RunRecord | undefined = record;
          while (current) {
            const existing = repo.get(current.id, current.tenantId)!;
            const usageStatus = existing.usageStatus && rank[existing.usageStatus] > rank[status] ? existing.usageStatus : status;
            this.publish(repo.update(current, { usageStatus }, 'usage_status', { status: usageStatus }));
            current = current.parentId ? repo.get(current.parentId, record.tenantId) : undefined;
          }
        },
      })) {
        if (record.status === 'waiting_approval' && event.type !== 'approval_required') this.publish(repo.update(record, { status: 'running' }));
        if (event.type === 'approval_required') this.publish(repo.update(record, { status: 'waiting_approval' }));
        if (event.type === 'reasoning') reasoning += event.text;
        if (event.type === 'assistant_done') {
          completed = true;
          const patch = usagePatch(event.cost, event.usage.input, event.usage.output);
          const persisted = repo.transaction(() => {
            if (!record.parentId) this.env.store.addMessage({ sessionId: record.sessionId, role: 'assistant', content: event.content, reasoning: event.reasoning || reasoning, traceId: record.id });
            return accountUsage({ answer: event.content, ...patch, status: 'completed' }, 'done', { ...event, cost: patch.cost, usage: { input: patch.tokensIn, output: patch.tokensOut } });
          });
          publishUsage(persisted);
        } else if (event.type === 'error') {
          record.error = event.error;
        } else if (event.type === 'task_verified' || event.type === 'task_partial' || event.type === 'task_failed') {
          record.verification = event;
        }
        if (event.type !== 'assistant_done') {
          const { type, ...data } = event;
          this.publish(repo.update(record, {}, type, data as unknown as Record<string, unknown>));
        }
      }
      if (!abort.signal.aborted) this.publish(repo.update(record, { status: completed ? 'completed' : 'interrupted' }));
    } catch (error) {
      if (!abort.signal.aborted) this.publish(repo.update(record, { status: 'failed', error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (abort.signal.aborted && record.status !== 'completed') this.publish(repo.update(record, { status: this.closing ? 'interrupted' : 'cancelled' }));
      this.env.store.touchSession(record.sessionId);
      if (!abort.signal.aborted) abort.abort('run_finished');
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const { abort } of this.active.values()) abort.abort('server_shutdown');
    await Promise.allSettled([...this.active.values()].map(execution => execution.promise));
  }
}
