/** 租户级工具调用频率配额：进程内滑动 60 秒窗口；limit=0 表示不限制。 */

interface WindowState {
  startedAt: number;
  count: number;
}

const WINDOW_MS = 60_000;
const windows = new Map<string, WindowState>();

export class TenantToolQuotaError extends Error {
  readonly code = 'TENANT_TOOL_QUOTA' as const;
  readonly status = 429;
  readonly retryAfterMs: number;
  constructor(readonly limit: number, retryAfterMs: number) {
    super(`租户工具调用频率超限：每分钟上限 ${limit} 次，请 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`);
    this.name = 'TenantToolQuotaError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function assertTenantToolCall(tenantId: string, limit: number, now = Date.now()): void {
  if (!limit || limit <= 0 || !tenantId) return;
  const state = windows.get(tenantId);
  if (!state || now - state.startedAt >= WINDOW_MS) {
    windows.set(tenantId, { startedAt: now, count: 1 });
    return;
  }
  if (state.count >= limit) {
    throw new TenantToolQuotaError(limit, Math.max(0, state.startedAt + WINDOW_MS - now));
  }
  state.count++;
}

export function resetTenantToolLimit(tenantId: string): void {
  windows.delete(tenantId);
}

export function tenantToolCallCount(tenantId: string, now = Date.now()): number {
  const state = windows.get(tenantId);
  if (!state || now - state.startedAt >= WINDOW_MS) return 0;
  return state.count;
}
