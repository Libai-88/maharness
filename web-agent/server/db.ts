/**
 * server/db.ts —— SQLite 持久化（better-sqlite3，同步 API，零配置）
 * 表（与 CREATE TABLE 一致）：sessions / messages / providers / models / personas
 *   / workspaces / agent_checkpoints / plugin_state
 * 注：plugin_state 是预留位（建表但全仓无读写——插件状态现由内核注册表与 plugin.json 承载）；
 *     缓存**不落库**，落 data/cache.json（见 kernel/cache.ts 的 save/load）。
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMRole, Message, Session, ToolCall } from '../kernel/types';
import { decryptSecret, encryptSecret, isEncrypted, SECRET_PREFIX } from './secrets';
import type { SecretKeyInfo } from './secrets';

/**
 * 不该出现在用户眼里的消息前缀——**单一出处**。
 * 这些是 harness 的上下文工程产物，但它们是以 user/system 行真实入库的
 * （发送序列忠实镜像，为的是 L3 前缀缓存逐字节延续）：
 *   【继续】      agent 每轮结尾规整补的续跑提示
 *   【失败教训】  失败反思注入
 *   【长期记忆】  分层记忆注入
 *   【角色移交】  角色接管的提示词
 *   Reason in ENGLISH  英文思考提醒
 * 消息接口（GET /api/sessions/:id/messages）与侧栏摘要（listSessions 的 lastMsg）
 * 必须用同一份规则过滤，否则会出现"聊天里没有、侧栏摘要却是它"的错位。
 */
export const HIDDEN_MSG_PREFIXES = ['【继续】', '【失败教训】', '【长期记忆】', '【角色移交】', 'Reason in ENGLISH'] as const;

/** 该内容是否属于"内部上下文工程"（不进用户可见的对话流） */
export function isHiddenMessage(role: string, content: string | null | undefined): boolean {
  const c = String(content ?? '');
  if (role === 'system' && c.startsWith('Reason in ENGLISH')) return true;
  return HIDDEN_MSG_PREFIXES.some((p) => p !== 'Reason in ENGLISH' && c.startsWith(p));
}

/** 网页端管理的 Provider 配置行 */
export interface ProviderRow {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 协议族：openai（含各家兼容端点）| anthropic | ollama */
  protocol: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
  /**
   * A7-2：该行存的是 `v1:` 密文，但本次运行解不开（主密钥丢失/更换，或密文损坏）。
   * **不落库**——由 Store 在读取时现算现填，因此重启后仍会如实复现。
   * 存在意义：此前解密失败静默返回空串，UI 只能显示「未配置 key」或沿用旧值，
   * 用户看到的是「莫名其妙 401」而不是「密钥不可解」这个真实故障。
   * 前端接线（设置页横幅）由 ui/ 侧另行完成；`GET /api/security` 已经聚合暴露（index.ts）。
   */
  keyBroken?: boolean;
  /** 不可解原因：decrypt-failed（密钥不符/密文损坏）| no-master-key（本次无主密钥） */
  keyBrokenReason?: string;
}

/** 主密钥状态快照（供 /api/security 与启动日志共用同一口径） */
export interface StoreKeyStatus {
  /** 本次运行是否持有可用主密钥 */
  hasMasterKey: boolean;
  /** 库里存在 v1: 密文（无论能否解密） */
  hasCiphertext: boolean;
  /** 密钥不可解的 provider 明细 */
  broken: { id: string; label: string; reason: string }[];
}

export interface AuthorizationAuditRow {
  id: number;
  occurredAt: number;
  outcome: 'granted' | 'denied' | 'connected' | 'disconnected';
  subject: string;
  capability: string;
  object: string;
  reason: string | null;
}

/** Optimistic write failure: caller must reload the current row before retrying. */
export class ConcurrentStoreWriteError extends Error {
  readonly code = 'concurrent_write';
  constructor(readonly entity: string, readonly id: string) {
    super(`${entity} 已被其他写入者修改：${id}`);
    this.name = 'ConcurrentStoreWriteError';
  }
}

/** 模型能力行（一个 Provider 可挂多个模型，路由按能力谓词选路） */
export interface ModelRow {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutput: number | null;
  vision: number;
  tools: number;
  reasoning: number;
  priceIn: number | null;
  priceOut: number | null;
  enabled: number;
  /** pulled=拉取时顺带解析 / inferred=内置目录推断 / manual=用户手填 */
  source: string;
  latencyMs: number | null;
  privacyTier: 'local' | 'trusted' | 'external' | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
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
  /** 主密钥来历（A7）：决定状态接口里的 hasMasterKey 口径；未传时按有无密钥推断 */
  private readonly masterKey?: SecretKeyInfo;
  private checkpointRetentionMs: number;
  /**
   * A7-2：本次运行中「解不开密」的 provider（id → 原因），读取时实时维护。
   * 只在内存——密钥换了就是换了，重启后按新一遍读取如实复现，比落库一个状态列更不易失真。
   */
  private readonly brokenKeys = new Map<string, string>();
  /** 已告警过的 provider（避免状态接口/列表轮询把解密失败刷成日志洪水） */
  private readonly warnedKeys = new Set<string>();
  /** 库里是否见过 v1: 密文（迁移循环/解密路径顺带记录，供状态接口） */
  private seenCiphertext = false;

