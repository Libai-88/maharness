import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

export interface MigrationFile {
  version: number;
  file: string;
  sha256: string;
  description: string;
}

export interface MigrationManifest {
  schemaVersion: number;
  minSupportedVersion: number;
  migrations: MigrationFile[];
}

/**
 * Immutable migration manifest.
 *
 * Every file is applied once, in order, inside one transaction. Published files
 * must never be edited: append a new version instead. The runner verifies each
 * file's checksum before applying and again on every open, so silent drift in an
 * already-applied migration fails loudly.
 */
export const MIGRATION_MANIFEST: MigrationManifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as MigrationManifest;

export function migrationSql(entry: MigrationFile): string {
  return readFileSync(join(here, entry.file), 'utf8');
}

export function fileChecksum(entry: MigrationFile): string {
  return createHash('sha256').update(migrationSql(entry)).digest('hex');
}

export class MigrationError extends Error {
  constructor(
    readonly code: 'DB_SCHEMA_TOO_OLD' | 'MIGRATION_CHECKSUM_MISMATCH' | 'MIGRATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

interface AppliedRow {
  version: number;
  name: string;
  sha256: string;
}

function appliedMigrations(db: Database.Database): AppliedRow[] {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!table) return [];
  return db.prepare('SELECT version,name,sha256 FROM schema_migrations ORDER BY version').all() as AppliedRow[];
}

export interface ApplyResult {
  from: number;
  to: number;
  applied: number[];
}

/**
 * Apply pending immutable migrations.
 *
 * - `current > schemaVersion`: fail closed (database from a newer build).
 * - `current < minSupportedVersion`: fail closed with an explicit export hint.
 * - `current === schemaVersion`: verify applied checksums only.
 * - new/empty database: apply every file from the baseline upward.
 */
export function applyMigrations(db: Database.Database, current: number, options: { empty: boolean }): ApplyResult {
  const { schemaVersion, minSupportedVersion, migrations } = MIGRATION_MANIFEST;
  if (current > schemaVersion) {
    throw new MigrationError(
      'MIGRATION_FAILED',
      `数据库 schema 版本 ${current} 高于本程序支持的 ${schemaVersion}（库来自更新的版本），已拒绝打开以避免破坏数据——请升级程序或恢复备份`,
    );
  }
  if (!options.empty && current < minSupportedVersion) {
    throw new MigrationError(
      'DB_SCHEMA_TOO_OLD',
      `数据库 schema 版本 ${current} 低于最低支持的 ${minSupportedVersion}。本版本不再自动迁移旧库；请先运行 npm run db:export 导出事实，或从 data/backups/ 恢复 v${minSupportedVersion} 备份后再升级`,
    );
  }

  for (const entry of migrations) {
    const actual = fileChecksum(entry);
    if (actual !== entry.sha256) {
      throw new MigrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `迁移文件 ${entry.file} 的校验和不匹配（期望 ${entry.sha256}，实际 ${actual}）；已发布的迁移文件不可修改，请新增版本`,
      );
    }
  }

  const appliedRows = appliedMigrations(db);
  for (const row of appliedRows) {
    const entry = migrations.find((item) => item.version === row.version);
    if (!entry) throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', `数据库记录了未知迁移 v${row.version}（${row.name}）`);
    if (entry.sha256 !== row.sha256) {
      throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', `迁移 v${row.version} 的校验和与数据库记录不一致；已应用迁移不可修改`);
    }
  }

  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  // Backfill the ledger for versions the database already reached before the
  // immutable manifest existed (e.g. a v15 database created by older builds).
  // Recording them keeps the audit trail complete without re-running DDL.
  const backfill = migrations.filter((entry) => entry.version <= current && !appliedVersions.has(entry.version));
  const pending = migrations.filter((entry) => !appliedVersions.has(entry.version) && entry.version > current);
  if (!pending.length && !backfill.length) {
    // user_version can lag behind the ledger (restored backup, legacy baseline
    // path). Resync it to the highest applied migration instead of re-running.
    const highest = appliedRows.reduce((max, row) => Math.max(max, row.version), current);
    if (highest !== current) db.pragma(`user_version = ${highest}`);
    return { from: current, to: highest, applied: [] };
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )`);
  const record = db.prepare('INSERT INTO schema_migrations(version,name,sha256,applied_at,duration_ms) VALUES(?,?,?,?,?)');
  try {
    db.transaction(() => {
      for (const entry of backfill) {
        record.run(entry.version, entry.file, entry.sha256, Date.now(), 0);
      }
      for (const entry of pending) {
        const started = Date.now();
        db.exec(migrationSql(entry));
        record.run(entry.version, entry.file, entry.sha256, started, Date.now() - started);
        db.pragma(`user_version = ${entry.version}`);
      }
    })();
  } catch (error) {
    throw new MigrationError(
      'MIGRATION_FAILED',
      `数据库迁移 ${current} → ${schemaVersion} 失败，事务已回滚，可从备份恢复: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { from: current, to: schemaVersion, applied: pending.map((entry) => entry.version) };
}
