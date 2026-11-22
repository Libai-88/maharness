import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recoverOrphanedApprovals } from '../approval-recovery';

describe('重启后的审批闭环', () => {
  it('未决审批标记过期，并对有 checkpoint 的会话排队一次 resume', () => {
    const rows = [
      { id: 'ap-1', sessionId: 's-1', tenantId: 'tenant-a' },
      { id: 'ap-2', sessionId: 's-1', tenantId: 'tenant-a' },
      { id: 'ap-3', sessionId: 's-2', tenantId: 'tenant-b' },
    ];
    const scheduled: { sessionId: string; tenantId: string; dueAt: number }[] = [];
    const store = {
      expireOrphanedApprovalRequests: () => rows.splice(0),
      loadCheckpoint: (sessionId: string) => (sessionId === 's-1' ? { messages: [] } : undefined),
    };
    const scheduler = {
      list: () => [],
      schedule: (input: { sessionId: string; tenantId: string; dueAt: number }) => {
        scheduled.push(input);
        return input;
      },
    };
    const result = recoverOrphanedApprovals(store, scheduler, 10_000);
    assert.deepEqual(result, { orphaned: 3, resumed: 1 });
    assert.deepEqual(scheduled, [{ sessionId: 's-1', tenantId: 'tenant-a', dueAt: 11_000 }]);
  });

  it('已有排队任务时不重复排队；无调度器时只做审计清理', () => {
    const store = {
      expireOrphanedApprovalRequests: () => [{ id: 'ap', sessionId: 's', tenantId: 'default' }],
      loadCheckpoint: () => ({ messages: [] }),
    };
    const queued = {
      list: () => [{ sessionId: 's', state: 'pending' }],
      schedule: () => {
        throw new Error('should not schedule');
      },
    };
    assert.deepEqual(recoverOrphanedApprovals(store, queued, 1), { orphaned: 1, resumed: 0 });
    assert.deepEqual(recoverOrphanedApprovals(store, undefined, 1), { orphaned: 1, resumed: 0 });
  });
});
