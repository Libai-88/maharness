import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATION_MANIFEST, applyMigrations, fileChecksum } from '../server/migrations/runner';

/**
 * Database maintenance CLI.
 *
 *   tsx scripts/db-migrate.ts export  [--db data/agent.db] [--out dir]
 *   tsx scripts/db-migrate.ts upgrade [--db data/agent.db]
 *   tsx scripts/db-migrate.ts verify
 *
 * `export` writes a portable JSON dump of every table so an unsupported old
 * database can be inspected or re-imported by hand before upgrading.
 * `upgrade` applies pending immutable migrations and prints the applied set.
 * `verify` checks every migration file against the manifest checksums.
 */
const args = process.argv.slice(2);
const command = args[0] ?? 'verify';
const root = resolve(import.meta.dirname, '..');
const dbPath = resolve(root, valueOf('--db') ?? join('data', 'agent.db'));

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function exportDump(): void {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const outDir = resolve(root, valueOf('--out') ?? join('data', 'export', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(outDir, { recursive: true });
  const db = new Database(dbPath, { readonly: true });
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map(row => row.name);
    const dump: Record<string, unknown[]> = {};
    for (const table of tables) dump[table] = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).all();
    writeFileSync(join(outDir, 'dump.json'), JSON.stringify({ schemaVersion: version, exportedAt: Date.now(), tables: dump }, null, 2));
    console.log(JSON.stringify({ outDir, schemaVersion: version, tables: tables.length }, null, 2));
  } finally {
    db.close();
  }
}

function upgrade(): void {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const db = new Database(dbPath);
  try {
    const current = Number(db.pragma('user_version', { simple: true }));
    const result = applyMigrations(db, current, { empty: false });
    console.log(JSON.stringify({ db: dbPath, ...result, schemaVersion: Number(db.pragma('user_version', { simple: true })) }, null, 2));
  } finally {
    db.close();
  }
}

function verify(): void {
  const rows = MIGRATION_MANIFEST.migrations.map(entry => ({
    version: entry.version,
    file: entry.file,
    expected: entry.sha256,
    actual: fileChecksum(entry),
  }));
  const mismatched = rows.filter(row => row.expected !== row.actual);
  console.log(JSON.stringify({ schemaVersion: MIGRATION_MANIFEST.schemaVersion, minSupportedVersion: MIGRATION_MANIFEST.minSupportedVersion, mismatched, rows }, null, 2));
  if (mismatched.length) process.exit(1);
}

if (command === 'export') exportDump();
else if (command === 'upgrade') upgrade();
else if (command === 'verify') verify();
else throw new Error(`未知命令: ${command}（可用 export / upgrade / verify）`);
