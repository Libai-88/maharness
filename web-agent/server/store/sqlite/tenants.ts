/** server/store/sqlite/tenants.ts —— 租户配额与用量聚合的 SQL（ADR 0007 / v4 C2） */
import type Database from 'better-sqlite3';

export interface TenantRow {
  id: string;
  name: string;
  maxSessions: number;
  maxActiveRuns: number;
  maxCostUsd: number;
  maxStorageBytes: number;
  maxToolCallsPerMinute: number;
  createdAt: number;
}

export class SqliteTenantRepo {
  constructor(private readonly db: Database.Database) {}

  getTenant(id: string): TenantRow | undefined {
    return this.db
      .prepare(
        'SELECT id, name, max_sessions AS maxSessions, max_active_runs AS maxActiveRuns, max_cost_usd AS maxCostUsd, max_storage_bytes AS maxStorageBytes, max_tool_calls_per_minute AS maxToolCallsPerMinute, created_at AS createdAt FROM tenants WHERE id = ?',
      )
      .get(id) as TenantRow | undefined;
  }

  /** 每会话用量聚合（SQL 下推，避免逐会话 listMessages 拉全量 content） */
  aggregateSessions(
    tenantId = 'default',
  ): { sessionId: string; tokensIn: number; tokensOut: number; cost: number; messages: number; truncations: number; chars: number }[] {
    return this.db
      .prepare(`SELECT m.session_id AS sessionId,
                  COALESCE(SUM(m.tokens_in), 0) AS tokensIn,
                  COALESCE(SUM(m.tokens_out), 0) AS tokensOut,
                  COALESCE(SUM(m.cost), 0) AS cost,
                  COUNT(*) AS messages,
                  COALESCE(SUM(CASE WHEN m.role = 'system' AND m.content LIKE '%上下文管理%' THEN 1 ELSE 0 END), 0) AS truncations,
                  COALESCE(SUM(LENGTH(COALESCE(m.content, ''))), 0) AS chars
                FROM messages m JOIN sessions s ON s.id = m.session_id
                WHERE s.tenant_id = ? GROUP BY m.session_id`)
      .all(tenantId) as {
      sessionId: string;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      messages: number;
      truncations: number;
      chars: number;
    }[];
  }
}
