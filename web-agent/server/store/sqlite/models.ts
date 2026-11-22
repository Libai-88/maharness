/** server/store/sqlite/models.ts —— 模型与能力画像聚合根的 SQL（ADR 0007 / v4 C2） */
import type Database from 'better-sqlite3';

import { ConcurrentStoreWriteError, type ModelRow } from '../../db-schema';

type ModelPatch = Partial<ModelRow> & { providerId: string; modelId: string };

export class SqliteModelRepo {
  constructor(private readonly db: Database.Database) {}

  listModels(providerId?: string): ModelRow[] {
    const sql =
      'SELECT provider_id AS providerId, model_id AS modelId, context_window AS contextWindow, max_output AS maxOutput, vision, tools, reasoning, price_in AS priceIn, price_out AS priceOut, enabled, source, latency_ms AS latencyMs, privacy_tier AS privacyTier, risk_level AS riskLevel, updated_at AS updatedAt FROM models';
    return providerId
      ? (this.db.prepare(`${sql} WHERE provider_id = ? ORDER BY model_id ASC`).all(providerId) as ModelRow[])
      : (this.db.prepare(`${sql} ORDER BY provider_id ASC, model_id ASC`).all() as ModelRow[]);
  }

  upsertModel(m: ModelPatch): void {
    this.upsertModels([m]);
  }

  upsertModels(models: ModelPatch[]): void {
    if (models.length === 0) return;
    const statement = this.db.prepare(`
      INSERT INTO models (provider_id, model_id, context_window, max_output, vision, tools, reasoning, price_in, price_out, enabled, source, latency_ms, privacy_tier, risk_level, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        context_window=COALESCE(excluded.context_window, context_window),
        max_output=COALESCE(excluded.max_output, max_output),
        vision=excluded.vision, tools=excluded.tools, reasoning=excluded.reasoning,
        price_in=COALESCE(excluded.price_in, price_in),
        price_out=COALESCE(excluded.price_out, price_out),
        enabled=excluded.enabled,
        source=CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE models.source END,
        latency_ms=COALESCE(excluded.latency_ms, latency_ms),
        privacy_tier=COALESCE(excluded.privacy_tier, privacy_tier),
        risk_level=COALESCE(excluded.risk_level, risk_level),
        updated_at=excluded.updated_at
    `);
    // 批量刷新要么全成要么全败：失败的能力行不能留下半套目录
    const tx = this.db.transaction((rows: ModelPatch[]) => {
      for (const m of rows) {
        statement.run(
          m.providerId,
          m.modelId,
          m.contextWindow ?? null,
          m.maxOutput ?? null,
          m.vision ?? 0,
          m.tools ?? 0,
          m.reasoning ?? 0,
          m.priceIn ?? null,
          m.priceOut ?? null,
          m.enabled ?? 1,
          m.source ?? 'manual',
          m.latencyMs ?? null,
          m.privacyTier ?? null,
          m.riskLevel ?? null,
          Date.now(),
        );
      }
    });
    tx(models);
  }

  updateModel(m: ModelPatch, expectedUpdatedAt: number): void {
    const previous = this.listModels(m.providerId).find((row) => row.modelId === m.modelId);
    if (!previous) throw new ConcurrentStoreWriteError('Model', `${m.providerId}@${m.modelId}`);
    const updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
    const result = this.db
      .prepare(`UPDATE models SET context_window=?, max_output=?, vision=?, tools=?, reasoning=?, price_in=?, price_out=?, enabled=?, source=?, latency_ms=?, privacy_tier=?, risk_level=?, updated_at=?
      WHERE provider_id=? AND model_id=? AND updated_at=?`)
      .run(
        m.contextWindow ?? null,
        m.maxOutput ?? null,
        m.vision ?? 0,
        m.tools ?? 0,
        m.reasoning ?? 0,
        m.priceIn ?? null,
        m.priceOut ?? null,
        m.enabled ?? 1,
        m.source ?? 'manual',
        m.latencyMs ?? null,
        m.privacyTier ?? null,
        m.riskLevel ?? null,
        updatedAt,
        m.providerId,
        m.modelId,
        expectedUpdatedAt,
      );
    if (result.changes !== 1) throw new ConcurrentStoreWriteError('Model', `${m.providerId}@${m.modelId}`);
  }

  deleteModel(providerId: string, modelId: string): void {
    this.db.prepare('DELETE FROM models WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
  }
}
