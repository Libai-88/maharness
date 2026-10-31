/**
 * kernel/config.ts —— 分层配置
 * defaults → config.json（用户） → 显式 env → 运行时修改（最高）
 * 变更发布 config.changed 事件，支持热更新。
 *
 * 两种写入，语义不同（刻意为之）：
 *  - `set(key, value)`：运行期修改，**不落盘**。进程重启即回到默认值。
 *    用于自动降级这类「不该被固化的瞬时决策」——例如 warmup 探针一次失败就把
 *    `cache.warmup` 置 off：若落盘，一次网络抖动会永久关闭全局预热且无法从界面恢复。
 *  - `setPersistent(key, value)`：用户显式改动，落盘到 config.json（防抖 + 原子替换）。
 *    用于 /api/config 这类界面/外部发起的配置修改——用户改了就应该下次还在。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from './bus';
import { atomicWriteFileSync, ConcurrentWriteError, fileRevisionSync } from './atomic-file';

/** 防抖落盘间隔（毫秒）：一次 PATCH 会写多个键，合并成一次磁盘写 */
const PERSIST_DEBOUNCE_MS = 200;

/** 按键路径（a.b.c）写入嵌套对象；中间层不是对象时替换为对象 */
function writeAtPath(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/** 按键路径读取（值为显式 null/undefined 时返回 undefined） */
function readAtPath(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, root);
}

export class Config {
  private store: Record<string, unknown>;
  /** 待落盘的**键路径 → 值**（扁平表，不做嵌套合并）：
   *  对象值（如 agent.modelRouting）整颗子树按写入方给的内容覆盖，
   *  逐个叶键合并会让被删除的路由条目残留在文件里。 */
  private pending = new Map<string, unknown>();
  private persistTimer?: NodeJS.Timeout;
  private persistedRevision: string = 'missing';
  private lastPersistError: 'concurrent_write' | 'write_failed' | undefined;

  constructor(
    private bus: EventBus,
    defaults: Record<string, unknown> = {},
    private readonly configPath?: string,
  ) {
    this.persistedRevision = configPath ? fileRevisionSync(configPath) : 'missing';
    // 键路径归一化：defaults/config.json 里既可能写嵌套（{agent:{maxTurns:12}}），
    // 也可能写点路径平铺（{'agent.maxTurns':12}）——两种都应当可用。
    // 旧实现用 Object.assign 直接灌进 store，平铺键读不到（get 走点路径下钻，
    // 而 store 里的键名字面就是 'agent.maxTurns'）。
    this.store = {};
    for (const [k, v] of Object.entries(defaults)) writeAtPath(this.store, k, v);
    if (configPath && existsSync(configPath)) {
      try {
        const userCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (userCfg && typeof userCfg === 'object' && !Array.isArray(userCfg)) {
          for (const [k, v] of Object.entries(userCfg as Record<string, unknown>)) writeAtPath(this.store, k, v);
        }
      } catch (err) {
        console.warn(`[config] 读取 ${configPath} 失败，忽略用户配置:`, err);
      }
    }
  }

  /** 读取配置，支持点路径（a.b.c）。
   *  值为显式 null 时同样回退默认值——null 常被用作"显式清空"（config.json 里占位），
   *  与 undefined 一样视为"未设置"，避免把 null 透传给数值/布尔消费方。 */
  get<T>(key: string, def?: T): T {
    const value = readAtPath(this.store, key);
    return (value === undefined || value === null ? def : value) as T;
  }

  /** 运行时修改（最高层），广播 config.changed；**不落盘**（落盘请用 setPersistent） */
  set(key: string, value: unknown): void {
    writeAtPath(this.store, key, value);
    this.bus.emit(EventBus.event('config.changed', { key, value }));
  }

  /** 用户显式改动：改内存 + 落盘（防抖合并写，失败只告警不抛）。
   *  未绑定 config 路径时（如测试内的临时内核）等价于 set——只改内存。 */
  setPersistent(key: string, value: unknown): void {
    this.set(key, value);
    this.pending.set(key, value);
    this.schedulePersist();
  }

  /**
   * Validate and persist a group of explicit changes before publishing them to runtime watchers.
   * A failed disk commit leaves the supplied changes unapplied.
   */
  setPersistentBatch(entries: readonly (readonly [string, unknown])[], expectedRevision?: string): boolean {
    if (entries.length === 0) return true;
    if (!this.configPath) {
      for (const [key, value] of entries) this.set(key, value);
      return true;
    }

    const changes = new Map(this.pending);
    for (const [key, value] of entries) changes.set(key, value);
    if (!this.persistValues(changes, expectedRevision)) return false;

    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.pending.clear();
    for (const [key, value] of entries) this.set(key, value);
    return true;
  }