  constructor(dbFile: string, opts: { secretKey?: Buffer; masterKey?: SecretKeyInfo; checkpointRetentionMs?: number } = {}) {
    this.secretKey = opts.secretKey;
    this.masterKey = opts.masterKey;
    this.checkpointRetentionMs = Number.isFinite(opts.checkpointRetentionMs) ? Math.max(60_000, Math.floor(opts.checkpointRetentionMs!)) : Store.CHECKPOINT_RETENTION_MS;
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    try {
      this.migrate(dbFile);
      this.applyColumnMigrations();
    } catch (err) {
      // 启动自检失败时释放连接：否则损坏/版本不匹配的库会一直占着文件句柄，
      // Windows 下既无法换入恢复备份，进程退出前也无法删除。
      try { this.db.close(); } catch { /* 已关闭 */ }
      throw err;
    }
  }

  /** 当前数据库 schema 版本（PRAGMA user_version） */
  get schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }));
  }

  /** 校验数据库完整性（integrity_check）；返回错误清单（空 = 通过） */
  integrityCheck(): string[] {
    const rows = this.db.pragma('integrity_check') as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
  }

  /** 一致性维护：checkpoint 清理 + WAL 截断（备份前/日常维护调用） */
  vacuum(): void {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 只读连接等场景下失败不致命 */ }
  }

  /** 热备份到目标路径（better-sqlite3 backup API：备份过程中页面写入不中断） */
  backupTo(targetFile: string): Promise<void> {
    return this.db.backup(targetFile) as unknown as Promise<void>;
  }

  /**
   * schema 版本化迁移。
   * - 新库：`user_version` 为 0 且无任何用户表 → 直接写入当前版本。
   * - 旧库：`user_version` 为 0 但已有用户表 → 认定为 v1 之前的历史库；基线结构
   *   与「新库直接建当前 schema」等价（列级增量由下方 CREATE 后的幂等 ALTER 兜底），
   *   因此直接提升到当前版本，不重复执行已随时间累积过的变更。
   * - 已知更高版本：库来自更新的程序版本，fail-closed 拒绝打开（不猜测降级行为）。
   * - 未来新增破坏性变更：在 MIGRATIONS 追加 `from → run` 步骤（迁移内可再写 DDL），
   *   每步完成后推进 user_version；失败中断且库保留在旧版本，启动自检拒绝运行。
   */
  private migrate(dbFile: string): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current > Store.DB_SCHEMA_VERSION) {
      throw new Error(`数据库 schema 版本 ${current} 高于本程序支持的 ${Store.DB_SCHEMA_VERSION}（库来自更新的版本），已拒绝打开以避免破坏数据——请升级程序或恢复备份`);
    }
    if (current === Store.DB_SCHEMA_VERSION) return;
    if (current === 0) {
      // 新库（无表）与历史库（本机制引入版本号之前建立、已有表）统一走基线建表：
      // 基线 schema 与当前版本一致，CREATE IF NOT EXISTS 对两者都幂等。
      this.createBaselineSchema();
      this.db.pragma(`user_version = ${Store.DB_SCHEMA_VERSION}`);
      return;
    }
    for (const step of Store.MIGRATIONS) {
      if (step.from < current) continue;
      if (step.from !== current) break;
      try {
        this.db.transaction(() => {
          step.run(this.db);
          this.db.pragma(`user_version = ${step.to}`);
        })();
      } catch (err) {
        throw new Error(`数据库迁移 ${step.from} → ${step.to} 失败，已保留在旧版本（可从备份恢复）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (Number(this.db.pragma('user_version', { simple: true })) !== Store.DB_SCHEMA_VERSION) {
      throw new Error(`数据库 schema 版本推进不完整（目标 ${Store.DB_SCHEMA_VERSION}），启动拒绝：${dbFile}`);
    }
  }

  /** 基线建表（新库与历史库统一走这条路径；列级增量由幂等 ALTER 兜底） */
  private createBaselineSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新会话',
        model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0,
        trace_id TEXT, task_verification TEXT, created_at INTEGER NOT NULL
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
        session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, run_id TEXT,
        history TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tool_effects (
        run_id TEXT NOT NULL, effect_key TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, effect_key)
      );
      CREATE TABLE IF NOT EXISTS models (
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        context_window INTEGER, max_output INTEGER,
        vision INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0,
        reasoning INTEGER NOT NULL DEFAULT 0,
        price_in REAL, price_out REAL, enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'manual', latency_ms INTEGER, privacy_tier TEXT, risk_level TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS authorization_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('granted', 'denied', 'connected', 'disconnected')),
        subject TEXT NOT NULL,
        capability TEXT NOT NULL,
        object TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_authorization_audit_time ON authorization_audit(occurred_at DESC);
    `);
  }

  /** 数据库自动维护：启动备份（保留最近 N 份）+ 完整性校验 + 损坏自动恢复。 */
  static autoMaintain(dbFile: string): void {
    const dataDir = dbFile.slice(0, dbFile.lastIndexOf(process.platform === 'win32' ? '\\' : '/') || undefined) || '.';
    const backupDir = join(dataDir, 'backups');
    const backupPath = join(backupDir, `agent-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
    try { mkdirSync(backupDir, { recursive: true }); } catch { /* 已存在 */ }
    try {
      copyFileSync(dbFile, backupPath);
      // WAL 内容一并复制（journal_mode=WAL 下主文件可能落后于最新提交）
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(dbFile + suffix)) copyFileSync(dbFile + suffix, backupPath + suffix);
        else { try { rmSync(backupPath + suffix, { force: true }); } catch { /* 无伴生文件 */ } }
      }
    } catch (err) {
      console.warn('[store] 启动备份失败（继续启动，不影响数据）:', err instanceof Error ? err.message : String(err));
    }
    // 轮转：只保留最近 N 份（按文件名排序，时间戳即字典序）
    try {
      const files = readdirSync(backupDir).filter((f) => /^agent-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort();
      while (files.length > Store.BACKUP_KEEP) rmSync(join(backupDir, files.shift()!), { force: true });
    } catch { /* 轮转失败不阻断启动 */ }
    // 完整性校验：损坏则从最近备份恢复
    try {
      const probe = new Database(dbFile, { readonly: true });
      try {
        const rows = probe.pragma('integrity_check') as { integrity_check: string }[];
        const bad = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
        if (bad.length === 0) return;
        console.error(`[store] 数据库完整性校验失败: ${bad.slice(0, 5).join('; ')}——尝试从最近备份恢复`);
      } finally { probe.close(); }
    } catch (err) {
      console.warn(`[store] 数据库无法只读打开（视为损坏）: ${err instanceof Error ? err.message : String(err)}——尝试从最近备份恢复`);
    }
    const backups = (() => {
      try { return readdirSync(backupDir).filter((f) => /^agent-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse(); }
      catch { return []; }
    })();
    for (const candidate of backups) {
      const src = join(backupDir, candidate);
      try {
        const probe = new Database(src, { readonly: true });
        try {
          const rows = probe.pragma('integrity_check') as { integrity_check: string }[];
          if (rows.some((r) => r.integrity_check !== 'ok')) continue;
        } finally { probe.close(); }
        // 校验通过 → 原子换入（先留损坏现场）
        try { copyFileSync(dbFile, `${dbFile}.corrupt-${Date.now()}`); } catch { /* 损坏文件可能已不可读 */ }
        copyFileSync(src, dbFile);
        for (const suffix of ['-wal', '-shm']) {
          try { rmSync(dbFile + suffix, { force: true }); } catch { /* 无伴生文件 */ }
          if (existsSync(src + suffix)) copyFileSync(src + suffix, dbFile + suffix);
        }
        console.log(`[store] 已从备份 ${candidate} 恢复数据库`);
        return;
      } catch { continue; }
    }
    console.error('[store] 没有可用备份能通过完整性校验——保留损坏现场并继续启动（新写入可能失败）');
  }

  /** 版本化迁移步骤表：新 schema 变更在此追加，逐版本推进（每步事务化 + 可回滚） */
  static readonly MIGRATIONS: readonly { from: number; to: number; run: (db: Database.Database) => void }[] = [
    // 示例占位（v0 → v1 不在此表：历史库与新库都直接走 createBaselineSchema）。
    // 未来新增破坏性变更时追加：{ from: 1, to: 2, run: (db) => db.exec('...') }
  ];

  /** 数据库 schema 当前版本（结构演进时递增并补 MIGRATIONS 步骤） */
  static readonly DB_SCHEMA_VERSION = 1;
  /** 启动备份保留份数（data/backups/ 下最多保留多少份） */
  static readonly BACKUP_KEEP = 7;

  /** 列出 data/backups/ 下现有备份文件（供管理端点展示） */
  static listBackups(dbFile: string): { name: string; sizeBytes: number; modifiedAt: number }[] {
    const dataDir = dbFile.slice(0, dbFile.lastIndexOf(process.platform === 'win32' ? '\\' : '/') || undefined) || '.';
    const backupDir = join(dataDir, 'backups');
    try {
      return readdirSync(backupDir)
        .filter((f) => /^agent-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .reverse()
        .map((name) => {
          const st = statSync(join(backupDir, name));
          return { name, sizeBytes: st.size, modifiedAt: st.mtimeMs };
        });
    } catch { return []; }
  }

  /** 列级幂等迁移与凭据加密迁移（migrate 版本推进之后执行，兼容旧库增列） */
  private applyColumnMigrations(): void {
    // 迁移：providers.protocol 列（协议族，旧库默认 openai 兼容）
    const pCols = this.db.prepare(`PRAGMA table_info(providers)`).all() as { name: string }[];
    if (!pCols.some((c) => c.name === 'protocol')) {
      this.db.exec("ALTER TABLE providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'");
    }
    // 迁移：reasoning 列（旧库无此列）
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    }
    if (!cols.some((c) => c.name === 'task_verification')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN task_verification TEXT');
    }
    // 迁移：sessions.mode 列（普通/计划/目标模式）
    const sCols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    const cpCols = this.db.prepare('PRAGMA table_info(agent_checkpoints)').all() as { name: string }[];
    if (!cpCols.some((c) => c.name === 'run_id')) this.db.exec('ALTER TABLE agent_checkpoints ADD COLUMN run_id TEXT');
    const modelCols = this.db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
    if (!modelCols.some((c) => c.name === 'latency_ms')) this.db.exec('ALTER TABLE models ADD COLUMN latency_ms INTEGER');
    if (!modelCols.some((c) => c.name === 'privacy_tier')) this.db.exec('ALTER TABLE models ADD COLUMN privacy_tier TEXT');
    if (!modelCols.some((c) => c.name === 'risk_level')) this.db.exec('ALTER TABLE models ADD COLUMN risk_level TEXT');
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
    // 迁移：sessions.provider 列（模型所属 provider id，切模型时持久化）
    if (!sCols.some((c) => c.name === 'provider')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
    }
    // 凭据迁移：带主密钥首次启动时，已存在的明文 api_key 自动加密落库（幂等）
    if (this.secretKey) {
      const plainRows = this.db.prepare('SELECT id, api_key AS apiKey FROM providers').all() as { id: string; apiKey: string }[];
      const upd = this.db.prepare('UPDATE providers SET api_key = ? WHERE id = ?');
      const migrate = this.db.transaction((rows: { id: string; apiKey: string }[]) => {
        for (const row of rows) {
          if (isEncrypted(row.apiKey)) this.seenCiphertext = true; // A7：库里确有密文
          if (!row.apiKey || isEncrypted(row.apiKey)) continue;
          upd.run(this.encryptKey(row.apiKey), row.id);
        }
      });
      migrate(plainRows);
      if (plainRows.some((r) => r.apiKey && !isEncrypted(r.apiKey))) {
        console.log('[store] 已迁移明文 api_key 为加密存储');
      }
    }
  }

  /** 关闭数据库连接（嵌入场景清理临时数据目录前调用，释放 Windows 文件句柄） */
  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  appendAuthorizationAudit(entry: Omit<AuthorizationAuditRow, 'id' | 'occurredAt'> & { occurredAt?: number }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO authorization_audit (occurred_at, outcome, subject, capability, object, reason)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        entry.occurredAt ?? Date.now(), entry.outcome, entry.subject, entry.capability, entry.object, entry.reason,
      );
      this.db.prepare(`DELETE FROM authorization_audit WHERE id NOT IN
        (SELECT id FROM authorization_audit ORDER BY id DESC LIMIT 10000)`).run();
    });
    tx();
  }

  listAuthorizationAudit(limit = 100): AuthorizationAuditRow[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit) || 100));
    return this.db.prepare(`SELECT id, occurred_at AS occurredAt, outcome, subject, capability, object, reason
      FROM authorization_audit ORDER BY id DESC LIMIT ?`).all(bounded) as AuthorizationAuditRow[];
  }

  /**
   * 解密存储密钥（唯一出口）；无主密钥时原样透传（明文兜底）。
   * A7-2：解不开**不再静默**——按 provider 记录 keyBroken 原因（内存态，供
   * listProviders/getProvider 的返回行与 keyStatus()），启动时那次 console.warn 之外，
   * 调用方与 /api/security 都能拿到「是哪个 provider、为什么不可解」的结构化事实。
   * 返回值的口径维持原样（失败仍返回空串/透传），避免一次改动同时改掉鉴权头内容；
   * 「不可解」这个故障由 keyBroken 字段承载，前端据此出真实横幅。
   */
  private decryptKey(blob: string, providerId?: string): string {
    if (isEncrypted(blob)) this.seenCiphertext = true;
    if (!this.secretKey || !blob) {
      // 库里是密文而本次运行没有主密钥（secret.key 丢失/异常被保留）：返回值口径
      // 保持历史行为（密文原样透传，见 server/tests/db.spec.ts 对无密钥 Store 的断言），
      // 但**必须记账**：否则调用方只看 apiKey 时又回到「看起来已配置」的假象。
      if (isEncrypted(blob) && providerId) this.brokenKeys.set(providerId, 'no-master-key');
      return blob;
    }
    try {
      const plain = decryptSecret(blob, this.secretKey);
      if (providerId) this.brokenKeys.delete(providerId); // 修好了就摘掉故障标记，不留残余
      return plain;
    } catch (err) {
      if (providerId) {
        // 同一行同一原因只报一次：状态接口/列表轮询不该把日志刷满
        if (!this.warnedKeys.has(providerId)) {
          this.warnedKeys.add(providerId);
          console.warn(`[store] provider ${providerId} 的 api_key 解密失败（密钥变更或密文损坏），该供应商不可用:`,
            err instanceof Error ? err.message : String(err));
        }
        this.brokenKeys.set(providerId, 'decrypt-failed');
      }
      return '';
    }
  }

  /** 加密落库（唯一入口）；无主密钥时明文写入（向后兼容测试/无密钥环境） */
  private encryptKey(plain: string): string {
    if (!this.secretKey || !plain) return plain;
    return encryptSecret(plain, this.secretKey);
  }

  /** 给读取到的行补 keyBroken 字段（唯一装配点，避免各处漏填） */
  private withKeyState(r: ProviderRow): ProviderRow {
    const reason = this.brokenKeys.get(r.id);
    if (!reason) return r;
    return { ...r, keyBroken: true, keyBrokenReason: reason };
  }

  /** 某 provider 的 api_key 当前是否不可解（路由层/状态接口用） */
  isKeyBroken(id: string): boolean {
    return this.brokenKeys.has(id);
  }

  /**
   * A7-2 状态快照：主密钥是否可用 + 哪些 provider 的密钥不可解。
   * `GET /api/security` 直接返回它；调用一次 listProviders 以刷新记账。
   * hasMasterKey 口径优先取 resolveSecretKey() 的结果（无密钥 = 本次没拿到密钥），
   * 未传 masterKey 时退化为「传入了 Buffer」。
   */
  keyStatus(): StoreKeyStatus {
    const rows = this.listProviders();
    return {
      hasMasterKey: this.masterKey ? !!this.masterKey.key : !!this.secretKey,
      hasCiphertext: this.seenCiphertext || rows.some((r) => r.keyBroken),
      broken: rows
        .filter((r) => r.keyBroken)
        .map((r) => ({ id: r.id, label: r.label, reason: r.keyBrokenReason ?? 'decrypt-failed' })),
    };
  }

  // ---------- providers（网页端管理，DB 为唯一来源；api_key 加密落库） ----------

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, protocol, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows.map((r) => this.withKeyState({ ...r, apiKey: this.decryptKey(r.apiKey, r.id) }));
  }

  getProvider(id: string): ProviderRow | undefined {
    const r = this.db
      .prepare('SELECT id, label, base_url AS baseUrl, api_key AS apiKey, model, protocol, price_in AS priceIn, price_out AS priceOut, enabled, created_at AS createdAt, updated_at AS updatedAt FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined;
    return r ? this.withKeyState({ ...r, apiKey: this.decryptKey(r.apiKey, r.id) }) : undefined;
  }

  upsertProvider(p: {
    id: string; label: string; baseUrl: string; apiKey: string; model: string;
    protocol?: string; priceIn?: number; priceOut?: number; enabled?: number; expectedUpdatedAt?: number;
  }): void {
    const now = Date.now();
    // A7-2 连带防护：api_key 不可解时 getProvider 返回空串，PATCH 会把它当成「新值」写回，
    // 于是库里那段仍可恢复的密文被空串覆盖（真·二次数据丢失）。语义改为
    // 「空 = 不改动」：留空时原样保留已存的密文/明文，绝不用空串覆盖。
    let storedKey = this.encryptKey(p.apiKey);
    if (!p.apiKey) {
      const raw = (this.db.prepare('SELECT api_key AS k FROM providers WHERE id = ?').get(p.id) as { k?: string } | undefined)?.k;
      if (raw) storedKey = raw;
    }
    const existing = this.getProvider(p.id);
    const protocol = p.protocol ?? existing?.protocol ?? 'openai';
    if (existing) {
      const updatedAt = Math.max(now, existing.updatedAt + 1);
      const result = p.expectedUpdatedAt === undefined
        ? this.db.prepare('UPDATE providers SET label=?, base_url=?, api_key=?, model=?, protocol=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=?')
          .run(p.label, p.baseUrl, storedKey, p.model, protocol, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? existing.enabled, updatedAt, p.id)
        : this.db.prepare('UPDATE providers SET label=?, base_url=?, api_key=?, model=?, protocol=?, price_in=?, price_out=?, enabled=?, updated_at=? WHERE id=? AND updated_at=?')
          .run(p.label, p.baseUrl, storedKey, p.model, protocol, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? existing.enabled, updatedAt, p.id, p.expectedUpdatedAt);
      if (p.expectedUpdatedAt !== undefined && result.changes !== 1) throw new ConcurrentStoreWriteError('Provider', p.id);
    } else {
      this.db
        .prepare('INSERT INTO providers (id, label, base_url, api_key, model, protocol, price_in, price_out, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.id, p.label, p.baseUrl, storedKey, p.model, protocol, p.priceIn ?? null, p.priceOut ?? null, p.enabled ?? 1, now, now);
    }
  }

  deleteProvider(id: string, expectedUpdatedAt?: number): void {
    const tx = this.db.transaction((providerId: string) => {
      this.db.prepare('DELETE FROM models WHERE provider_id = ?').run(providerId);
      const result = expectedUpdatedAt === undefined
        ? this.db.prepare('DELETE FROM providers WHERE id = ?').run(providerId)
        : this.db.prepare('DELETE FROM providers WHERE id = ? AND updated_at = ?').run(providerId, expectedUpdatedAt);
      if (expectedUpdatedAt !== undefined && result.changes !== 1) throw new ConcurrentStoreWriteError('Provider', providerId);
    });
    tx(id);
    // 故障记账随行 removal 一并清掉，否则状态接口会报一个不存在的 provider
    this.brokenKeys.delete(id);
    this.warnedKeys.delete(id);
  }

  setProviderEnabled(id: string, enabled: number): void {
    this.db.prepare('UPDATE providers SET enabled=?, updated_at=? WHERE id=?').run(enabled, Date.now(), id);
  }

  // ---------- models（Provider 下的模型与能力，路由的事实源） ----------

  listModels(providerId?: string): ModelRow[] {
    const sql = 'SELECT provider_id AS providerId, model_id AS modelId, context_window AS contextWindow, max_output AS maxOutput, vision, tools, reasoning, price_in AS priceIn, price_out AS priceOut, enabled, source, latency_ms AS latencyMs, privacy_tier AS privacyTier, risk_level AS riskLevel, updated_at AS updatedAt FROM models';
    return providerId
      ? this.db.prepare(`${sql} WHERE provider_id = ? ORDER BY model_id ASC`).all(providerId) as ModelRow[]
      : this.db.prepare(`${sql} ORDER BY provider_id ASC, model_id ASC`).all() as ModelRow[];
  }

  upsertModel(m: Partial<ModelRow> & { providerId: string; modelId: string }): void {
    this.upsertModels([m]);
  }

  updateModel(m: Partial<ModelRow> & { providerId: string; modelId: string }, expectedUpdatedAt: number): void {
    const previous = this.listModels(m.providerId).find((row) => row.modelId === m.modelId);
    if (!previous) throw new ConcurrentStoreWriteError('Model', `${m.providerId}@${m.modelId}`);
    const updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
    const result = this.db.prepare(`UPDATE models SET context_window=?, max_output=?, vision=?, tools=?, reasoning=?, price_in=?, price_out=?, enabled=?, source=?, latency_ms=?, privacy_tier=?, risk_level=?, updated_at=?
      WHERE provider_id=? AND model_id=? AND updated_at=?`).run(
      m.contextWindow ?? null, m.maxOutput ?? null, m.vision ?? 0, m.tools ?? 0, m.reasoning ?? 0,
      m.priceIn ?? null, m.priceOut ?? null, m.enabled ?? 1, m.source ?? 'manual',
      m.latencyMs ?? null, m.privacyTier ?? null, m.riskLevel ?? null, updatedAt,
      m.providerId, m.modelId, expectedUpdatedAt,
    );
    if (result.changes !== 1) throw new ConcurrentStoreWriteError('Model', `${m.providerId}@${m.modelId}`);
  }

  /** Batch model refresh is all-or-nothing: a failed capability row cannot leave a partial catalog. */
  upsertModels(models: (Partial<ModelRow> & { providerId: string; modelId: string })[]): void {
    if (models.length === 0) return;
    const statement = this.db.prepare(`
      INSERT INTO models (provider_id, model_id, context_window, max_output, vision, tools, reasoning, price_in, price_out, enabled, source, latency_ms, privacy_tier, risk_level, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        context_window=COALESCE(excluded.context_window, context_window),
        max_output=COALESCE(excluded.max_output, max_output),
        vision=excluded.vision, tools=excluded.tools, reasoning=excluded.reasoning,
        price_in=COALESCE(excluded.price_in, price_in),
        price_out=COALESCE(excluded.price_out, price_out),
        enabled=excluded.enabled,
        source=CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE models.source END,
        latency_ms=COALESCE(excluded.latency_ms, latency_ms),
        privacy_tier=COALESCE(excluded.privacy_tier, privacy_tier),
        risk_level=COALESCE(excluded.risk_level, risk_level),
        updated_at=excluded.updated_at
    `);
    const tx = this.db.transaction((rows: (Partial<ModelRow> & { providerId: string; modelId: string })[]) => {
      for (const m of rows) {
        statement.run(
          m.providerId, m.modelId, m.contextWindow ?? null, m.maxOutput ?? null,
          m.vision ?? 0, m.tools ?? 0, m.reasoning ?? 0,
          m.priceIn ?? null, m.priceOut ?? null, m.enabled ?? 1, m.source ?? 'manual',
          m.latencyMs ?? null, m.privacyTier ?? null, m.riskLevel ?? null, Date.now(),
        );
      }
    });
    tx(models);
  }

  deleteModel(providerId: string, modelId: string): void {
    this.db.prepare('DELETE FROM models WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
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
    // lastMsg/lastRole：侧栏摘要用「最后一句真正说出口的话」——
    // 只取 user / assistant，且排除带 tool_calls 的过程轮（那是旁白不是消息）、
    // 排除空正文（纯工具调用轮的 content 为 null，会渲染成空白气泡/空白摘要）、
    // 排除 harness 注入的"假 user 消息"（【继续】/【长期记忆】等，见 HIDDEN_MSG_PREFIXES）。
    // 相关子查询按 session_id 走 messages_session_idx 反向取一行，会话数量级下开销可忽略。
    const hidden = HIDDEN_MSG_PREFIXES.map((p) => `AND m.content NOT LIKE '${p.replace(/'/g, "''")}%'`).join('\n                           ');
    const rows = this.db
      .prepare(`SELECT s.id, s.title, s.model, s.provider, s.mode, s.plan_pending AS planPending, s.role,
                       s.archived, s.pinned, s.created_at AS createdAt, s.updated_at AS updatedAt,
                       (SELECT SUBSTR(m.content, 1, 120) FROM messages m
                         WHERE m.session_id = s.id AND m.role IN ('user','assistant')
                           AND m.content IS NOT NULL AND m.content <> ''
                           AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                           ${hidden}
                         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastMsg,
                       (SELECT m.role FROM messages m
                         WHERE m.session_id = s.id AND m.role IN ('user','assistant')
                           AND m.content IS NOT NULL AND m.content <> ''
                           AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                           ${hidden}
                         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastRole
                FROM sessions s ORDER BY s.pinned DESC, s.updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, model: r.model as string,
      provider: (r.provider as string) ?? '',
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
      archived: (r.archived as number) ?? 0, pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number, updatedAt: r.updatedAt as number,
      lastMsg: (r.lastMsg as string) ?? '',
      lastRole: (r.lastRole as 'user' | 'assistant' | undefined) ?? undefined,
    }));
  }

  getSession(id: string): Session | undefined {
    const r = this.db
      .prepare('SELECT id, title, model, provider, mode, plan_pending AS planPending, role, archived, pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, title: r.title as string, model: r.model as string,
      provider: (r.provider as string) ?? '',
      mode: (r.mode as string) ?? 'normal', planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
      archived: (r.archived as number) ?? 0, pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number, updatedAt: r.updatedAt as number,
    };
  }

  createSession(model: string, provider: string = ''): Session {
    const s: Session = {
      id: randomUUID(), title: '新会话', model, provider, mode: 'normal', planPending: 0,
      archived: 0, pinned: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO sessions (id, title, model, provider, mode, plan_pending, archived, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, s.title, s.model, s.provider, s.mode, s.planPending, s.archived, s.pinned, s.createdAt, s.updatedAt);
    return s;
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'model' | 'provider' | 'mode' | 'planPending' | 'role' | 'archived' | 'pinned'>>): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE sessions SET title = ?, model = ?, provider = ?, mode = ?, plan_pending = ?, role = ?, archived = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? cur.title, patch.model ?? cur.model,
        patch.provider ?? cur.provider,
        patch.mode ?? cur.mode,
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
    const tx = this.db.transaction((sessionId: string) => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?').run(sessionId);
    });
    tx(id);
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
      taskVerification: r.task_verification ? JSON.parse(r.task_verification as string) as Message['taskVerification'] : undefined,
      createdAt: r.created_at as number,
    }));
  }

  addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
    const msg: Message = { ...m, id: randomUUID(), createdAt: Date.now() };
    this.db
      .prepare(`INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, task_verification, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        msg.id, msg.sessionId, msg.role, msg.content,
        msg.reasoning ?? null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null, msg.tokensIn ?? 0, msg.tokensOut ?? 0, msg.cost ?? 0,
        msg.traceId ?? null, msg.taskVerification ? JSON.stringify(msg.taskVerification) : null, msg.createdAt,
      );
    return msg;
  }

  /** 事务化回写：单事务内 delete + 批量 insert（压缩/截断结果持久化用）——
   *  中途失败整体回滚，不再出现「旧消息已清、新消息未写完」的丢历史窗口。 */
  replaceSessionMessages(sessionId: string, messages: Omit<Message, 'id' | 'createdAt' | 'sessionId'>[]): void {
    const del = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const ins = this.db
      .prepare(`INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, task_verification, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = this.db.transaction((list: Omit<Message, 'id' | 'createdAt' | 'sessionId'>[]) => {
      del.run(sessionId);
      for (const m of list) {
        ins.run(
          randomUUID(), sessionId, m.role, m.content,
          m.reasoning ?? null,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.cost ?? 0,
          m.traceId ?? null, m.taskVerification ? JSON.stringify(m.taskVerification) : null, Date.now(),
        );
      }
    });
    tx(messages);
  }

  updateMessageTaskVerification(id: string, verification: NonNullable<Message['taskVerification']>): void {
    this.db.prepare('UPDATE messages SET task_verification=? WHERE id=?').run(JSON.stringify(verification), id);
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

  updateMessageContent(id: string, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  }

  // ---------- 断点续跑（checkpoint：turn 级自动保存完整历史，resume 从断点继续） ----------

  /** checkpoint 历史尺寸上限（M6）：超长任务（工具密集型可跑数百轮）不能把任意大的
   *  history 无界写进 DB——超过则保留最新 N 条并附截断标记字段。 */
  static readonly MAX_CHECKPOINT_HISTORY = 200;
  /** checkpoint 单行 JSON 上限；超限继续从最早消息裁剪，避免单个会话撑爆 SQLite 页。 */
  static readonly MAX_CHECKPOINT_BYTES = 512 * 1024;
  static readonly CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  static readonly CHECKPOINT_SCHEMA_VERSION = 1;

  setCheckpointRetentionMs(value: number): void {
    if (Number.isFinite(value)) this.checkpointRetentionMs = Math.max(60_000, Math.floor(value));
  }

  /** 保存会话最新断点（upsert：每会话只保留最新——长任务的恢复点是"最近完成的轮"）
   *  history 必须保存完整字段（role/content/tool_calls/tool_call_id）——恢复时
   *  assistant 的 tool_calls 与 tool 回填必须配对，否则 provider 校验失败。
   *  M6：超上限时保留最新 200 条并附 truncated/originalLength 标记；头部孤儿 tool
   *  回填（配对的 assistant tool_calls 已被截掉）一并丢弃——provider 拒绝无主 tool 消息。 */
  saveCheckpoint(sessionId: string, turn: number, history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[], runId?: string, task?: import('../kernel/task-verifier').TaskContract, toolResults?: { name: string; ok: boolean }[], costUsd?: number): void {
    let kept = history;
    let truncated = false;
    const originalLength = history.length;
    if (history.length > Store.MAX_CHECKPOINT_HISTORY) {
      kept = history.slice(-Store.MAX_CHECKPOINT_HISTORY);
      while (kept.length > 0 && kept[0].role === 'tool') kept = kept.slice(1);
      truncated = true;
    }
    let payload = { schemaVersion: Store.CHECKPOINT_SCHEMA_VERSION, messages: kept, ...(truncated ? { truncated: true, originalLength } : {}), ...(task ? { task } : {}), ...(toolResults ? { toolResults } : {}), ...(costUsd === undefined ? {} : { costUsd }) };
    while (JSON.stringify(payload).length > Store.MAX_CHECKPOINT_BYTES && kept.length > 1) {
      kept = kept.slice(1);
      truncated = true;
      payload = { schemaVersion: Store.CHECKPOINT_SCHEMA_VERSION, messages: kept, truncated: true, originalLength, ...(task ? { task } : {}), ...(toolResults ? { toolResults } : {}), ...(costUsd === undefined ? {} : { costUsd }) };
    }
    this.db
      .prepare(`INSERT INTO agent_checkpoints (session_id, turn, run_id, history, created_at) VALUES (?,?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET turn=excluded.turn, run_id=COALESCE(excluded.run_id, agent_checkpoints.run_id), history=excluded.history, created_at=excluded.created_at`)
      .run(sessionId, turn, runId ?? null, JSON.stringify(payload), Date.now());
  }

  /** 读取会话断点（无断点返回 undefined） */
  loadCheckpoint(sessionId: string): { schemaVersion: number; turn: number; runId?: string; task?: import('../kernel/task-verifier').TaskContract; toolResults?: { name: string; ok: boolean }[]; costUsd?: number; history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]; createdAt: number; truncated?: boolean; originalLength?: number } | undefined {
    const r = this.db.prepare('SELECT turn, run_id AS runId, history, created_at AS createdAt FROM agent_checkpoints WHERE session_id = ?').get(sessionId) as
      | { turn: number; runId?: string | null; history: string; createdAt: number }
      | undefined;
    if (!r) return undefined;
    if (Date.now() - r.createdAt > this.checkpointRetentionMs) {
      this.clearCheckpoint(sessionId);
      return undefined;
    }
    try {
      const parsed = JSON.parse(r.history) as unknown;
      // 兼容两种格式：旧格式 history 列直接存消息数组；新格式存 { messages, truncated?, originalLength? }
      if (Array.isArray(parsed)) return { schemaVersion: 0, turn: r.turn, runId: r.runId ?? undefined, history: parsed, createdAt: r.createdAt };
      const obj = parsed as { schemaVersion?: unknown; messages?: unknown; task?: import('../kernel/task-verifier').TaskContract; toolResults?: { name: string; ok: boolean }[]; costUsd?: number; truncated?: boolean; originalLength?: number };
      const schemaVersion = obj?.schemaVersion === undefined ? 1 : obj.schemaVersion;
      if (schemaVersion !== Store.CHECKPOINT_SCHEMA_VERSION) {
        this.clearCheckpoint(sessionId);
        return undefined;
      }
      if (obj && Array.isArray(obj.messages)) {
        return { schemaVersion: Store.CHECKPOINT_SCHEMA_VERSION, turn: r.turn, runId: r.runId ?? undefined, task: obj.task, toolResults: obj.toolResults, costUsd: obj.costUsd, history: obj.messages, truncated: obj.truncated, originalLength: obj.originalLength, createdAt: r.createdAt };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 清除会话断点（任务完成/新任务开始时） */
  clearCheckpoint(sessionId: string): void {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_tool_effects WHERE run_id NOT IN (SELECT run_id FROM agent_checkpoints WHERE run_id IS NOT NULL)').run();
    });
    tx(sessionId);
  }

  claimToolEffect(runId: string, effectKey: string): { state: 'new' | 'done' | 'pending'; result?: import('../kernel/types').ToolResult } {
    const now = Date.now();
    let inserted: { changes: number } = { changes: 0 };
    let row!: { status: string; result: string | null };
    const tx = this.db.transaction(() => {
      inserted = this.db.prepare(`INSERT OR IGNORE INTO agent_tool_effects (run_id,effect_key,status,result,created_at,updated_at)
        VALUES (?,?, 'pending', NULL, ?, ?)`).run(runId, effectKey, now, now);
      row = this.db.prepare('SELECT status, result FROM agent_tool_effects WHERE run_id=? AND effect_key=?').get(runId, effectKey) as { status: string; result: string | null };
    });
    tx();
    if (row.status === 'done' && row.result) {
      try { return { state: 'done', result: JSON.parse(row.result) as import('../kernel/types').ToolResult }; }
      catch { return { state: 'pending' }; }
    }
    return inserted.changes > 0 ? { state: 'new' } : { state: 'pending' };
  }

  completeToolEffect(runId: string, effectKey: string, result: import('../kernel/types').ToolResult): void {
    this.db.prepare(`UPDATE agent_tool_effects SET status='done', result=?, updated_at=? WHERE run_id=? AND effect_key=? AND status='pending'`)
      .run(JSON.stringify(result), Date.now(), runId, effectKey);
  }

  hasPendingToolEffects(runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM agent_tool_effects WHERE run_id=? AND status='pending' LIMIT 1").get(runId);
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

/**
 * A7-3 判定支撑：库里是否已存在 `v1:` 密文（在 Store 打开**之前**问一次）。
 * 用途：主密钥文件缺失/异常时，决定是否允许自动重新生成——有密文就不许静默换密钥。
 * 策略（宁可误保守，不可误覆盖）：
 *  1) 首选只读打开 + SQL 精确判定；
 *  2) 只读打开失败（WAL 需要写 -shm、文件被占用、库刚被别的连接建起等）→
 *     退化为原始字节扫描 `v1:` 前缀：假阳性只会多一次「拒绝重建 + 指引」的告警，
 *     方向是安全的；假阴性才会静默作废密文，所以要尽量避免。
 * 任何异常都不抛出：判定失败按「无密文」处理会让行为回到历史默认（生成新密钥），
 * 因此这里保守返回 true（视为有密文）更合适——只有明确查到 0 行才返回 false。
 */
export function hasEncryptedProviderKeys(dbFile: string): boolean {
  if (!existsSync(dbFile)) return false;
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`).all();
      if (!tables.length) return false; // 老库/空库：没有 providers 表
      const hit = db.prepare(`SELECT 1 AS x FROM providers WHERE api_key LIKE '${SECRET_PREFIX}%' LIMIT 1`)
        .get() as { x?: number } | undefined;
      return !!hit?.x;
    } finally {
      try { db.close(); } catch { /* 忽略 */ }
    }
  } catch (err) {
    console.warn('[store] 只读探测 api_key 密文失败，改用字节扫描兜底:', err instanceof Error ? err.message : String(err));
    try {
      const raw = readFileSync(dbFile, 'latin1');
      return raw.includes(SECRET_LIKE_PREFIX);
    } catch {
      return true; // 读都读不动：按「可能有密文」处理，宁可拒绝重建密钥
    }
  }
}

/** 密文前缀字面量（与 secrets.ts SECRET_PREFIX 一致；SQL LIKE 里用不到通配转义） */
const SECRET_LIKE_PREFIX = 'v1:';
