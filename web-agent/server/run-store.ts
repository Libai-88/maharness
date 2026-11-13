import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RunCheckpoint, RunEvent, RunRecord, RunStatus } from '../kernel/run';
import type { LLMMessage, ToolResult } from '../kernel/types';
import { resultPage } from '../kernel/tool-journal';

export interface ModelToolCheck { status: 'confirmed' | 'not_confirmed'; checkedAt: number; fingerprint: string; reason?: string }
export interface RunArtifact { id: string; runId: string; callId: string; kind: string; label: string; ref: string; createdAt: number }
export const RUN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS run_artifacts_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ref TEXT NOT NULL, record TEXT NOT NULL,
    UNIQUE(run_id,ref)
  );
  CREATE TABLE IF NOT EXISTS model_tool_checks_v2 (
    provider_id TEXT NOT NULL, model TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(provider_id,model)
  );
  CREATE TABLE IF NOT EXISTS run_history_v2 (
    run_id TEXT NOT NULL, message_id TEXT NOT NULL, message TEXT NOT NULL,
    PRIMARY KEY(run_id,message_id)
  );
  CREATE TABLE IF NOT EXISTS run_model_inputs_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn INTEGER NOT NULL, created_at INTEGER NOT NULL, input TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_budget_reservations_v2 (
    run_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, amount REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_tool_calls_v2 (
    run_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_summary TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT,
    PRIMARY KEY(run_id,call_id)
  );
  CREATE TABLE IF NOT EXISTS runs_v2 (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    parent_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL, request_key TEXT,
    UNIQUE(tenant_id, session_id, request_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runs_v2_session_active ON runs_v2(session_id)
    WHERE parent_id IS NULL AND status IN ('queued','running','waiting_approval','stopping');
  CREATE INDEX IF NOT EXISTS runs_v2_tenant ON runs_v2(tenant_id);
  CREATE TABLE IF NOT EXISTS run_events_v2 (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(run_id,seq)
  );
  CREATE TABLE IF NOT EXISTS run_checkpoints_v2 (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS run_messages_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, content TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, request_key TEXT, UNIQUE(run_id,request_key)
  );
  CREATE TABLE IF NOT EXISTS workspace_permissions_v2 (
    tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, profile TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace)
  );
`;

/** State and its public event commit together; subscribers only observe committed facts. */
export class RunRepository {
  constructor(private readonly db: Database.Database) {}
  artifacts(runId: string): RunArtifact[] {
    return (this.db.prepare('SELECT record FROM run_artifacts_v2 WHERE run_id=? ORDER BY rowid').all(runId) as { record: string }[]).map(row => JSON.parse(row.record));
  }
  saveModelToolCheck(provider: string, model: string, check: ModelToolCheck): void {
    this.db.prepare('INSERT OR REPLACE INTO model_tool_checks_v2 VALUES(?,?,?)').run(provider, model, JSON.stringify(check));
  }
  modelToolCheck(provider: string, model: string): ModelToolCheck | undefined {
    const row = this.db.prepare('SELECT record FROM model_tool_checks_v2 WHERE provider_id=? AND model=?').get(provider, model) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  saveModelInput(runId: string, input: Parameters<NonNullable<import('../kernel/loop').RunOptions['onModelInput']>>[0]): void {
    this.db.prepare('INSERT INTO run_model_inputs_v2 VALUES(?,?,?,?,?)').run(randomUUID(), runId, input.turn, Date.now(), JSON.stringify(input));
  }
  modelInputs(runId: string, limit = 10, before?: string) {
    const rows = this.db.prepare('SELECT id,turn,created_at,input FROM run_model_inputs_v2 WHERE run_id=? AND (? IS NULL OR rowid < (SELECT rowid FROM run_model_inputs_v2 WHERE id=? AND run_id=?)) ORDER BY rowid DESC LIMIT ?').all(runId, before ?? null, before ?? null, runId, Math.max(1, Math.min(100, limit))) as { id: string; turn: number; created_at: number; input: string }[];
    return rows.map(row => ({ id: row.id, turn: row.turn, createdAt: row.created_at, ...JSON.parse(row.input) }));
  }
  startTool(runId: string, id: string, name: string, argsSummary: string): void {
    this.db.prepare('INSERT INTO run_tool_calls_v2(run_id,call_id,name,args_summary,status,started_at) VALUES(?,?,?,?,?,?)').run(runId, id, name, argsSummary, 'started', Date.now());
  }
  finishTool(runId: string, id: string, result: ToolResult): void {
    for (const evidence of result.ok ? result.evidence ?? [] : []) {
      if (!evidence.artifact || !evidence.ref) continue;
      const existing = this.artifacts(runId).find(item => item.ref === evidence.ref);
      const artifact: RunArtifact = { id: existing?.id ?? randomUUID(), runId, callId: id, kind: evidence.kind, label: evidence.label, ref: evidence.ref, createdAt: Date.now() };
      this.db.prepare('INSERT OR REPLACE INTO run_artifacts_v2 VALUES(?,?,?,?)').run(artifact.id, runId, artifact.ref, JSON.stringify(artifact));
    }
    this.db.prepare('UPDATE run_tool_calls_v2 SET status=?,finished_at=?,result=? WHERE run_id=? AND call_id=?').run(result.failure?.outcome === 'unknown' ? 'unknown' : result.ok ? 'succeeded' : 'failed', Date.now(), JSON.stringify(result), runId, id);
  }
  readTool(runId: string, id: string, offset?: number, limit?: number) {
    const row = this.db.prepare('SELECT result FROM run_tool_calls_v2 WHERE run_id=? AND call_id=?').get(runId, id) as { result: string | null } | undefined;
    return row?.result ? resultPage(id, row.result, offset, limit) : undefined;
  }
  toolCalls(runId: string) {
    return this.db.prepare('SELECT call_id AS id,name,args_summary AS argsSummary,status,started_at AS startedAt,finished_at AS finishedAt FROM run_tool_calls_v2 WHERE run_id=? ORDER BY rowid').all(runId);
  }
  transaction<T>(work: () => T): T { return this.db.transaction(work)(); }
  children(parentId: string, tenantId: string): RunRecord[] {
    const rows = this.db.prepare('SELECT record FROM runs_v2 WHERE parent_id=? AND tenant_id=? ORDER BY rowid').all(parentId, tenantId) as { record: string }[];
    return rows.map(row => JSON.parse(row.record));
  }
  availableBudget(record: RunRecord): number | undefined {
    if (record.budgetUsd === undefined) return;
    const current = this.get(record.id, record.tenantId)!;
    const { reserved } = this.db.prepare('SELECT COALESCE(SUM(amount),0) AS reserved FROM run_budget_reservations_v2 WHERE parent_id=?').get(record.id) as { reserved: number };
    return Math.max(0, current.budgetUsd! - current.cost - reserved);
  }
  reserveChild(parent: RunRecord, childId: string, requested?: number): number | undefined {
    return this.transaction(() => {
      const available = this.availableBudget(parent);
      const amount = requested ?? available;
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || available !== undefined && amount > available + 1e-10)) throw new Error('任务剩余预算不足');
      this.db.prepare('INSERT INTO run_budget_reservations_v2 VALUES(?,?,?)').run(childId, parent.id, amount ?? 0);
      return amount;
    });
  }
  releaseChild(childId: string): void { this.db.prepare('DELETE FROM run_budget_reservations_v2 WHERE run_id=?').run(childId); }
  accountAncestors(child: RunRecord, delta: { cost: number; tokensIn: number; tokensOut: number }): RunEvent[] {
    const events: RunEvent[] = [];
    let current = child;
    while (current.parentId) {
      this.db.prepare('UPDATE run_budget_reservations_v2 SET amount=MAX(0,amount-?) WHERE run_id=?').run(delta.cost, current.id);
      const parent = this.get(current.parentId, child.tenantId);
      if (!parent) throw new Error('Parent task missing');
      events.push(this.update(parent, { cost: parent.cost + delta.cost, tokensIn: parent.tokensIn + delta.tokensIn, tokensOut: parent.tokensOut + delta.tokensOut }, 'usage', { sourceRunId: child.id, ...delta }));
      current = parent;
    }
    return events;
  }
  active(tenantId: string, sessionId?: string): RunRecord[] {
    const rows = this.db.prepare(`SELECT record FROM runs_v2 WHERE tenant_id=? AND status IN ('queued','running','waiting_approval','stopping') ${sessionId ? 'AND session_id=?' : ''}`)
      .all(...(sessionId ? [tenantId, sessionId] : [tenantId])) as { record: string }[];
    return rows.map(row => JSON.parse(row.record));
  }
  get(id: string, tenantId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT record FROM runs_v2 WHERE id=? AND tenant_id=?').get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  list(tenantId: string, sessionId?: string): RunRecord[] {
    const rows = this.db.prepare(`SELECT record FROM runs_v2 WHERE tenant_id=? ${sessionId ? 'AND session_id=?' : ''} ORDER BY rowid DESC LIMIT 500`)
      .all(...(sessionId ? [tenantId, sessionId] : [tenantId])) as { record: string }[];
    return rows.map(row => JSON.parse(row.record));
  }
  byRequest(tenantId: string, sessionId: string, requestKey: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT record FROM runs_v2 WHERE tenant_id=? AND session_id=? AND request_key=?').get(tenantId, sessionId, requestKey) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  create(record: RunRecord, requestKey?: string): RunEvent {
    return this.db.transaction(() => {
      this.db.prepare('INSERT INTO runs_v2(id,session_id,tenant_id,parent_id,status,record,request_key) VALUES(?,?,?,?,?,?,?)')
        .run(record.id, record.sessionId, record.tenantId, record.parentId ?? null, record.status, JSON.stringify(record), requestKey ?? null);
      return this.append(record.id, 'state', { status: record.status });
    })();
  }
  update(record: RunRecord, patch: Partial<RunRecord>, type = 'state', data?: Record<string, unknown>): RunEvent {
    return this.db.transaction(() => {
      Object.assign(record, patch, { updatedAt: Date.now() });
      this.db.prepare('UPDATE runs_v2 SET status=?,record=? WHERE id=?').run(record.status, JSON.stringify(record), record.id);
      return this.append(record.id, type, data ?? { status: record.status });
    })();
  }
  append(runId: string, type: string, data: Record<string, unknown>): RunEvent {
    return this.db.transaction(() => {
      const { seq } = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events_v2 WHERE run_id=?').get(runId) as { seq: number };
      const event = { runId, seq, type, data, createdAt: Date.now() };
      this.db.prepare('INSERT INTO run_events_v2 VALUES(?,?,?,?,?)').run(runId, seq, type, JSON.stringify(data), event.createdAt);
      return event;
    })();
  }
  events(runId: string, after = 0, limit = 500): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM run_events_v2 WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit) as { run_id: string; seq: number; type: string; data: string; created_at: number }[];
    return rows.map(row => ({ runId: row.run_id, seq: row.seq, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
  }
  eventCursor(runId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM run_events_v2 WHERE run_id=?').get(runId) as { seq: number }).seq;
  }
  checkpoint(runId: string): RunCheckpoint | undefined {
    const row = this.db.prepare('SELECT data FROM run_checkpoints_v2 WHERE run_id=?').get(runId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveCheckpoint(runId: string, data: RunCheckpoint): void {
    this.transaction(() => {
      this.archiveHistory(runId, data.history);
      this.db.prepare('INSERT INTO run_checkpoints_v2 VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data').run(runId, JSON.stringify(data));
    });
  }
  archiveHistory(runId: string, messages: LLMMessage[]): void {
    this.transaction(() => {
      for (const message of messages) {
        message.context ??= { id: randomUUID(), source: message.role === 'tool' ? 'tool-observation' : 'conversation', scope: 'history', trust: message.role === 'tool' ? 'untrusted' : message.role === 'system' ? 'core' : message.role === 'user' ? 'user' : 'reference', retention: 'summarize' };
        this.db.prepare('INSERT OR IGNORE INTO run_history_v2 VALUES(?,?,?)').run(runId, message.context.id, JSON.stringify(message));
      }
    });
  }
  searchHistory(runId: string, query: string, offset = 0, limit = 10) {
    const rows = this.db.prepare('SELECT message_id,message FROM run_history_v2 WHERE run_id=? AND INSTR(LOWER(message),LOWER(?))>0 ORDER BY rowid LIMIT ? OFFSET ?').all(runId, query, Math.min(20, Math.max(1, limit)), Math.max(0, offset)) as { message_id: string; message: string }[];
    return rows.map(row => ({ id: row.message_id, ...JSON.parse(row.message), content: String(JSON.parse(row.message).content ?? '').slice(0, 4000), truncated: String(JSON.parse(row.message).content ?? '').length > 4000 }));
  }
  readHistory(runId: string, messageId: string, offset = 0, limit = 8000) {
    const row = this.db.prepare('SELECT message FROM run_history_v2 WHERE run_id=? AND message_id=?').get(runId, messageId) as { message: string } | undefined;
    return row ? resultPage(messageId, row.message, offset, limit) : undefined;
  }
  messageByRequest(runId: string, requestKey: string): { id: string; content: string } | undefined {
    return this.db.prepare('SELECT id,content FROM run_messages_v2 WHERE run_id=? AND request_key=?').get(runId, requestKey) as { id: string; content: string } | undefined;
  }
  addMessage(runId: string, content: string, requestKey?: string): string {
    const id = randomUUID();
    if (requestKey) {
      const existing = this.db.prepare('SELECT id FROM run_messages_v2 WHERE run_id=? AND request_key=?').get(runId, requestKey) as { id: string } | undefined;
      if (existing) return existing.id;
    }
    this.db.prepare('INSERT INTO run_messages_v2(id,run_id,content,created_at,request_key) VALUES(?,?,?,?,?)').run(id, runId, content, Date.now(), requestKey ?? null);
    return id;
  }
  deliverMessages(runId: string, checkpoint: RunCheckpoint): { id: string; content: string }[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id,content FROM run_messages_v2 WHERE run_id=? AND delivered=0 ORDER BY rowid').all(runId) as { id: string; content: string }[];
      if (rows.length) {
        checkpoint.history.push(...rows.map(row => ({ role: 'user' as const, content: row.content, context: { id: row.id, source: 'user-supplement', scope: 'run' as const, trust: 'user' as const, retention: 'required' as const } })));
        this.saveCheckpoint(runId, checkpoint);
        this.db.prepare('UPDATE run_messages_v2 SET delivered=1 WHERE run_id=? AND delivered=0').run(runId);
      }
      return rows;
    })();
  }
  interruptActive(): void {
    this.db.transaction(() => {
    const rows = this.db.prepare("SELECT record FROM runs_v2 WHERE status IN ('queued','running','waiting_approval','stopping')").all() as { record: string }[];
    for (const row of rows) this.update(JSON.parse(row.record), { status: 'interrupted' }, 'state', { status: 'interrupted', reason: 'process_restart' });
    this.db.prepare('DELETE FROM run_budget_reservations_v2').run();
    })();
  }
  permission(tenantId: string, workspace: string): { profile: 'standard' | 'developer'; revision: number } {
    return this.db.prepare('SELECT profile,revision FROM workspace_permissions_v2 WHERE tenant_id=? AND workspace=?').get(tenantId, workspace) as { profile: 'standard' | 'developer'; revision: number } | undefined ?? { profile: 'standard', revision: 0 };
  }
  setPermission(tenantId: string, workspace: string, profile: 'standard' | 'developer'): void {
    this.db.prepare('INSERT INTO workspace_permissions_v2 VALUES(?,?,?,1) ON CONFLICT(tenant_id,workspace) DO UPDATE SET profile=excluded.profile,revision=revision+1').run(tenantId, workspace, profile);
  }
}

export const ACTIVE_RUN_STATES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting_approval', 'stopping']);
