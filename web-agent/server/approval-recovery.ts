/**
 * 重启后的审批闭环：审批板是内存态，进程重启后未决审批不再有等待者。
 * 先把它们审计为 expired:restart，再对有 checkpoint 的会话排一次 resume。
 */

export interface OrphanedApproval {
  id: string;
  sessionId: string;
  tenantId: string;
}

export interface ApprovalRecoveryStore {
  expireOrphanedApprovalRequests(now?: number): OrphanedApproval[];
  loadCheckpoint(sessionId: string): unknown;
}

export interface ApprovalRecoveryScheduler {
  list(tenantId?: string): { sessionId: string; state: string }[];
  schedule(input: { sessionId: string; tenantId: string; dueAt: number }): unknown;
}

export function recoverOrphanedApprovals(
  store: ApprovalRecoveryStore,
  scheduler: ApprovalRecoveryScheduler | undefined,
  now = Date.now(),
): { orphaned: number; resumed: number } {
  const rows = store.expireOrphanedApprovalRequests(now);
  if (!rows.length) return { orphaned: 0, resumed: 0 };
  const sessions = new Map<string, { sessionId: string; tenantId: string }>();
  for (const row of rows) {
    sessions.set(`${row.tenantId}\u0000${row.sessionId}`, { sessionId: row.sessionId, tenantId: row.tenantId });
  }
  let resumed = 0;
  if (scheduler) {
    for (const item of sessions.values()) {
      if (!store.loadCheckpoint(item.sessionId)) continue;
      const queued = scheduler.list(item.tenantId)
        .some((job) => job.sessionId === item.sessionId && (job.state === 'pending' || job.state === 'running'));
      if (queued) continue;
      scheduler.schedule({ sessionId: item.sessionId, tenantId: item.tenantId, dueAt: now + 1_000 });
      resumed++;
    }
  }
  return { orphaned: rows.length, resumed };
}
