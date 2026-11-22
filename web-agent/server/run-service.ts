import type { Session } from '../kernel/types';
import { RUN_TERMINAL, type RunEvent, type RunRecord } from '../kernel/run';
import type { ModelCallScope } from '../kernel/model-call';

import { ACTIVE_RUN_STATES } from './run-store';
import { ExecutionPool } from '../kernel/execution-pool';
import type { ChildRunRequest, ChildRunResult } from '../kernel/run';
import type { PluginDevelopmentGrant } from '../kernel/task-plugins';
import type { AssignmentContract, OrganizationRole, SocietySchedule, SocietyScheduleAssignment, SocietyTask } from './organization-store';
// 运行环境与错误类型拆到 run-types.ts（P2-5）：host 装配方只依赖契约，不必拖上整个执行器
export { RunError, type RunEnvironment } from './run-types';
import { RunError, type OrganizationRunBinding, type RunEnvironment } from './run-types';
// 执行循环、断点恢复、事件发布与用量记账各自成模块（ADR 0008），本文件只做门面
import { createRun } from './run/create';
import { delegateRun } from './run/delegate';
import { startSocietyAssignment } from './run/society';
import { RunJournal } from './run/journal';
import { recoverCheckpoint, resumeChildren } from './run/recovery';
import { executeRun, type ExecutorRuntime } from './run/executor';

/** Owns executions; HTTP connections are independent readers of the event journal. */
export class RunService {
  readonly active = new Map<string, { abort: AbortController; promise: Promise<void>; record: RunRecord }>();
  readonly journal: RunJournal;
  closing = false;
  readonly pool: ExecutionPool;
  readonly modelPool: ExecutionPool;
  readonly maintenanceAbort = new AbortController();
  maintenanceCleanup?: () => void;
  readonly maintenancePending = new Map<string, { promise: Promise<void>; resolve(): void }>();
  constructor(readonly env: RunEnvironment) {
    env.store.runs.interruptActive();
    this.pool = new ExecutionPool(env.executionSlots ?? 16);
    this.modelPool = new ExecutionPool(env.executionSlots ?? 16);
    // 广播前刷新活动记录快照：订阅者看到的事件与记录必须同源
    this.journal = new RunJournal((event) => {
      const active = this.active.get(event.runId);
      if (active) Object.assign(active.record, this.env.store.runs.get(event.runId, active.record.tenantId));
    });
    env.plugins?.attach({
      get: (id) => env.store.runs.plugins(id),
      put: (id, bindings) => env.store.runs.putPlugins(id, bindings),
      workspace: (tenant, workspace) => env.store.runs.workspacePlugins(tenant, workspace),
      save: (tenant, workspace, binding) => env.store.runs.saveWorkspacePlugin(tenant, workspace, binding),
      event: (id, type, data) => this.publish(env.store.runs.append(id, type, data)),
    });
  }

