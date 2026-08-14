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

/** 用户人设行 */
export interface PersonaRow {
  id: string;
  name: string;
  content: string;
  enabled: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** 默认人设种子（用户可编辑/停用/删除）；L0 内核纪律（见 core/chat BASE_PROMPT）不在此重复 */
export const DEFAULT_PERSONA = {
  id: 'default',
  name: '默认人设',
  content: [
    '身份：你是运行在 Windows 上的自研 Web Agent（maharness）。',
    '语气：简洁、直接、专业；默认使用中文；给出可直接复制使用的命令、路径与代码。',
    '能力边界：可以读写工作区文件（路径相对沙箱根目录）、浏览目录；可以调用已加载插件提供的工具。超出能力范围的事，明确说明不能做，并给出替代方案。',
  ].join('\n'),
};

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
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    // 迁移：reasoning 列（旧库无此列）
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    }
    // 迁移：sessions.mode 列（普通/计划/目标模式）
    const sCols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!sCols.some((c) => c.name === 'mode')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'");
    }
    // 迁移：sessions.plan_pending 列（计划模式状态机：0 无限制 / 1 待出计划 / 2 已出计划待确认）
    if (!sCols.some((c) => c.name === 'plan_pending')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN plan_pending INTEGER NOT NULL DEFAULT 0');
    }
    // 迁移：sessions.archived / pinned 列（会话管理：归档与置顶标记）
    if (!sCols.some((c) => c.name === 'archived')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    if (!sCols.some((c) => c.name === 'pinned')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
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

  // ---------- personas（用户人设，网页端管理） ----------

  listPersonas(): PersonaRow[] {
    return this.db
      .prepare('SELECT id, name, content, enabled, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt FROM personas ORDER BY sort_order ASC, created_at ASC')
      .all() as PersonaRow[];
  }

  getPersona(id: string): PersonaRow | undefined {
    return this.db
      .prepare('SELECT id, name, content, enabled, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt FROM personas WHERE id = ?')
      .get(id) as PersonaRow | undefined;
  }

  upsertPersona(p: {
    id: string; name: string; content: string;
    enabled?: number; sortOrder?: number;
  }): void {
    const now = Date.now();
    const existing = this.getPersona(p.id);
    if (existing) {
      this.db
        .prepare('UPDATE personas SET name=?, content=?, enabled=?, sort_order=?, updated_at=? WHERE id=?')
        .run(p.name, p.content, p.enabled ?? existing.enabled, p.sortOrder ?? existing.sortOrder, now, p.id);
    } else {
      this.db
        .prepare('INSERT INTO personas (id, name, content, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(p.id, p.name, p.content, p.enabled ?? 1, p.sortOrder ?? 0, now, now);
    }
  }

  deletePersona(id: string): void {
    this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  }

  // ---------- sessions ----------

  listSessions(): Session[] {
    const rows = this.db
      .prepare('SELECT id, title, model, mode, plan_pending AS planPending, archived, pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, model: r.model as string,
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      archived: (r.archived as number) ?? 0, pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number, updatedAt: r.updatedAt as number,
    }));
  }

  getSession(id: string): Session | undefined {
    const r = this.db
      .prepare('SELECT id, title, model, mode, plan_pending AS planPending, archived, pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, title: r.title as string, model: r.model as string,
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      archived: (r.archived as number) ?? 0, pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number, updatedAt: r.updatedAt as number,
    };
  }

  createSession(model: string): Session {
    const s: Session = {
      id: randomUUID(), title: '新会话', model, mode: 'normal', planPending: 0,
      archived: 0, pinned: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO sessions (id, title, model, mode, plan_pending, archived, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(s.id, s.title, s.model, s.mode, s.planPending, s.archived, s.pinned, s.createdAt, s.updatedAt);
    return s;
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'model' | 'mode' | 'planPending' | 'archived' | 'pinned'>>): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE sessions SET title = ?, model = ?, mode = ?, plan_pending = ?, archived = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(patch.title ?? cur.title, patch.model ?? cur.model, patch.mode ?? cur.mode, patch.planPending ?? cur.planPending, patch.archived ?? cur.archived, patch.pinned ?? cur.pinned, Date.now(), id);
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** 清空会话消息（保留会话本身，/clear 命令用） */
  clearSessionMessages(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  }

  // ---------- workspaces ----------

  listWorkspaces(): { id: string; path: string; createdAt: number }[] {
    return this.db
      .prepare('SELECT id, path, created_at AS createdAt FROM workspaces ORDER BY created_at ASC')
      .all() as { id: string; path: string; createdAt: number }[];
  }

  addWorkspace(path: string): { id: string; path: string; createdAt: number } {
    const existing = this.db.prepare('SELECT id FROM workspaces WHERE path = ?').get(path) as { id: string } | undefined;
    if (existing) return this.listWorkspaces().find((w) => w.id === existing.id)!;
    const id = randomUUID();
    this.db.prepare('INSERT INTO workspaces (id, path, created_at) VALUES (?,?,?)').run(id, path, Date.now());
    return { id, path, createdAt: Date.now() };
  }

  removeWorkspace(id: string): boolean {
    const r = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return r.changes > 0;
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

  // ---------- 统计 ----------

  /** 全局聚合：会话数 / 消息数 / tokens / 成本 / 上下文截断次数（system 注入的截断说明消息计数） */
  statsOverview(): { sessions: number; messages: number; tokensIn: number; tokensOut: number; cost: number; truncations: number } {
    const s = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    const m = this.db
      .prepare(`SELECT COUNT(*) AS n,
                  COALESCE(SUM(tokens_in), 0) AS tokensIn,
                  COALESCE(SUM(tokens_out), 0) AS tokensOut,
                  COALESCE(SUM(cost), 0) AS cost,
                  COALESCE(SUM(CASE WHEN role = 'system' AND content LIKE '%上下文管理%' THEN 1 ELSE 0 END), 0) AS truncations
                FROM messages`)
      .get() as Record<string, number>;
    return {
      sessions: s.n, messages: m.n,
      tokensIn: m.tokensIn, tokensOut: m.tokensOut, cost: m.cost, truncations: m.truncations,
    };
  }
}
