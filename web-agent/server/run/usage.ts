// server/run/usage.ts —— 模型调用预算准入与用量记账（ADR 0008）
//
// 这块原先和"执行一次任务"的循环缠在一起，导致预算判断要读完整执行器才能确认。
// 现在收成一个对象：准入（父子预算预留）、用量增量、祖先传播、账单提示、用量状态降级。
import type { ExecutionPool } from '../../kernel/execution-pool';
import { ModelAdmissionError, type ModelCallScope } from '../../kernel/model-call';
import { describeModelInput } from '../../kernel/input-diagnostics';
import type { RunCheckpoint, RunEvent, RunRecord } from '../../kernel/run';
import type { TaskPluginSession } from '../../kernel/task-plugins';
import type { RunEnvironment } from '../run-types';

type RunStore = RunEnvironment['store']['runs'];
type Usage = { cost: number; input: number; output: number };

export interface AccountDeps {
  readonly repo: RunStore;
  readonly store: RunEnvironment['store'];
  readonly record: RunRecord;
  readonly publish: (event: RunEvent) => void;
  readonly modelPool: ExecutionPool;
  readonly checkpoint: () => RunCheckpoint;
  readonly attemptId: string;
  /** 当前输入轮次：循环里的 onModelInput 会更新它，模型输入记录用它兜底。 */
  readonly turn: { current: number };
  readonly plugins: () => TaskPluginSession | undefined;
  readonly signal: AbortSignal;
}

export class RunAccount {
  // 增量记账：回调上报的是"累计值"，这里记住已计入的部分，避免重复计费
  private ownUsage: Usage = { cost: 0, input: 0, output: 0 };
  private ancestorEvents: RunEvent[] = [];
  private ledgerManaged = false;

  constructor(private readonly deps: AccountDeps) {}

  /** 由模型调用账本接管记账后，执行循环不再按事件里的用量累计。 */
  get managed(): boolean {
    return this.ledgerManaged;
  }

  setTurn(turn: number): void {
    this.deps.turn.current = turn;
  }

  /** 把"累计用量"折算成本次增量，返回要写入 RunRecord 的补丁。 */
  patch(cost: number, input: number, output: number): Partial<RunRecord> {
    const current = this.deps.repo.get(this.deps.record.id, this.deps.record.tenantId)!;
    const patch = {
      cost: current.cost + Math.max(0, cost - this.ownUsage.cost),
      tokensIn: current.tokensIn + Math.max(0, input - this.ownUsage.input),
      tokensOut: current.tokensOut + Math.max(0, output - this.ownUsage.output),
    };
    this.ownUsage = {
      cost: Math.max(cost, this.ownUsage.cost),
      input: Math.max(input, this.ownUsage.input),
      output: Math.max(output, this.ownUsage.output),
    };
    return patch;
  }

  /** 会话里的用户消息也要带上用量，否则会话列表与任务详情会各说各话。 */
  saveUsage(): void {
    const record = this.deps.record;
    if (record.usageMessageId)
      this.deps.store.updateMessageStats(record.usageMessageId, {
        tokensIn: record.tokensIn,
        tokensOut: record.tokensOut,
        cost: record.cost,
        traceId: record.id,
      });
  }

  /** 写记录 + 向祖先传播增量；祖先事件先进缓冲，由 publishUsage 统一广播。 */
  account(patch: Partial<RunRecord>, type: string, data: Record<string, unknown>): RunEvent {
    const repo = this.deps.repo;
    const record = this.deps.record;
    const current = repo.get(record.id, record.tenantId)!;
    const delta = {
      cost: (patch.cost ?? current.cost) - current.cost,
      tokensIn: (patch.tokensIn ?? current.tokensIn) - current.tokensIn,
      tokensOut: (patch.tokensOut ?? current.tokensOut) - current.tokensOut,
    };
    const event = repo.update(record, patch, type, data);
    for (const ancestorEvent of repo.accountAncestors(record, delta)) {
      this.ancestorEvents.push(ancestorEvent);
      const ancestor = repo.get(ancestorEvent.runId, record.tenantId)!;
      if (ancestor.usageMessageId)
        this.deps.store.updateMessageStats(ancestor.usageMessageId, {
          tokensIn: ancestor.tokensIn,
          tokensOut: ancestor.tokensOut,
          cost: ancestor.cost,
          traceId: ancestor.id,
        });
    }
    this.saveUsage();
    return event;
  }