  maintenanceScope(): ModelCallScope {
    return {
      runId: '',
      signal: this.maintenanceAbort.signal,
      acquire: (signal) => this.modelPool.acquire('maintenance', signal),
      start: (call) => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        this.maintenancePending.set(call.id, { promise, resolve });
        this.env.store.runs.startModelCall(call);
      },
      finish: (call) => {
        try {
          this.env.store.runs.finishModelCall(call);
        } finally {
          this.maintenancePending.get(call.id)?.resolve();
          this.maintenancePending.delete(call.id);
        }
      },
    };
  }
  attachMaintenance(cleanup: () => void): void {
    this.maintenanceCleanup = cleanup;
  }

  publish(event: RunEvent): void {
    this.journal.publish(event);
  }
  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    return this.journal.subscribe(id, listener);
  }

  get(id: string, tenant: string): RunRecord {
    const record = this.env.store.runs.get(id, tenant);
    if (!record) throw new RunError(404, 'RUN_NOT_FOUND', '任务不存在');
    return record;
  }
  create(
    session: Session,
    input: {
      message: string;
      reworkOfRunId?: string;
      materials?: import('../kernel/material').MaterialRef[];
      provider?: string;
      model?: string;
      requestKey?: string;
      budgetUsd?: number;
      budgetTokens?: number;
      budgetPolicy?: 'advisory' | 'enforce';
      deadlineAt?: number;
      acceptance?: RunRecord['acceptance'];
      principalRole?: RunRecord['principalRole'];
      frameworkChange?: { id: string; workspace: string };
      origin?: RunRecord['origin'];
      projectId?: string;
      instructions?: string;
      toolNames?: string[];
      authorization?: { workspace: string; readOnly: boolean; profile: 'standard' | 'developer' };
      organizationBinding?: OrganizationRunBinding;
    },
  ): RunRecord {
    return createRun(this, session, input);
  }

  startSocietyAssignment(input: {
    task: SocietyTask;
    schedule: SocietySchedule;
    role: OrganizationRole;
    contract: AssignmentContract;
    assignment?: SocietyScheduleAssignment;
  }): RunRecord {
    return startSocietyAssignment(this, input);
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
  cancel(id: string, tenant: string, pause = false): RunRecord {
    const run = this.get(id, tenant);
    if (RUN_TERMINAL.has(run.status)) return run;
    this.publish(this.env.store.runs.update(run, { status: 'stopping' }));
    const active = this.active.get(id);
    if (active) active.abort.abort(pause ? 'user_pause' : 'user_cancel');
    else this.publish(this.env.store.runs.update(run, { status: pause ? 'interrupted' : 'cancelled' }));
    for (const child of this.env.store.runs.children(id, tenant)) if (!RUN_TERMINAL.has(child.status)) this.cancel(child.id, tenant, pause);
    return run;
  }
  async delegate(parentId: string, tenant: string, request: ChildRunRequest, signal?: AbortSignal): Promise<ChildRunResult> {
    return delegateRun(this, parentId, tenant, request, signal);
  }
  resume(id: string, tenant: string, principalRole?: RunRecord['principalRole']): RunRecord {
    const run = this.get(id, tenant);
    if (this.closing) throw new RunError(503, 'RUNTIME_STOPPING', '运行服务正在关闭');
    if (run.materials?.length)
      this.env.store.materials.validate(
        run.materials,
        tenant,
        run.authorization.workspace,
        this.env.projectRoot ?? run.authorization.workspace,
      );
    if (run.status !== 'interrupted') throw new RunError(409, 'RUN_NOT_RESUMABLE', '只有中断任务可以恢复');
    if (run.parentId) throw new RunError(409, 'CHILD_RESUME_REQUIRES_PARENT', '子任务由父任务管理，不能单独恢复');
    if (this.env.store.runs.active(tenant, run.sessionId).length) throw new RunError(409, 'SESSION_BUSY', '该会话已有活动任务');
    const cp = this.env.store.runs.checkpoint(id);
    if (!cp) throw new RunError(409, 'CHECKPOINT_MISSING', '任务没有可用断点');
    if (run.deadlineAt !== undefined && run.deadlineAt <= Date.now())
      throw new RunError(409, 'DEADLINE_EXCEEDED', '原任务截止时间已过，请检查草稿并发起新任务继续');
    if (run.budgetPolicy === 'enforce' && this.env.store.runs.availableBudget(run) === 0)
      throw new RunError(409, 'BUDGET_EXHAUSTED', '任务剩余额度不足，请检查草稿并在明确预算后发起新任务');
    const limit = run.maxTurns ?? this.env.prepare(run).maxTurns ?? 30;
    if (cp.turn + 1 >= limit) throw new RunError(409, 'TURN_LIMIT_REACHED', '任务轮数已耗尽，请检查草稿并发起新任务继续');
    const descendants: RunRecord[] = [];
    const visit = (parent: string) => {
      for (const child of this.env.store.runs.children(parent, tenant)) {
        descendants.push(child);
        visit(child.id);
      }
    };
    visit(id);
    if ([run, ...descendants].some((task) => this.env.store.hasPendingToolEffects(task.id)))
      throw new RunError(409, 'EFFECT_OUTCOME_UNKNOWN', '存在执行结果未知的操作，请先核对外部结果，不能自动重放');
    recoverCheckpoint(this.runtime(), run, cp);
    const permission = this.env.store.runs.permission(tenant, this.env.workspace(tenant));
    const grant = this.env.store.runs.pluginGrant(tenant, this.env.workspace(tenant));
    const previous = run.authorization.pluginDevelopment;
    run.authorization.pluginDevelopment = previous
      ? {
          enabled: previous.enabled && grant.enabled,
          permissions: previous.permissions.filter((p) => grant.permissions.includes(p)),
          dependencies: previous.dependencies.filter((p) => grant.dependencies.includes(p)),
        }
      : undefined;
    // Recovery cannot expand the authorization snapshot, including after profile changes.
    run.authorization = {
      ...run.authorization,
      profile: run.authorization.profile === 'developer' ? permission.profile : 'standard',
      revision: permission.revision,
      readOnly: run.authorization.readOnly || principalRole === 'readonly',
    };
    if (principalRole) run.principalRole = principalRole;
    this.publish(this.env.store.runs.update(run, { status: 'queued', error: undefined, problem: undefined }));
    this.launch(run, true);
    return run;
  }

  launch(record: RunRecord, resumed = false): void {
    const abort = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const watchDeadline = () => {
      if (record.deadlineAt === undefined) return;
      const remaining = record.deadlineAt - Date.now();
      if (remaining <= 0) {
        abort.abort('deadline_exceeded');
        return;
      }
      deadlineTimer = setTimeout(watchDeadline, Math.min(remaining, 2_147_483_647));
      deadlineTimer.unref?.();
    };
    watchDeadline();
    const promise = new Promise<void>((done) => setImmediate(done))
      .then(() => executeRun(this.runtime(), record, abort, resumed))
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (this.active.get(record.id)?.abort === abort) this.active.delete(record.id);
        this.env.activity?.(false);
      });
    this.active.set(record.id, { abort, promise, record });
    this.env.activity?.(true);
  }

  workspacePermission(tenant: string) {
    const workspace = this.env.workspace(tenant);
    return {
      workspace,
      ...this.env.store.runs.permission(tenant, workspace),
      pluginDevelopment: this.env.store.runs.pluginGrant(tenant, workspace),
    };
  }
  setPluginDevelopment(tenant: string, grant: PluginDevelopmentGrant, revision: number) {
    const current = this.workspacePermission(tenant);
    if (current.revision !== revision) throw new RunError(409, 'PERMISSION_CONFLICT', '权限已变化，请刷新');
    if (this.env.store.runs.active(tenant).length) throw new RunError(409, 'WORKSPACE_BUSY', '请先停止活动任务');
    this.env.store.runs.transaction(() => {
      this.env.store.runs.setPluginGrant(tenant, current.workspace, grant);
      this.env.store.runs.setPermission(tenant, current.workspace, current.profile);
    });
    return this.workspacePermission(tenant);
  }
  setWorkspacePermission(tenant: string, profile: 'standard' | 'developer', revision: number) {
    const current = this.workspacePermission(tenant);
    if (current.revision !== revision) throw new RunError(409, 'PERMISSION_CONFLICT', '权限档已变化，请刷新后重试');
    if (
      this.env.store.runs
        .active(tenant)
        .some((run) => run.authorization.workspace === current.workspace || run.authorization.frameworkChangeId)
    )
      throw new RunError(409, 'WORKSPACE_BUSY', '请先停止工作区内的活动任务再修改权限');
    this.env.store.runs.setPermission(tenant, current.workspace, profile);
    return this.workspacePermission(tenant);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.maintenanceAbort.abort();
    this.maintenanceCleanup?.();
    for (const { abort } of this.active.values()) abort.abort('server_shutdown');
    await Promise.allSettled([...this.active.values()].map((execution) => execution.promise));
    await Promise.allSettled([...this.maintenancePending.values()].map((call) => call.promise));
  }

  /** 执行器/恢复器需要的显式运行时：门面持有的状态从这里交给模块，模块不反向 import 门面。 */
  runtime(): ExecutorRuntime {
    return {
      env: this.env,
      pool: this.pool,
      modelPool: this.modelPool,
      publish: (event) => this.journal.publish(event),
      launch: (record, resumed) => this.launch(record, resumed),
      execution: (id) => this.active.get(id),
      isClosing: () => this.closing,
      delegate: (parentId, tenant, request, signal) => this.delegate(parentId, tenant, request, signal),
      resumeChildren: (parent, signal) => resumeChildren(this.runtime(), parent, signal),
    };
  }
}
