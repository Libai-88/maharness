/**
 * server/db.ts —— SQLite 持久化（better-sqlite3，同步 API，零配置）
 * 表：sessions / messages / plugin_state / cache_entries（v1 用内存缓存，表预留）
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { LLMRole, Message, Session, ToolCall } from '../kernel/types';

/** 网页端管理的 Provider 配置行 */
export interface ProviderRow {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

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
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);      CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, version TEXT, loaded_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, base_url TEXT NOT NULL,
        api_key TEXT NOT NULL, model TEXT NOT NULL,
        price_in REAL, price_out REAL, enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    // 迁移：reasoning 列（旧库无此列）
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    }
  }

  // ---------- providers（网页端管理，DB 为唯一来源） ----------

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows;
  }

  getProvider(id: string): ProviderRow | undefined {
    return this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined;
  }

  upsertProvider(p: {
    id: string; label: string; baseUrl: string; apiKey: string; model: string;
    priceIn?: number; priceOut?: number; enabled?: number;
  }): void {
    const now = Date.now();
    const existing = this.getProvider(p.id);
    if (existing) {
      this.db
        .prepare('UPDATE providers SET label=?, base_url=?, api_key=?, model=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=?')
        .run(p.label, p.baseUrl, p.apiKey, p.model, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? existing.enabled, now, p.id);
    } else {
      this.db
        .prepare('INSERT INTO providers (id, label, base_url, api_key, model, price_in, price_out, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(p.id, p.label, p.baseUrl, p.apiKey, p.model, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? 1, now, now);
    }
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  setProviderEnabled(id: string, enabled: number): void {
    this.db.prepare('UPDATE providers SET enabled=?, updated_at=? WHERE id=?').run(enabled, Date.now(), id);
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
      reasoning: (r.reasoning as string | null) ?? undefined,
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
      .prepare(`INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        msg.id, msg.sessionId, msg.role, msg.content,
        msg.reasoning ?? null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null, msg.tokensIn ?? 0, msg.tokensOut ?? 0, msg.cost ?? 0,
        msg.traceId ?? null, msg.createdAt,
      );
    return msg;
  }
}
