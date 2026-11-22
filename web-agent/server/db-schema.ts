// server/db-schema.ts —— 存储层的行类型、默认值与建表辅助（从 db.ts 拆出）
import type Database from 'better-sqlite3';

export function providerPurpose(providerId: string): string {
  return `provider:${providerId}`;
}

/** Visibility follows message role; user text is never interpreted as runtime metadata. */
export function isHiddenMessage(role: string, _content?: string | null): boolean {
  return role === 'system' || role === 'tool';
}

/** 网页端管理的 Provider 配置行 */
export interface ProviderRow {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 协议族：openai（含各家兼容端点）| anthropic | ollama */
  protocol: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
  /**
   * A7-2：该行存的是 `v1:` 密文，但本次运行解不开（主密钥丢失/更换，或密文损坏）。
   * **不落库**——由 Store 在读取时现算现填，因此重启后仍会如实复现。
   * 存在意义：此前解密失败静默返回空串，UI 只能显示「未配置 key」或沿用旧值，
   * 用户看到的是「莫名其妙 401」而不是「密钥不可解」这个真实故障。
   * 前端接线（设置页横幅）由 ui/ 侧另行完成；`GET /api/security` 已经聚合暴露（index.ts）。
   */
  keyBroken?: boolean;
  /** 不可解原因：decrypt-failed（密钥不符/密文损坏）| no-master-key（本次无主密钥） */
  keyBrokenReason?: string;
}

/** 主密钥状态快照（供 /api/security 与启动日志共用同一口径） */
export interface StoreKeyStatus {
  /** 本次运行是否持有可用主密钥 */
  hasMasterKey: boolean;
  /** 库里存在 v1: 密文（无论能否解密） */
  hasCiphertext: boolean;
  /** 密钥不可解的 provider 明细 */
  broken: { id: string; label: string; reason: string }[];
}

export interface AuthorizationAuditRow {
  id: number;
  occurredAt: number;
  outcome: 'granted' | 'denied' | 'connected' | 'disconnected';
  subject: string;
  capability: string;
  object: string;
  reason: string | null;
}

/** Optimistic write failure: caller must reload the current row before retrying. */
export class ConcurrentStoreWriteError extends Error {
  readonly code = 'concurrent_write';
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} 已被其他写入者修改：${id}`);
    this.name = 'ConcurrentStoreWriteError';
  }
}

/** 模型能力行（一个 Provider 可挂多个模型，路由按能力谓词选路） */
export interface ModelRow {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutput: number | null;
  vision: number;
  tools: number;
  reasoning: number;
  priceIn: number | null;
  priceOut: number | null;
  enabled: number;
  /** pulled=拉取时顺带解析 / inferred=内置目录推断 / manual=用户手填 */
  source: string;
  latencyMs: number | null;
  privacyTier: 'local' | 'trusted' | 'external' | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  updatedAt: number;
}

/** 用户人设行 */
export interface PersonaRow {
  id: string;
  name: string;
  content: string;
  enabled: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** 默认人设种子（用户可编辑/停用；id=default 这一行随代码升级合并刷新，
 *  自定义人设不受影响）；运行时规则（见 core/chat BASE_PROMPT）不在此重复 */
export const DEFAULT_PERSONA = {
  id: 'default',
  name: '默认人设',
  content: '',
};

export function ensureTenants(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, max_sessions INTEGER NOT NULL DEFAULT 0,
    max_active_runs INTEGER NOT NULL DEFAULT 0, max_cost_usd REAL NOT NULL DEFAULT 0,
    max_storage_bytes INTEGER NOT NULL DEFAULT 0,
    max_tool_calls_per_minute INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?,?,?)').run('default', 'Default', Date.now());
}
