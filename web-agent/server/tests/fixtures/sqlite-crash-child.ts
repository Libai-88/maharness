import { Store } from '../../db';

const dbPath = process.argv[2];
if (!dbPath) throw new Error('db path is required');

const store = new Store(dbPath);
const raw = (store as unknown as { db: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
raw.exec('BEGIN IMMEDIATE');
raw.prepare(`INSERT INTO sessions (id, title, model, provider, mode, plan_pending, archived, pinned, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('crash-only-session', 'crash', 'model', '', 'normal', 0, 0, 0, Date.now(), Date.now());
// Simulate a process termination while the transaction is still open. SQLite must roll it back on reopen.
process.exit(137);
