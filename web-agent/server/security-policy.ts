import type { Kernel } from '../kernel';
import type { Store } from './db';

export type AuthorizationDenialReason = 'api-token-required' | 'api-token-invalid'
  | 'approval-token-required' | 'approval-token-invalid' | 'source-host-denied' | 'source-origin-denied';

export interface AuthorizationDenial {
  subject: 'anonymous';
  capability: string;
  object: string;
  reason: AuthorizationDenialReason;
}

export interface AuthorizationGrant {
  subject: 'api-token' | 'approval-token' | 'local-client';
  capability: string;
  object: string;
}

export type CredentialPolicyReason = 'required' | 'invalid';

export class CredentialFailureLimiter {
  private readonly failures = new Map<string, { count: number; windowStartedAt: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly lockMs = 60_000,
    private readonly maxEntries = 1024,
  ) {}

  retryAfterMs(key: string, now = Date.now()): number {
    const state = this.failures.get(key);
    if (!state) return 0;
    if (state.lockedUntil > now) return state.lockedUntil - now;
    if (now - state.windowStartedAt >= this.windowMs || state.lockedUntil > 0) {
      this.failures.delete(key);
    }
    return 0;
  }

  recordFailure(key: string, now = Date.now()): number {
    const remaining = this.retryAfterMs(key, now);
    if (remaining > 0) return remaining;
    let state = this.failures.get(key);
    if (!state || now - state.windowStartedAt >= this.windowMs) {
      state = { count: 0, windowStartedAt: now, lockedUntil: 0 };
    }
    state.count++;
    if (state.count >= this.maxFailures) state.lockedUntil = now + this.lockMs;
    this.failures.delete(key);
    this.failures.set(key, state);
    while (this.failures.size > this.maxEntries) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
    return this.retryAfterMs(key, now);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}

/** Shared credential gate used by HTTP mutations and approval responses. */
export function decideCredentialAuthorization(input: {
  enabled: boolean;
  supplied: boolean;
  valid: boolean;
}): { allowed: true } | { allowed: false; reason: CredentialPolicyReason } {
  if (!input.supplied) {
    return input.enabled ? { allowed: false, reason: 'required' } : { allowed: true };
  }
  return input.valid ? { allowed: true } : { allowed: false, reason: 'invalid' };
}

/** Emit an authorization audit record containing route metadata only, never request credentials or payloads. */
function persistAudit(store: Store | undefined, entry: {
  outcome: 'granted' | 'denied' | 'connected' | 'disconnected';
  subject: string; capability: string; object: string; reason: string | null;
}): void {
  try { store?.appendAuthorizationAudit(entry); }
  catch (error) { console.error('[security-audit] 授权审计写入失败:', error); }
}

export function auditAuthorizationDenial(kernel: Kernel, denial: AuthorizationDenial, store?: Store): void {
  persistAudit(store, { ...denial, outcome: 'denied', reason: denial.reason });
  kernel.bus.emit({
    type: 'security.authorization.denied',
    ts: Date.now(),
    data: denial,
  });
}

export function auditAuthorizationGrant(kernel: Kernel, grant: AuthorizationGrant, store?: Store): void {
  persistAudit(store, { ...grant, outcome: 'granted', reason: null });
  kernel.bus.emit({
    type: 'security.authorization.granted',
    ts: Date.now(),
    data: grant,
  });
}

export function auditSseLifecycle(kernel: Kernel, store: Store | undefined, state: 'connected' | 'disconnected'): void {
  const data = { subject: 'local-client' as const, capability: 'sse:events', object: '/api/events' };
  persistAudit(store, { ...data, outcome: state, reason: null });
  kernel.bus.emit({ type: `security.sse.${state}`, ts: Date.now(), data });
}
