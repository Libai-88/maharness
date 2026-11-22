import type Database from 'better-sqlite3';

export type ScheduleState = 'pending' | 'running' | 'done' | 'failed';

export interface ScheduleJob {
  id: string;
  sessionId: string;
  runId?: string;
  principalRole?: 'admin' | 'member' | 'readonly';
  tenantId: string;
  dueAt: number;
  state: ScheduleState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export const RECOVERY_SCHEDULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_recovery_jobs_v3 (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    principal_role TEXT,
    tenant_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS scheduled_recovery_jobs_v3_tenant
    ON scheduled_recovery_jobs_v3(tenant_id, due_at);
  CREATE INDEX IF NOT EXISTS scheduled_recovery_jobs_v3_due
    ON scheduled_recovery_jobs_v3(state, due_at);
`;

function parse(row: Record<string, unknown>): ScheduleJob {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: row.run_id ? String(row.run_id) : undefined,
    principalRole:
      row.principal_role === 'admin' || row.principal_role === 'member' || row.principal_role === 'readonly'
        ? row.principal_role
        : undefined,
    tenantId: String(row.tenant_id),
    dueAt: Number(row.due_at),
    state: row.state as ScheduleState,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastError: row.last_error ? String(row.last_error) : undefined,
  };
}

export class ScheduleRepository {
  constructor(private readonly db: Database.Database) {}

  list(tenantId?: string): ScheduleJob[] {
    const rows = tenantId
      ? this.db
          .prepare('SELECT * FROM scheduled_recovery_jobs_v3 WHERE tenant_id=? ORDER BY due_at,created_at DESC,rowid DESC')
          .all(tenantId)
      : this.db.prepare('SELECT * FROM scheduled_recovery_jobs_v3 ORDER BY due_at,created_at DESC,rowid DESC').all();
    return (rows as Record<string, unknown>[]).map(parse);
  }

  get(id: string, tenantId?: string): ScheduleJob | undefined {
    const row = tenantId
      ? this.db.prepare('SELECT * FROM scheduled_recovery_jobs_v3 WHERE id=? AND tenant_id=?').get(id, tenantId)
      : this.db.prepare('SELECT * FROM scheduled_recovery_jobs_v3 WHERE id=?').get(id);
    return row ? parse(row as Record<string, unknown>) : undefined;
  }

  insert(job: ScheduleJob): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO scheduled_recovery_jobs_v3
      (id,session_id,run_id,principal_role,tenant_id,due_at,state,attempts,created_at,updated_at,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        job.id,
        job.sessionId,
        job.runId ?? null,
        job.principalRole ?? null,
        job.tenantId,
        job.dueAt,
        job.state,
        job.attempts,
        job.createdAt,
        job.updatedAt,
        job.lastError ?? null,
      );
  }

  update(job: ScheduleJob): void {
    this.db
      .prepare(`UPDATE scheduled_recovery_jobs_v3 SET session_id=?,run_id=?,principal_role=?,tenant_id=?,
      due_at=?,state=?,attempts=?,updated_at=?,last_error=? WHERE id=?`)
      .run(
        job.sessionId,
        job.runId ?? null,
        job.principalRole ?? null,
        job.tenantId,
        job.dueAt,
        job.state,
        job.attempts,
        job.updatedAt,
        job.lastError ?? null,
        job.id,
      );
  }

  failInterrupted(now: number, message: string): void {
    this.db
      .prepare(`UPDATE scheduled_recovery_jobs_v3 SET state='failed',last_error=?,updated_at=?
      WHERE state IN ('pending','running')`)
      .run(message, now);
  }

  prune(max: number): void {
    const jobs = this.list();
    const active = jobs.filter((job) => job.state === 'pending' || job.state === 'running');
    const finished = jobs
      .filter((job) => job.state === 'done' || job.state === 'failed')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, max - active.length));
    const keep = new Set([...active, ...finished].map((job) => job.id));
    const remove = jobs.filter((job) => !keep.has(job.id)).map((job) => job.id);
    if (!remove.length) return;
    const statement = this.db.prepare('DELETE FROM scheduled_recovery_jobs_v3 WHERE id=?');
    this.db.transaction(() => {
      for (const id of remove) statement.run(id);
    })();
  }
}
