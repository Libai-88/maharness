/** server/store/sqlite/providers.ts —— Provider 聚合根的 SQL（ADR 0007 / v4 C2） */
import type Database from 'better-sqlite3';

import { ConcurrentStoreWriteError, type ProviderRow } from '../../db-schema';

/** 密钥的加解密与故障记账仍由 Store 持有（它握有主密钥与记账表），仓库只借用能力。 */
export interface ProviderKeyPort {
  decrypt(blob: string, providerId?: string): string;
  encrypt(plain: string, providerId?: string): string;
  withKeyState(row: ProviderRow): ProviderRow;
  forget(providerId: string): void;
}

export class SqliteProviderRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly keys: ProviderKeyPort,
  ) {}

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, protocol, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers ORDER BY created_at ASC',
      )
      .all() as ProviderRow[];
    return rows.map((r) => this.keys.withKeyState({ ...r, apiKey: this.keys.decrypt(r.apiKey, r.id) }));
  }

  getProvider(id: string): ProviderRow | undefined {
    const r = this.db
      .prepare(
        'SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, protocol, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers WHERE id = ?',
      )
      .get(id) as ProviderRow | undefined;
    return r ? this.keys.withKeyState({ ...r, apiKey: this.keys.decrypt(r.apiKey, r.id) }) : undefined;
  }

  /** A7-2：空 apiKey = 不改动，留空时原样保留已存密文/明文，绝不用空串覆盖。 */
  private storedKeyFor(p: { id: string; apiKey: string }): string {
    if (p.apiKey) return this.keys.encrypt(p.apiKey, p.id);
    const raw = (this.db.prepare('SELECT api_key AS k FROM providers WHERE id = ?').get(p.id) as { k?: string } | undefined)?.k;
    return raw ?? '';
  }

  /** 已存在的 Provider 覆盖写入；带 expectedUpdatedAt 时是乐观锁写。 */
  private updateExisting(
    p: {
      id: string;
      label: string;
      baseUrl: string;
      model: string;
      priceIn?: number;
      priceOut?: number;
      enabled?: number;
      expectedUpdatedAt?: number;
    },
    existing: ProviderRow,
    storedKey: string,
    protocol: string,
  ): void {
    const updatedAt = Math.max(Date.now(), existing.updatedAt + 1);
    const sql =
      p.expectedUpdatedAt === undefined
        ? 'UPDATE providers SET label=?, base_url=?, api_key=?, model=?, protocol=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=?'
        : 'UPDATE providers SET label=?, base_url=?, api_key=?, model=?, protocol=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=? AND updated_at=?';
    const params: unknown[] = [
      p.label,
      p.baseUrl,
      storedKey,
      p.model,
      protocol,
      p.priceIn ?? null,
      p.priceOut ?? null,
      p.enabled ?? existing.enabled,
      updatedAt,
      p.id,
    ];
    if (p.expectedUpdatedAt !== undefined) params.push(p.expectedUpdatedAt);
    const result = this.db.prepare(sql).run(...params);
    if (p.expectedUpdatedAt !== undefined && result.changes !== 1) throw new ConcurrentStoreWriteError('Provider', p.id);
  }

  upsertProvider(p: {
    id: string;
    label: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol?: string;
    priceIn?: number;
    priceOut?: number;
    enabled?: number;
    expectedUpdatedAt?: number;
  }): void {
    const now = Date.now();
    const storedKey = this.storedKeyFor(p);
    const existing = this.getProvider(p.id);
    const protocol = p.protocol ?? existing?.protocol ?? 'openai';
    if (existing) {
      this.updateExisting(p, existing, storedKey, protocol);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO providers (id, label, base_url, api_key, model, protocol, price_in, price_out, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(p.id, p.label, p.baseUrl, storedKey, p.model, protocol, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? 1, now, now);
  }

  deleteProvider(id: string, expectedUpdatedAt?: number): void {
    const tx = this.db.transaction((providerId: string) => {
      this.db.prepare('DELETE FROM models WHERE provider_id = ?').run(providerId);
      const result =
        expectedUpdatedAt === undefined
          ? this.db.prepare('DELETE FROM providers WHERE id = ?').run(providerId)
          : this.db.prepare('DELETE FROM providers WHERE id = ? AND updated_at = ?').run(providerId, expectedUpdatedAt);
      if (expectedUpdatedAt !== undefined && result.changes !== 1) throw new ConcurrentStoreWriteError('Provider', providerId);
    });
    tx(id);
    // 故障记账随行 removal 一并清掉，否则状态接口会报一个不存在的 provider
    this.keys.forget(id);
  }

  setProviderEnabled(id: string, enabled: number): void {
    this.db.prepare('UPDATE providers SET enabled=?, updated_at=? WHERE id=?').run(enabled, Date.now(), id);
  }
}
