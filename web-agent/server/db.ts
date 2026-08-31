/**
 * server/db.ts —— SQLite 持久化（better-sqlite3，同步 API，零配置）
 * 表：sessions / messages / plugin_state / cache_entries（v1 用内存缓存，表预留）
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { LLMRole, Message, Session, ToolCall } from '../kernel/types';
import { decryptSecret, encryptSecret, isEncrypted } from './secrets';

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
  /** 主密钥：传入则 api_key 加密落库（读取时解密）；缺省（测试/无密钥环境）明文兜底 */
  private secretKey?: Buffer;

  constructor(dbFile: string, opts: { secretKey?: Buffer } = {}) {
    this.secretKey = opts.secretKey;
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
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL,
        history TEXT NOT NULL, created_at INTEGER NOT NULL
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
    // 迁移：sessions.role 列（handoff 角色移交：当前接管角色，空 = 主代理）
    if (!sCols.some((c) => c.name === 'role')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    }
    // 凭据迁移：带主密钥首次启动时，已存在的明文 api_key 自动加密落库（幂等）
    if (this.secretKey) {
      const plainRows = this.db.prepare('SELECT id, api_key AS apiKey FROM providers').all() as { id: string; apiKey: string }[];
      const upd = this.db.prepare('UPDATE providers SET api_key = ? WHERE id = ?');
      for (const row of plainRows) {
        if (!row.apiKey || isEncrypted(row.apiKey)) continue;
        upd.run(this.encryptKey(row.apiKey), row.id);
      }
      if (plainRows.some((r) => r.apiKey && !isEncrypted(r.apiKey))) {
        console.log('[store] 已迁移明文 api_key 为加密存储');
      }
    }
  }

  /** 关闭数据库连接（嵌入场景清理临时数据目录前调用，释放 Windows 文件句柄） */
  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  // ---------- providers（网页端管理，DB 为唯一来源；api_key 加密落库） ----------

  /** 解密存储密钥（唯一出口）；无主密钥时原样透传（明文兜底） */
  private decryptKey(blob: string): string {
    if (!this.secretKey || !blob) return blob;
    try {
      return decryptSecret(blob, this.secretKey);
    } catch (err) {
      console.warn('[store] api_key 解密失败（密钥变更或密文损坏），该 Provider 将不可用:',
        err instanceof Error ? err.message : String(err));
      return '';
    }
  }

  /** 加密落库（唯一入口）；无主密钥时明文写入（向后兼容测试/无密钥环境） */
  private encryptKey(plain: string): string {
    if (!this.secretKey || !plain) return plain;
    return encryptSecret(plain, this.secretKey);
  }

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows.map((r) => ({ ...r, apiKey: this.decryptKey(r.apiKey) }));
  }

  getProvider(id: string): ProviderRow | undefined {
    const r = this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined;
    return r ? { ...r, apiKey: this.decryptKey(r.apiKey) } : undefined;
  }

  upsertProvider(p: {
    id: string; label: string; baseUrl: string; apiKey: string; model: string;
    priceIn?: number; priceOut?: number; enabled?: number;
  }): void {
    const now = Date.now();
    const storedKey = this.encryptKey(p.apiKey);
    const existing = this.getProvider(p.id);
    if (existing) {
      this.db
        .prepare('UPDATE providers SET label=?, base_url=?, api_key=?, model=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=?')
        .run(p.label, p.baseUrl, storedKey, p.model, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? existing.enabled, now, p.id);
    } else {
      this.db
        .prepare('INSERT INTO providers (id, label, base_url, api_key, model, price_in, price_out, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(p.id, p.label, p.baseUrl, storedKey, p.model, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? 1, now, now);
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
      .prepare('SELECT id, title, model, mode, plan_pending AS planPending, role, archived, pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, model: r.model as string,
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
      archived: (r.archived as number) ?? 0, pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number, updatedAt: r.updatedAt as number,
    }));
  }

  getSession(id: string): Session | undefined {
    const r = this.db
      .prepare('SELECT id, title, model, mode, plan_pending AS planPending, role, archived, pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, title: r.title as string, model: r.model as string,
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
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

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'model' | 'mode' | 'planPending' | 'role' | 'archived' | 'pinned'>>): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE sessions SET title = ?, model = ?, mode = ?, plan_pending = ?, role = ?, archived = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? cur.title, patch.model ?? cur.model, patch.mode ?? cur.mode,
        patch.planPending ?? cur.planPending,
        // role 允许显式清空（'' = 交回主代理）：不能用 ??（空串是合法值）
        patch.role !== undefined ? patch.role : cur.role ?? '',
        patch.archived ?? cur.archived, patch.pinned ?? cur.pinned, Date.now(), id,
      );
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** 删除会话（事务原子：messages 与 sessions 双删要么都成、要么都不成——参照 deleteSessions 写法） */
  deleteSession(id: string): void {
    this.deleteSessions([id]);
  }

  /** 批量删除会话（事务原子：全部成功或全部失败）
   *  同步清理 agent_checkpoints——否则删除后 resume=true 会从孤儿断点"复活"已删会话 */
  deleteSessions(ids: string[]): number {
    if (ids.length === 0) return 0;
    const delMsg = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const delCp = this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?');
    const delSess = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) {
        delMsg.run(id);
        delCp.run(id);
        delSess.run(id);
      }
    });
    tx(ids);
    return ids.length;
  }

  /** 清空会话消息（保留会话本身，/clear 命令用）
   *  同步清理断点：清空后 resume 不应再恢复旧任务历史 */
  clearSessionMessages(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?').run(id);
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
      // rowid 次排序：created_at 相同的消息（同毫秒写入）顺序固定，
      // 保证每次组装的历史字节级一致——L3 前缀缓存（provider KV cache）依赖前缀稳定
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
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

  /** 事务化回写：单事务内 delete + 批量 insert（压缩/截断结果持久化用）——
   *  中途失败整体回滚，不再出现「旧消息已清、新消息未写完」的丢历史窗口。 */
  replaceSessionMessages(sessionId: string, messages: Omit<Message, 'id' | 'createdAt' | 'sessionId'>[]): void {
    const del = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const ins = this.db
      .prepare(`INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = this.db.transaction((list: Omit<Message, 'id' | 'createdAt' | 'sessionId'>[]) => {
      del.run(sessionId);
      for (const m of list) {
        ins.run(
          randomUUID(), sessionId, m.role, m.content,
          m.reasoning ?? null,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.cost ?? 0,
          m.traceId ?? null, Date.now(),
        );
      }
    });
    tx(messages);
  }

  /** 消息结算回填：assistant 消息经 onHistoryMessage 先入库（保持历史字节一致），
   *  run 结束后再补写 tokens/cost/reasoning（结算时才有的字段）。 */
  updateMessageStats(id: string, patch: { reasoning?: string; tokensIn?: number; tokensOut?: number; cost?: number; traceId?: string }): void {
    this.db
      .prepare('UPDATE messages SET reasoning=?, tokens_in=?, tokens_out=?, cost=?, trace_id=? WHERE id=?')
      .run(
        patch.reasoning ?? null,
        patch.tokensIn ?? 0, patch.tokensOut ?? 0, patch.cost ?? 0,
        patch.traceId ?? null, id,
      );
  }

  // ---------- 断点续跑（checkpoint：turn 级自动保存完整历史，resume 从断点继续） ----------

  /** checkpoint 历史尺寸上限（M6）：超长任务（工具密集型可跑数百轮）不能把任意大的
   *  history 无界写进 DB——超过则保留最新 N 条并附截断标记字段。 */
  static readonly MAX_CHECKPOINT_HISTORY = 200;

  /** 保存会话最新断点（upsert：每会话只保留最新——长任务的恢复点是"最近完成的轮"）
   *  history 必须保存完整字段（role/content/tool_calls/tool_call_id）——恢复时
   *  assistant 的 tool_calls 与 tool 回填必须配对，否则 provider 校验失败。
   *  M6：超上限时保留最新 200 条并附 truncated/originalLength 标记；头部孤儿 tool
   *  回填（配对的 assistant tool_calls 已被截掉）一并丢弃——provider 拒绝无主 tool 消息。 */
  saveCheckpoint(sessionId: string, turn: number, history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]): void {
    let kept = history;
    let truncated = false;
    const originalLength = history.length;
    if (history.length > Store.MAX_CHECKPOINT_HISTORY) {
      kept = history.slice(-Store.MAX_CHECKPOINT_HISTORY);
      while (kept.length > 0 && kept[0].role === 'tool') kept = kept.slice(1);
      truncated = true;
    }
    const payload = truncated ? { messages: kept, truncated: true, originalLength } : { messages: kept };
    this.db
      .prepare(`INSERT INTO agent_checkpoints (session_id, turn, history, created_at) VALUES (?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET turn=excluded.turn, history=excluded.history, created_at=excluded.created_at`)
      .run(sessionId, turn, JSON.stringify(payload), Date.now());
  }

  /** 读取会话断点（无断点返回 undefined） */
  loadCheckpoint(sessionId: string): { turn: number; history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]; createdAt: number; truncated?: boolean; originalLength?: number } | undefined {
    const r = this.db.prepare('SELECT turn, history, created_at AS createdAt FROM agent_checkpoints WHERE session_id = ?').get(sessionId) as
      | { turn: number; history: string; createdAt: number }
      | undefined;
    if (!r) return undefined;
    try {
      const parsed = JSON.parse(r.history) as unknown;
      // 兼容两种格式：旧格式 history 列直接存消息数组；新格式存 { messages, truncated?, originalLength? }
      if (Array.isArray(parsed)) return { turn: r.turn, history: parsed, createdAt: r.createdAt };
      const obj = parsed as { messages?: unknown; truncated?: boolean; originalLength?: number };
      if (obj && Array.isArray(obj.messages)) {
        return { turn: r.turn, history: obj.messages, truncated: obj.truncated, originalLength: obj.originalLength, createdAt: r.createdAt };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 清除会话断点（任务完成/新任务开始时） */
  clearCheckpoint(sessionId: string): void {
    this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?').run(sessionId);
  }

  // ---------- 统计 ----------

  /** 每会话用量聚合（M1 SQL 下推）：stats 页与 chat 端点的会话成本汇总直接
   *  走 GROUP BY，不再逐会话 listMessages 全量拉 content。
   *  truncations = system 注入的截断说明消息计数（与 statsOverview 同口径）；
   *  chars = content 字符数合计（供上下文占用近似估算）。 */
  aggregateSessions(): { sessionId: string; tokensIn: number; tokensOut: number; cost: number; messages: number; truncations: number; chars: number }[] {
    return this.db
      .prepare(`SELECT session_id AS sessionId,
                  COALESCE(SUM(tokens_in), 0) AS tokensIn,
                  COALESCE(SUM(tokens_out), 0) AS tokensOut,
                  COALESCE(SUM(cost), 0) AS cost,
                  COUNT(*) AS messages,
                  COALESCE(SUM(CASE WHEN role = 'system' AND content LIKE '%上下文管理%' THEN 1 ELSE 0 END), 0) AS truncations,
                  COALESCE(SUM(LENGTH(COALESCE(content, ''))), 0) AS chars
                FROM messages GROUP BY session_id`)
      .all() as { sessionId: string; tokensIn: number; tokensOut: number; cost: number; messages: number; truncations: number; chars: number }[];
  }

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
