/**
 * core/mcp/health.ts —— MCP server 熔断与健康快照
 *
 * 外部 server 的失败有两种：偶发失败（应重试）与持续失败（应快速失败）。
 * 没有熔断时，每个工具调用都要等满超时才拿到同一个错误；在 Agent 循环里
 * 这会把一次故障放大成多次长尾等待。这里按 server 维度记录连续失败，
 * 达到阈值后进入冷却期，冷却结束只放行一个探测请求：
 * 成功即闭合，失败则重新打开。
 */

export type McpCircuitState = 'closed' | 'open' | 'half-open';

export interface McpHealthSnapshot {
  state: McpCircuitState;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  lastError?: string;
  lastDurationMs?: number;
  retryAfterMs?: number;
  failureThreshold: number;
  cooldownMs: number;
}

export interface McpCircuitOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

export class McpCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private calls = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private lastError?: string;
  private lastDurationMs?: number;
  private openedUntil = 0;
  private probing = false;

  constructor(opts: McpCircuitOptions = {}) {
    this.failureThreshold = Math.max(1, Math.trunc(opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
    this.cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.max(1_000, Math.trunc(opts.cooldownMs ?? DEFAULT_COOLDOWN_MS)));
    this.now = opts.now ?? Date.now;
  }

  /** 调用前准入：返回错误文案表示应快速失败；undefined 表示放行。 */
  allow(): string | undefined {
    const now = this.now();
    if (!this.openedUntil) return undefined;
    if (now < this.openedUntil) {
      const seconds = Math.max(1, Math.ceil((this.openedUntil - now) / 1000));
      return `MCP server 熔断中（连续失败 ${this.consecutiveFailures} 次），${seconds} 秒后重试`;
    }
    if (this.probing) return 'MCP server 半开探测进行中，请稍后重试';
    this.probing = true;
    return undefined;
  }

  success(durationMs?: number): void {
    this.calls++;
    this.consecutiveFailures = 0;
    this.openedUntil = 0;
    this.probing = false;
    if (durationMs !== undefined) this.lastDurationMs = durationMs;
  }

  failure(err: unknown, durationMs?: number): void {
    this.calls++;
    this.failures++;
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (durationMs !== undefined) this.lastDurationMs = durationMs;
    if (this.probing || this.consecutiveFailures >= this.failureThreshold) {
      this.openedUntil = this.now() + this.cooldownMs;
      this.probing = false;
    }
  }

  /** 重连/配置变更后显式复位：新连接不应继承旧连接的熔断状态。 */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedUntil = 0;
    this.probing = false;
  }

  /** 探测请求未真正发出（例如被本地配额拦下）：释放探测位，不改变熔断状态。 */
  cancelProbe(): void {
    this.probing = false;
  }

  snapshot(): McpHealthSnapshot {
    const now = this.now();
    const state: McpCircuitState = !this.openedUntil ? 'closed'
      : now < this.openedUntil ? 'open' : 'half-open';
    return {
      state,
      calls: this.calls,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastDurationMs !== undefined ? { lastDurationMs: this.lastDurationMs } : {}),
      ...(state === 'open' ? { retryAfterMs: Math.max(0, this.openedUntil - now) } : {}),
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
    };
  }
}
