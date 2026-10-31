/**
 * core/chat/provider-health.ts —— Provider 健康追踪（failover 耗尽前可见）
 * agent 每次真实调用成功/失败都回报到这里：
 *   - 失败：按 HTTP 状态码归类，401/403 才是「密钥/权限失效」（重试不可救，需人工换 key）
 *   - 成功：清除该 provider 的异常状态（key 换好后自动恢复）
 * 状态经 /api/providers 暴露给前端（设置页红标 + 会话横幅），不等整条 failover 链耗尽才被发现。
 *
 * 本模块同时是「失败分类」的唯一裁判（三个错误类型 + isAbortError 都从这里出）：
 * 用户主动停止（AbortError / TaskStoppedError）不是 provider 的错——一旦误记，
 * 前端会在用户按下「停止」后看到「密钥失效，请更新密钥」的红标，并触发无谓的
 * failover（继续计费）。见 noteProviderFailure 的 abort 短路。
 */

/** 上游 Retry-After 可影响重试等待，但不能让不受信任的响应把执行器永久挂起。 */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000)) : undefined;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now));
}

/** 带 HTTP 状态码的 LLM 请求失败：让「401/403 需要人工换 key」按状态码判定，而不是猜错误文本 */
export class LLMHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LLMHttpError';
    this.status = status;
    if (Number.isFinite(retryAfterMs) && retryAfterMs! >= 0) this.retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, retryAfterMs!);
  }
}

/** 任务被停止（客户端 abort / 用户点停止 / 审批等到取消）——必须与"请求失败"严格区分 */
export class TaskStoppedError extends Error {
  constructor(message = '已停止') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 是否"取消类"错误：用户主动停止、AbortController 掐断、连接因取消而断 */
export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof TaskStoppedError) return true;
  const name = error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : String(error);
  return name === 'AbortError' || /\babort(ed)?\b|用户停止|已停止|signal aborted|This operation was aborted/i.test(msg);
}

export interface ProviderHealth {
  /** 连续失败次数（成功后清零） */
  failures: number;
  /** 连续瞬时故障次数；认证/参数/业务故障不会污染熔断阈值。 */
  transientFailures?: number;
  /** 401/403：密钥无效/无权限——人工修复类故障 */
  authFailed: boolean;
  /** 最近一次错误摘要（截断） */
  lastError: string;
  lastErrorAt: number;
  /** 瞬时故障达到阈值后的熔断打开时刻；0/undefined 表示未熔断。 */
  circuitOpenedAt?: number;
  /** 本次熔断冷却结束时刻；仅用于诊断，不含凭据。 */
  circuitResetAt?: number;
}

export const PROVIDER_CIRCUIT_THRESHOLD = 3;
export const PROVIDER_CIRCUIT_RESET_MS = 60_000;
export interface ProviderCircuitConfig {
  threshold?: number;
  resetMs?: number;
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof LLMHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|连接.*超时|连接.*断/i.test(message);
}

import { sharedSingleton } from '../../kernel/shared';

/** providerId → 健康状态。经 sharedSingleton 取（缺陷 B13）：
 *  agent 在快照副本里记账、`server/routes/providers.ts` import 的是活目录——
 *  两份 Map 会让「密钥失效」红标与恢复广播永远看不见真实故障。 */
const health = sharedSingleton('chat.providerHealth', () => new Map<string, ProviderHealth>());

/** 判断错误是否为认证/权限类（401/403）——重试与 failover 都救不了，需要人工换 key。
 *  优先看 LLMHttpError.status（provider.ts 抛出时携带），文本正则仅作兜底：
 *  纯靠 `/\b(401|403)\b/` 猜文本会把「token 数 4031」「超时 403ms」甚至被停止的请求误判成密钥失效。 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof LLMHttpError) return error.status === 401 || error.status === 403;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /\b(?:HTTP|status|请求失败|:)\s*(401|403)\b/.test(msg) || /authentication|unauthorized|invalid api key|no access to model/i.test(msg);
}

/** 记录一次失败（agent failover 链上每个耗尽重试的 provider 都回报）。
 *  取消类错误一律不记账：用户按「停止」不该让某个 provider 背上"密钥失效"的红标。 */
export function noteProviderFailure(providerId: string, error: unknown, config: ProviderCircuitConfig = {}): ProviderHealth | undefined {
  if (isAbortError(error)) return health.get(providerId);
  const msg = (error instanceof Error ? error.message : String(error ?? '')).slice(0, 200);
  const prev = health.get(providerId);
  const next: ProviderHealth = {
    failures: (prev?.failures ?? 0) + 1,
    transientFailures: isTransientFailure(error) ? (prev?.transientFailures ?? 0) + 1 : 0,
    authFailed: (prev?.authFailed ?? false) || isAuthError(error),
    lastError: msg,
    lastErrorAt: Date.now(),
  };
  const threshold = Math.max(1, Math.floor(config.threshold ?? PROVIDER_CIRCUIT_THRESHOLD));
  const resetMs = Math.max(1_000, Math.floor(config.resetMs ?? PROVIDER_CIRCUIT_RESET_MS));
  if (isTransientFailure(error) && (next.transientFailures ?? 0) >= threshold) {
    next.circuitOpenedAt = prev?.circuitOpenedAt || next.lastErrorAt;
    next.circuitResetAt = next.circuitOpenedAt + resetMs;
  }
  health.set(providerId, next);
  return next;
}


/** 记录一次成功：清除异常状态；返回是否清除了已有故障（供 agent 决定是否广播恢复） */
export function noteProviderSuccess(providerId: string): boolean {
  const had = health.get(providerId);
  if (!had) return false;
  health.delete(providerId);
  return true;
}

/** 熔断打开期间拒绝新的 Provider 请求；冷却到期放行一次半开探测。 */
export function isProviderCircuitOpen(providerId: string, now = Date.now()): boolean {
  const current = health.get(providerId);
  if (!current?.circuitResetAt) return false;
  if (now < current.circuitResetAt) return true;
  health.set(providerId, { ...current, transientFailures: 0, circuitOpenedAt: undefined, circuitResetAt: undefined });
  return false;
}

export function getProviderHealth(providerId: string): ProviderHealth | undefined {
  return health.get(providerId);
}