  /** 防抖安排一次落盘 */
  private schedulePersist(): void {
    if (!this.configPath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    // 不因落盘定时器把事件循环钉住（测试/CLI 场景可正常退出）
    this.persistTimer.unref?.();
  }

  /** 立即落盘（把 pending 合并进现有 config.json，保留用户手写的其它键）。
   *  返回是否成功写出。文件损坏时**拒绝覆写**——不销毁用户配置。 */
  persistNow(): boolean {
    if (!this.configPath || this.pending.size === 0) return false;
    if (!this.persistValues(this.pending)) return false;
    this.pending.clear();
    return true;
  }

  /** Last persistence failure, exposed so HTTP callers can distinguish a stale writer. */
  getPersistentFailureCode(): 'concurrent_write' | 'write_failed' | undefined {
    return this.lastPersistError;
  }

  getPersistedRevision(): string {
    return this.configPath ? fileRevisionSync(this.configPath) : this.persistedRevision;
  }

  private persistValues(values: ReadonlyMap<string, unknown>, expectedRevision?: string): boolean {
    const path = this.configPath;
    if (!path) return false;
    this.lastPersistError = undefined;
    let merged: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const cur = JSON.parse(readFileSync(path, 'utf-8'));
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
          console.warn('[config] config.json 顶层不是对象，拒绝落盘以免破坏用户配置');
          return false;
        }
        merged = cur as Record<string, unknown>;
      } catch (err) {
        // 现有文件解析失败：直接覆写会丢用户内容，因此拒绝并提示
        console.warn(`[config] ${path} 解析失败，拒绝落盘（请先修正该文件）:`, err instanceof Error ? err.message : err);
        return false;
      }
    }
    // 合并增量：每个待落盘键路径整值写入（对象值整颗子树覆盖）
    for (const [keyPath, value] of values) writeAtPath(merged, keyPath, value);
    try {
      atomicWriteFileSync(path, JSON.stringify(merged, null, 2), { expectedRevision: expectedRevision ?? this.persistedRevision });
      this.persistedRevision = fileRevisionSync(path);
      return true;
    } catch (err) {
      this.lastPersistError = err instanceof ConcurrentWriteError ? 'concurrent_write' : 'write_failed';
      console.warn('[config] 配置落盘失败:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** 读取磁盘上某键的当前值（用于校验"已落盘"；无文件返回 undefined） */
  getPersisted<T>(key: string): T | undefined {
    if (!this.configPath || !existsSync(this.configPath)) return undefined;
    try {
      return readAtPath(JSON.parse(readFileSync(this.configPath, 'utf-8')), key) as T;
    } catch {
      return undefined;
    }
  }

  /** 插件的独立配置命名空间：config.<pluginId>.* */
  section(pluginId: string): Record<string, unknown> {
    return (this.get<Record<string, unknown>>(pluginId) ?? {});
  }

  /** 生效配置的浅引用（defaults ← config.json ← 运行时 set）。
   *  仅供内核内部需要「看到配置全貌」的场合使用（如依赖签名对通配键取值）；
   *  插件侧仍只应经 get/section 读配置——不对外承诺可写。 */
  snapshot(): Record<string, unknown> {
    return this.store;
  }

  /**
   * 声明式配置对账：订阅某配置键的变化（精确键 + 通配符，如 'agent.*'）。
   * 返回退订函数。与 config.changed 事件的区别：按「变了哪个键」分派（最小干预），
   * 而不是让每个监听器收到全部变更自己过滤。
   */
  watch(pattern: string, cb: (key: string, value: unknown) => void): () => void {
    const off = this.bus.on('config.changed', (e) => {
      const { key, value } = (e.data ?? {}) as { key?: string; value?: unknown };
      if (typeof key !== 'string') return;
      if (pattern === key || pattern === '*' || (pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1)))) {
        cb(key, value);
      }
    });
    return off;
  }
}

/** 常用路径：项目根、数据目录 */
export function paths(rootDir: string) {
  return {
    root: rootDir,
    data: join(rootDir, 'data'),
    traces: join(rootDir, 'data', 'traces'),
    configFile: join(rootDir, 'config.json'),
    dbFile: join(rootDir, 'data', 'agent.db'),
    cacheFile: join(rootDir, 'data', 'cache.json'),
  };
}

export type Paths = ReturnType<typeof paths>;