  /** 先播祖先事件，再播本事件：父任务的总用量必须在子任务事件之前对外可见。 */
  publishUsage(event: RunEvent): void {
    for (const ancestor of this.ancestorEvents) this.deps.publish(ancestor);
    this.ancestorEvents = [];
    this.deps.publish(event);
  }

  recordUsage(usage: Usage): void {
    if (this.ledgerManaged) return;
    const event = this.deps.repo.transaction(() => this.account(this.patch(usage.cost, usage.input, usage.output), 'usage', usage));
    this.publishUsage(event);
  }

  recordUsageStatus(status: 'reported' | 'estimated' | 'unknown'): void {
    const repo = this.deps.repo;
    const record = this.deps.record;
    const rank = { reported: 0, estimated: 1, unknown: 2 };
    let current: RunRecord | undefined = record;
    while (current) {
      const existing = repo.get(current.id, current.tenantId)!;
      const usageStatus = existing.usageStatus && rank[existing.usageStatus] > rank[status] ? existing.usageStatus : status;
      this.deps.publish(repo.update(current, { usageStatus }, 'usage_status', { status: usageStatus }));
      current = current.parentId ? repo.get(current.parentId, record.tenantId) : undefined;
    }
  }

  /**
   * 模型调用作用域：准入在发请求前原子完成（预留父子预算），完成时把用量写回并传播。
   * 这里对"预算必须能可靠预留"的要求是硬的：硬预算模式下无法预留就拒绝调用，而不是先花钱再核账。
   */
  scope(): ModelCallScope {
    const { repo, record, signal } = this.deps;
    return {
      runId: record.id,
      rootId: record.rootId,
      parentRunId: record.parentId,
      signal,
      ...(record.cachePrefixHash ? { cachePrefixHash: record.cachePrefixHash } : {}),
      acquire: (acquireSignal) => this.deps.modelPool.acquire(record.rootId, acquireSignal),
      admit: (call) => {
        if (record.budgetPolicy !== 'enforce') return;
        if (call.reservedCost === undefined)
          throw new ModelAdmissionError('无法在显式硬预算内可靠预留本次模型调用；请核对价格与计费能力，或由用户选择费用提醒模式');
        let bounded: RunRecord | undefined = repo.get(record.id, record.tenantId)!;
        while (bounded) {
          if (bounded.budgetUsd !== undefined && bounded.cost + repo.modelReservations(bounded) + call.reservedCost > bounded.budgetUsd)
            throw new ModelAdmissionError('本次模型调用超出任务或祖先任务的显式硬预算');
          if (
            bounded.budgetTokens !== undefined &&
            bounded.tokensIn + bounded.tokensOut + repo.modelTokenReservations(bounded) + (call.reservedTokens ?? 0) > bounded.budgetTokens
          )
            throw new ModelAdmissionError('本次模型调用超出任务或祖先任务的 token 硬预算');
          bounded = bounded.parentId ? repo.get(bounded.parentId, record.tenantId) : undefined;
        }
      },
      start: (call) => {
        this.ledgerManaged = true;
        repo.transaction(() => {
          repo.startModelCall(call);
          this.deps.publish(
            repo.append(record.id, 'model_call_started', {
              callId: call.id,
              purpose: call.purpose,
              providerId: call.providerId,
              model: call.model,
            }),
          );
        });
      },
      input: (call, messages, tools, tokenizer) =>
        repo.saveModelInput(record.id, {
          turn: call.turn ?? this.deps.turn.current,
          providerId: call.providerId,
          model: call.model,
          messages,
          tools: tools ?? [],
          callId: call.id,
          purpose: call.purpose,
          diagnostics: {
            ...describeModelInput(messages, tools ?? [], tokenizer),
            capabilityRevision: this.deps.plugins()?.revision(),
            attemptId: this.deps.attemptId,
            resumedFromTurn: this.deps.checkpoint().turn,
          },
        }),
      finish: (call) => {
        const events = repo.transaction(() => {
          if (!repo.finishModelCall(call)) return [];
          const current = repo.get(record.id, record.tenantId)!;
          const delta = {
            cost: call.cost ?? 0,
            tokensIn: call.input ?? 0,
            tokensOut: call.output ?? 0,
            ...(call.cachedInput !== undefined ? { tokensCached: call.cachedInput } : {}),
            ...(call.missInput !== undefined ? { tokensCacheMiss: call.missInput } : {}),
            ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
          };
          const unknown = call.usageStatus === 'unknown' || call.cost === undefined;
          const usageStatus =
            current.usageStatus === 'unknown' || unknown
              ? ('unknown' as const)
              : current.usageStatus === 'estimated' || call.usageStatus === 'estimated'
                ? ('estimated' as const)
                : ('reported' as const);
          const billingNotice = unknown
            ? '部分模型调用的用量或价格尚未确认，请在任务结束后核对。'
            : current.budgetUsd !== undefined && current.cost + delta.cost > current.budgetUsd
              ? '任务费用已超过提醒额度，请核对本次用量。'
              : current.billingNotice;
          const event = repo.update(
            record,
            {
              cost: current.cost + delta.cost,
              tokensIn: current.tokensIn + delta.tokensIn,
              tokensOut: current.tokensOut + delta.tokensOut,
              ...(delta.tokensCached !== undefined ? { tokensCached: (current.tokensCached ?? 0) + delta.tokensCached } : {}),
              ...(delta.tokensCacheMiss !== undefined ? { tokensCacheMiss: (current.tokensCacheMiss ?? 0) + delta.tokensCacheMiss } : {}),
              ...(delta.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: (current.cacheWriteTokens ?? 0) + delta.cacheWriteTokens }
                : {}),
              usageStatus,
              billingNotice,
            },
            'model_call_finished',
            {
              callId: call.id,
              purpose: call.purpose,
              status: call.status,
              usageStatus,
              cost: call.cost,
              cachedInput: call.cachedInput,
              missInput: call.missInput,
              cacheWriteTokens: call.cacheWriteTokens,
              cachePrefixHash: call.cachePrefixHash,
            },
          );
          this.saveUsage();
          const ancestorEvents = repo.accountAncestors(record, delta);
          for (const ancestorEvent of [...ancestorEvents]) {
            const ancestor = repo.get(ancestorEvent.runId, record.tenantId)!;
            if (ancestor.usageMessageId)
              this.deps.store.updateMessageStats(ancestor.usageMessageId, {
                tokensIn: ancestor.tokensIn,
                tokensOut: ancestor.tokensOut,
                cost: ancestor.cost,
                traceId: ancestor.id,
              });
            if (unknown || (ancestor.budgetUsd !== undefined && ancestor.cost > ancestor.budgetUsd))
              ancestorEvents.push(
                repo.update(
                  ancestor,
                  {
                    usageStatus: unknown ? 'unknown' : ancestor.usageStatus,
                    billingNotice: unknown ? '子任务存在待核对的模型用量或价格。' : '任务费用已超过提醒额度，请核对本次用量。',
                  },
                  'billing_notice',
                  {},
                ),
              );
          }
          return [event, ...ancestorEvents];
        });
        for (const event of events) this.deps.publish(event);
      },
    };
  }
}
