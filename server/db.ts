/**
 * server/db.ts —— SQLite 持久化（better-sqlite3，同步 API，零配置）
 * 表：sessions / messages / plugin_state / cache_entries（v1 用内存缓存，表预留）
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { LLMRole, Message, Session, ToolCall } from '../kernel/types';

export class Store {
  private db: Database.Database;

  constructor(dbFile: string) {
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新会话',
        model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0,
        trace_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, version TEXT, loaded_at INTEGER
      );
    `);
  }

  // ---------- sessions ----------

  listSessions(): Session[] {
    const rows = this.db
      .prepare('SELECT id, title, model, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC')
      .all() as Session[];
    return rows;
  }

  getSession(id: string): Session | undefined {
    return this.db
      .prepare('SELECT id, title, model, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(id) as Session | undefined;
  }

  createSession(model: string): Session {
    const s: Session = {
      id: randomUUID(), title: '新会话', model,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(s.id, s.title, s.model, s.createdAt, s.updatedAt);
    return s;
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'model'>>): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE sessions SET title = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(patch.title ?? cur.title, patch.model ?? cur.model, Date.now(), id);
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ---------- messages ----------

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as LLMRole,
      content: r.content as string | null,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls as string) as ToolCall[] : undefined,
      toolCallId: (r.tool_call_id as string) ?? undefined,
      tokensIn: r.tokens_in as number,
      tokensOut: r.tokens_out as number,
      cost: r.cost as number,
      traceId: (r.trace_id as string) ?? undefined,
      createdAt: r.created_at as number,
    }));
  }

  addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
    const msg: Message = { ...m, id: randomUUID(), createdAt: Date.now() };
    this.db
      .prepare(`INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        msg.id, msg.sessionId, msg.role, msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null, msg.tokensIn ?? 0, msg.tokensOut ?? 0, msg.cost ?? 0,
        msg.traceId ?? null, msg.createdAt,
      );
    return msg;
  }
}
