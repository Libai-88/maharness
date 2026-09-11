/**
 * kernel/plugin-loader.ts —— 插件加载与热管理（时空可组合性 v2）
 *
 * 借鉴 Cordis/DeepSeek 的三大机制，落地为 maharness 的运行时保证：
 *
 * 1. 可逆效应（时序可组合性）：插件通过 ctx 做的一切（register/on/provide/watchConfig）
 *    都在自己的 EffectScope 里留下逆元；卸载时运行时按 LIFO 完全恢复——
 *    清理正确性由运行时保证，不再依赖每个作者在 onUnload 里手工回收。
 *    旧 API（ctx.bus.on）仍可用，但不再自动退订（泄漏由作者负责）。
 *
 * 2. 事务性热重载（HMR with rollback）：reload 时旧实例的副作用先全部回收，
 *    但旧模块保留在内存；新版本 onLoad/onStart 失败 → 用旧模块重建实例（回滚），
 *    系统永不进入"半加载"状态。对 self-extend（agent 自己写插件）是保命机制：
 *    一个坏的自我修改不会禁用掉"需要用来恢复的进程本身"。
 *
 * 3. 反应性共效应（空间可组合性）：提供者 ctx.provide(key, value) / 注册 service 能力
 *    自动成为绑定；依赖方 ctx.inject(key, onChange) 在绑定出现/消失/换主时收到通知。
 *    "依赖不可用则保持等待，出现即激活"——不报错、不悬空。
 *
 * 生命周期状态机：registered → loaded → started ⇄ stopped
 *   载入/卸载/重载期间标记 loading/unloading（先停供再回收，依赖方先于逆元被通知）；
 *   生命周期操作通过每实例的 chain（Promise 串行队列）真排队：并发 start/stop/reload
 *   严格串行执行（替代旧 check-then-act 惯性——旧实现在等待后不再校验，存在竞态窗口）。
 *
 * ESM 残余限制：Node ESM loader 的模块注册表没有卸载 API——内容变化后旧模块记录
 * 常驻进程（见 entryUrl 的 hash 缓解策略），只能减缓无法根除。
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus } from './bus';
import { EffectScope } from './scope';
import { dirDigest, fileDigest, materialize, pruneSnapshots, SNAPSHOT_SUFFIX, type Snapshot } from './plugin-snapshot';
import { validateAgainstSchema } from './validate';
import type {
  Capability, EventListener, NavDef, OutboundRecord, Plugin, PluginBus, PluginContext, PluginManifest, PluginStorage, TraceLike,
} from './types';

type PluginState = 'registered' | 'loaded' | 'started' | 'stopped' | 'loading' | 'unloading' | 'error';

/** B6：config.changed → reloadChanged 的防抖窗口（ms）——连续配置写入合并为一次重载 */
const CONFIG_RELOAD_DEBOUNCE_MS = 400;

/** 生命周期方法默认超时（ms）——防止单个插件的 onLoad/onStart 永久挂起 */
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;
/** 熔断器默认阈值：连续失败 N 次后进入熔断态 */
const DEFAULT_CB_THRESHOLD = 3;
/** 熔断器默认重置时间（ms）：熔断态持续该时长后自动重试 */
const DEFAULT_CB_RESET_MS = 60_000;

/** 内核内置实现的服务提供者标识：内核本体也是仲裁体系里的一个（最低优先级的）
 *  提供者——「内核默认实现」与「插件实现」在解析层完全同构，没有特例分支。 */
export const KERNEL_PROVIDER_ID = 'kernel';

/** 带超时的 Promise 执行：超时后抛出 AbortError，不取消原 Promise（无法真正取消） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[plugin] ${label} 超时（${ms}ms）——插件可能挂起`)), ms),
    ),
  ]);
}

/**
 * 常见错误 → 修复建议映射：将技术性错误信息翻译为用户可操作的指引。
 * 返回建议文本；无匹配时返回 undefined（UI 不展示修复建议区域） */
export function suggestFix(errorMsg: string): string | undefined {
  if (!errorMsg) return undefined;
  const lower = errorMsg.toLowerCase();
  // 依赖缺失
  if (lower.includes('缺少依赖') || lower.includes('missing dep') || lower.includes('依赖未加载')) {
    const match = errorMsg.match(/依赖[插件:\s]+[:：]?\s*(\S+)/);
    const dep = match?.[1] ?? 'xxx';
    return `请先安装并启用依赖插件「${dep}」，然后重试。可在插件市场搜索或手动创建 plugins/${dep}/ 目录。`;
  }
  // 配置校验失败
  if (lower.includes('配置校验失败') || lower.includes('config') && lower.includes('validation')) {
    return '请检查 config.json 中该插件的配置项是否符合 schema 要求（类型/必填/范围），修正后重载插件。';
  }
  // 超时
  if (lower.includes('超时') || lower.includes('timeout')) {
    return '插件启动/加载超时，可能在 onLoad/onStart 中执行了耗时操作或死循环。请检查插件代码中的异步操作是否有 await 遗漏或无限循环。';
  }
  // 入口文件解析失败
  if (lower.includes('plugin.json 解析失败') || lower.includes('syntax') && lower.includes('json')) {
    return 'plugin.json 格式错误（JSON 语法），请用 JSON 校验器检查格式后修复。';
  }
  // 入口文件找不到
  if (lower.includes('cannot find') || lower.includes('does not exist') || lower.includes('模块') && lower.includes('找不到')) {
    return '入口文件不存在或路径错误，请检查 plugin.json 中 "entry" 字段指向的文件是否存在于插件目录中。';
  }
  // id 冲突
  if (lower.includes('id 冲突') || lower.includes('id') && lower.includes('不一致')) {
    return '插件 id 与已注册的插件冲突。请修改 plugin.json 中的 "id" 为唯一值（仅小写字母/数字/连字符）。';
  }
  // 熔断态
  if (lower.includes('熔断') || lower.includes('circuit breaker')) {
    return '插件连续失败已进入熔断保护。系统会在冷却期后自动重试。如需立即重试，请手动触发"重载"。';
  }
  // 权限/沙箱
  if (lower.includes('permission') || lower.includes('eacces') || lower.includes('权限')) {
    return '文件权限不足。请检查插件目录的读写权限，或以管理员身份运行。';
  }
  return undefined;
}

interface PluginInstance {
  manifest: PluginManifest;
  dir: string;
  state: PluginState;
  plugin?: Plugin;
  caps: Capability[];
  /** 可逆效应作用域：插件全部副作用的逆元在此累积，卸载按 LIFO 恢复 */
  scope: EffectScope;
  /** 生命周期串行队列：公开的 start/stop/reload 统一排队到链尾，真串行执行；
   *  reload 提交替换实例时新实例继承链尾（并发排队操作不丢失、不并行） */
  chain: Promise<void>;
  /** 动态提供的服务键（ctx.provide 登记，供依赖图谱可查） */
  provides: string[];
  /** v3 智能重载：依赖声明收集器——插件在 buildContext 里通过 inject/onCapabilities/
   *  watchConfig 登记「我依赖了哪些事实」；recomputeSignature 据此重算依赖签名。 */
  depHooks: (() => string)[];
  /** v3 智能重载：本插件当前依赖签名（由 depHooks 重算，与 factVersion 比对）；
   *  签名变化 → reloadChanged 重载；未变化 → 保留实例（零抖动） */
  depSignature: string;
  /** v3.1 下次 reload 强制刷新 ESM 模块记录：依赖签名变化（如 env 变更）触发 reload
   *  时，目录内容未变 → 默认 URL 命中 Node 模块缓存 → 新值不生效。
   *  置位后 reloadInternal 给入口 URL 追加 `&r=` 维度打破缓存，消费后立即复位。 */
  forceFresh?: boolean;
  /** 实际加载目录：插件目录的内容快照（见 plugin-snapshot）。dir 是身份目录
   *  （manifest 读取 / 目录监听 / 展示），loadDir 是模块基址——内容一变即换目录，
   *  整张模块图随之重建，依赖文件的改动由此真正生效。 */
  loadDir: string;
  /** 本次加载的内容聚合哈希（入口 URL 版本 + 快照清理依据） */
  loadHash: string;
  /** 本生命周期登记的界外发射数（ctx.outbound）：卸载摘要里可见，不随作用域回收 */
  outboundCount?: number;
  /** 上下文配置拦截层，后注册层优先。 */
  configOverrides: Record<string, unknown>[];
  error?: string;
  /** 熔断器状态：连续失败计数 + 熔断激活时间 */
  circuitBreaker: {
    failures: number;
    /** 熔断激活的 mono timestamp（0 = 未激活） */
    openedAt: number;
  };
}

/** 服务绑定：记录提供者身份与提供时刻（服务级调用追踪的数据底座）。
 *  priority 为「可接管」语义的最小实现：同一服务键允许多个提供者并存（不再静默互相覆盖），
 *  优先级最高者生效；生效者卸载时自动回退到次高者——「换实现」不需要先停掉旧的。 */
interface ProviderBinding {
  pluginId: string;
  value: unknown;
  /** 提供时刻 mono 序 + 墙钟（用于可视化「何时被谁提供」） */
  seq: number;
  ts: number;
  /** 接管优先级（大者胜；同值先到者胜）。缺省 0 = 与内核内置默认同权。 */
  priority: number;
  /** 是否已进入仲裁（发布过）。注册期登记的候选此位为 false，由 startInternal 统一激活；
   *  防止「启动期补发布」把已生效的绑定再次当作新声明发布（重复事件/错误语义）。 */
  published?: boolean;
}

export class PluginLoader {
  private registry = new Map<string, PluginInstance>();
  private watcher?: ReturnType<typeof watch>;
  private reloadTimer?: NodeJS.Timeout;
  /** rescan 在途互斥标记：watch 风暴下重入直接返回（防并发重扫/重复 reload） */
  private rescanning = false;
  /** 插件目录 → 上次观察的 mtime 快照（目录级事件跳过未变化插件） */
  private dirMtimes = new Map<string, number>();
  /** 能力集反应性订阅：onCapabilities(kind, cb)——某类能力集合变化时通知 */
  private capSubs = new Map<string, Set<() => void>>();
  /** 服务共效应注册表：key → 当前【生效】提供者绑定（仲裁结果的视图，供解析与追踪读取） */
  private providers = new Map<string, ProviderBinding>();
  /** 服务键 → 全部候选绑定（含未生效者）。生效者 = arbitrate(key) 的胜出者。
   *  多提供者并存是可接管的实现基础：高优先级接管，卸载后自动回退次高者。
   *  每个（键, 插件）至多一条绑定：同插件重复 provide 同一键时按最新一次语义生效——
   *  「归属」因此无歧义（撤销/启动补发布都按插件唯一对应）。 */
  private bindings = new Map<string, Map<string, ProviderBinding>>();
  /** 依赖方注册表：key → 订阅者（绑定出现/消失/换主时通知） */
  private dependents = new Map<string, Set<(v: unknown | undefined) => void>>();
  /** 依赖事实版本（v3 智能重载）：服务绑定/能力集/配置任何变化均递增——
   *  插件 depSignature 基于它，reloadChanged 据此只重载真正依赖变化的插件 */
  private factVersion = 0;
  /** 能力集版本（v3）：按 kind 递增——onCapabilities(kind) 的签名只随该 kind 变化，
   *  避免其余能力变化触发全局重载 */
  private capVersions = new Map<Capability['kind'], number>();
  /** env 依赖版本（v3.1）：按变量名递增——watchEnv(name) 的签名分量随该变量变更；
   *  server 在 .env 变更后经 bumpEnv 递增（智能重载的 env 维度） */
  private envVersions = new Map<string, number>();
  /** env 变化订阅：watchEnv(name, cb) —— .env 变更时立即回调（无需等 reload） */
  private envSubs = new Map<string, Set<(v: string | undefined) => void>>();
  /** B6：全局配置变更慢路径定时器——config.set 任意键都触发依赖驱动重载（防抖），
   *  智能重载保证只动声明了相关 watchConfig 的插件（签名不变者零抖动） */
  private configReloadTimer?: NodeJS.Timeout;
  /** config.changed 监听退订句柄（dispose 时清理，防 loader 销毁后监听器泄漏） */
  private offConfigWatch?: () => void;
  /** 服务绑定单调序号（提供者标识用，非事实版本，仅供追踪可视化排序） */
  private factSeq = 0;

  constructor(
    private bus: EventBus,
    private ctxBase: Omit<PluginContext, 'pluginId' | 'register' | 'logger' | 'bus' | 'on' | 'provide' | 'inject' | 'onCapabilities' | 'watchConfig' | 'watchEnv' | 'configWith' | 'effect' | 'storage' | 'outbound'> & { budget: unknown },
    private coreDir: string,
    private userDir: string,
  ) {
    // 内核内置子系统作为【同权优先级的默认提供者】进入仲裁体系：
    // 内核不再是「不可替换的原语」，而是一个可被接管（provide 同键 + 更高 priority）
    // 的默认实现。Kernel 的 cache/trace/budget 访问器统一从解析层取——
    // 因此「换实现」不需要改任何调用点，也不需要内核知道谁接管了它。
    this.publishBuiltin('service:cache', ctxBase.cache);
    this.publishBuiltin('service:trace', ctxBase.trace);
    this.publishBuiltin('service:budget', ctxBase.budget);

    // B6：任何配置变更（config.set → config.changed）→ 防抖后依赖驱动重载。
    // 与 watchConfig 的「插件自处理」互补：这里保证「声明了配置依赖的插件」在配置
    // 变化后自动 reload（重跑 onLoad 拿到新值），无需任何插件或调用方显式触发。
    this.offConfigWatch = ctxBase.config.watch('*', () => {
      if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = undefined;
        void this.reloadChanged().catch(() => undefined);
      }, CONFIG_RELOAD_DEBOUNCE_MS);
    });
  }

  /** 登记并立即生效一条内核内置绑定（providerId = 内核本体）。
   *  与插件提供者走完全相同的仲裁与事件路径——内置优先级的「特殊」只在于它先到场。 */
  private publishBuiltin(key: string, value: unknown): void {
    const binding: ProviderBinding = { pluginId: KERNEL_PROVIDER_ID, value, seq: this.factSeq++, ts: Date.now(), priority: 0 };
    this.declareBinding(key, binding);
    this.publish(key, binding);
  }

  /** 扫描并加载全部插件（core 在前，用户插件在后，确保依赖顺序），
   *  启动前按 requires 拓扑排序（Kahn）——依赖先于依赖方启动；
   *  生命周期控制：manifest.enabled=false 声明停用、lazy=true 声明惰性加载
   *  （类似 OS 驱动按需加载——注册可见，但不自动进入上下文，LLM 需要时 enable_plugin 激活） */
  async loadAll(): Promise<void> {
    await this.scanDir(this.coreDir);
    await this.scanDir(this.userDir);
    for (const inst of this.topoSort([...this.registry.values()])) {
      if (inst.state !== 'started' && inst.state !== 'stopped') {
        if (inst.manifest.enabled === false || inst.manifest.lazy) continue;
        // 单插件启动失败不阻断其余（依赖缺失/onStart 抛错只影响自身）
        try {
          await this.start(inst);
        } catch (err) {
          console.error(`[plugin] 启动失败 ${inst.manifest.id}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    this.primeSignatures(); // v3：为已启动插件建立依赖签名快照（智能重载的比对基准）
  }

  /** 扫描单个插件目录（dir 下每个子目录 = 一个插件） */
  private async scanDir(root: string): Promise<void> {
    if (!existsSync(root)) return;
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SNAPSHOT_SUFFIX.test(e.name)) { this.pruneOrphanSnapshot(root, e.name); continue; }
      const dir = join(root, e.name);
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      await this.register(dir);
    }
  }

  /** 孤儿快照：插件目录已不在，其内容快照失去归属（扫描时顺带回收，避免磁盘累积） */
  private pruneOrphanSnapshot(root: string, snapName: string): void {
    const owner = snapName.replace(SNAPSHOT_SUFFIX, '');
    if (!existsSync(join(root, owner))) rmSync(join(root, snapName), { recursive: true, force: true });
  }

  /** 按 requires 拓扑排序（Kahn）：入度 0 者先出队，初始队列按注册序（core 目录先于 plugins 目录）。
   *  环检测：成环节点报错并跳过（不阻断其余插件的启动）。 */
  private topoSort(insts: PluginInstance[]): PluginInstance[] {
    const byId = new Map(insts.map((i) => [i.manifest.id, i]));
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // dep id → 依赖它的插件 id 列表
    for (const inst of insts) {
      if (!indeg.has(inst.manifest.id)) indeg.set(inst.manifest.id, 0);
      for (const dep of inst.manifest.requires ?? []) {
        if (!byId.has(dep)) continue; // 缺失依赖在注册阶段已报错，不构成启动序边
        dependents.set(dep, [...(dependents.get(dep) ?? []), inst.manifest.id]);
        indeg.set(inst.manifest.id, (indeg.get(inst.manifest.id) ?? 0) + 1);
      }
    }
    const queue = insts.filter((i) => (indeg.get(i.manifest.id) ?? 0) === 0).map((i) => i.manifest.id);
    const out: PluginInstance[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      const inst = byId.get(id);
      if (inst) out.push(inst);
      for (const next of dependents.get(id) ?? []) {
        const d = (indeg.get(next) ?? 0) - 1;
        indeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (out.length < insts.length) {
      const cyclic = insts.filter((i) => !out.includes(i)).map((i) => i.manifest.id);
      console.error(`[plugin] 依赖环检测：以下插件互相依赖（requires 成环），跳过启动：${cyclic.join(' → ')}`);
    }
    return out;
  }

  /** 注册（解析清单、依赖检查、动态加载入口、onLoad）。已注册则返回现有实例。
   *  失败（import 失败/依赖缺失/清单损坏）时从 registry 移除残骸——不留 state='registered'
   *  空壳被 loadAll 误启动，也不留半初始化实例污染依赖检查。 */
  async register(dir: string): Promise<PluginInstance | undefined> {
    let id = '';
    let inst: PluginInstance | undefined;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as PluginManifest;
      const existing = this.registry.get(manifest.id);
      if (existing) {
        if (existing.dir !== dir) {
          console.warn(`[plugin] 插件 id 冲突："${manifest.id}" 已由 ${existing.dir} 注册，忽略 ${dir}（core 与 plugins/ 不允许同 id）`);
        }
        return existing;
      }
      id = manifest.id;
      const snap = this.snapshotOf(dir);
      inst = { manifest, dir, loadDir: snap.dir, loadHash: snap.hash, state: 'registered', caps: [], scope: new EffectScope(), provides: [], depHooks: [], depSignature: '', configOverrides: [], chain: Promise.resolve(), circuitBreaker: { failures: 0, openedAt: 0 } };
      this.registry.set(id, inst);
      this.bus.emit(EventBus.event('plugin.registered', { id: manifest.id, name: manifest.name, version: manifest.version, provides: manifest.provides }));

      // 依赖检查全部后置（v3.4）：注册阶段只解析清单与加载入口——同批次扫描顺序
      // 无保证（readdir 平台相关），requires 指向稍后扫描的插件在本阶段必然未注册，
      // 在此判失败会误删合法插件；"依赖必须存在且已加载"的硬校验统一放在
      // startInternal（启动前置），单个依赖失败只影响该插件自身（loadAll 不阻断）。
      void manifest.requires;

      // 动态加载入口（从内容快照目录加载：目录内容变即换基址，整张模块图按内容重建）
      const mod = await import(this.entryUrl(inst.loadDir, manifest.entry, inst.loadHash));
      inst.plugin = (mod.default ?? mod) as Plugin;
      await this.runLoad(inst);
      return inst;
    } catch (err) {
      // 残骸清理：仅移除本目录注册进去的实例（并发场景下不误删他人）
      if (id && this.registry.get(id)?.dir === dir) this.registry.delete(id);
      // 副作用回收：onLoad 已执行的 ctx.on/register/provide 等逆元全部清除——
      // 否则加载失败的插件会残留事件订阅、能力与服务绑定（旧实现只删 registry）
      if (inst) {
        try { await inst.scope.dispose(); } catch { /* 忽略 */ }
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin] 加载失败 ${basename(dir)}: ${msg}`);
      this.bus.emit(EventBus.event('plugin.error', { dir: basename(dir), error: msg }));
      return undefined;
    }
  }

  /**
   * 插件目录的内容快照（见 plugin-snapshot）：目录内容变 → 换加载目录 → 整张模块图
   * 按内容重建。目录内无可读源码时退回原目录（不产生快照目录，也不影响启动）。
   */
  private snapshotOf(dir: string): Snapshot {
    const hash = dirDigest(dir);
    if (!hash) return { dir, hash: 'no-source', skipped: true };
    const snap = materialize(dir, hash);
    if (snap.skipped) console.warn(`[plugin] ${basename(dir)} 体积超过快照上限，本次仅入口级热重载：${dir}`);
    return snap;
  }

  /**
   * 入口 URL：版本取快照的内容聚合哈希——目录内容不变 → URL 不变 → 命中 Node ESM 模块缓存，
   * 不产生新模块记录（旧实现 ?t=${Date.now()} 每次都生成新 URL/新模块记录——reload 未变更
   * 的插件也泄漏一份模块图）；内容一变 → 目录名与 URL 同时变，入口与其依赖全部重建。
   * forceFresh（v3.1）：依赖签名变化（如 .env 变更）触发的 reload 中目录内容未变 →
   * 默认 URL 命中旧模块记录（顶层常量读到的还是旧 env）→ 追加 `&r=${factVersion}`
   * 维度强制生成新模块记录，onLoad/onStart 重新求值。
   * 残余限制：Node ESM registry 无法卸载模块——内容变化时新旧模块记录并存于进程，
   * 快照清理只回收磁盘，不回收内存。
   */
  private entryUrl(loadDir: string, entry: string, version: string, forceFresh = false): string {
    return `${pathToFileURL(join(loadDir, entry)).href}?v=${version}${forceFresh ? `&r=${this.factVersion}` : ''}`;
  }

  /** 执行 onLoad（副作用全部进入实例的 EffectScope——卸载即自动恢复）。
   *  配置 schema 校验前置：manifest.config 声明时，onLoad 前用 config.<id>.* 当前值校验，
   *  不合规 → throw（register 失败清理 / 热重载回滚）——配置错误在进入插件逻辑前暴露。
   *  v8 新增：超时保护——onLoad 挂起超过阈值则强制失败。 */
  private async runLoad(inst: PluginInstance): Promise<void> {
    const schema = inst.manifest.config;
    if (schema && typeof schema === 'object') {
      const issues = validateAgainstSchema(this.ctxBase.config.section(inst.manifest.id), schema);
      if (issues.length) {
        throw new Error(`插件 ${inst.manifest.id} 配置校验失败:\n` + issues.map((i) => `  - ${i}`).join('\n'));
      }
    }
    const ctx = this.buildContext(inst);
    const lifecycleTimeout = inst.manifest.limits?.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    await withTimeout(
      Promise.resolve(inst.plugin?.onLoad?.(ctx)),
      lifecycleTimeout,
      `${inst.manifest.id}.onLoad`,
    );
    inst.state = 'loaded';
    this.bus.emit(EventBus.event('plugin.loaded', { id: inst.manifest.id, caps: inst.caps.map((c) => c.kind), provides: [...inst.provides] }));
  }

  /** 插件私有存储目录：<data>/plugins/<id> */
  private storageDir(pluginId: string): string {
    return join(this.ctxBase.paths.data, 'plugins', pluginId);
  }

  /** 私有存储门面：name 只取文件名，插件无法借此越出自身目录 */
  private makeStorage(inst: PluginInstance): PluginStorage {
    const dir = this.storageDir(inst.manifest.id);
    const at = (name: string): string => join(dir, basename(name));
    return {
      dir,
      read: (name) => { try { return readFileSync(at(name), 'utf-8'); } catch { return null; } },
      write: (name, content) => { mkdirSync(dir, { recursive: true }); writeFileSync(at(name), content, 'utf-8'); },
      list: () => { try { return readdirSync(dir); } catch { return []; } },
      remove: (name) => { try { rmSync(at(name), { force: true }); } catch { /* 已不存在 */ } },
    };
  }

  /**
   * 界外发射台账：EffectScope 只回收界内效应；文件/HTTP/DB/子进程跨出了进程独占边界，
   * 无法撤销——至少让它们可枚举：追加 <data>/outbound/<id>.jsonl 并广播事件，
   * 卸载摘要（plugin.reverted）带上本生命周期的条数。
   */
  private makeOutbound(inst: PluginInstance): PluginContext['outbound'] {
    const file = join(this.ctxBase.paths.data, 'outbound', `${inst.manifest.id}.jsonl`);
    return {
      record: (rec: OutboundRecord) => {
        inst.outboundCount = (inst.outboundCount ?? 0) + 1;
        try {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`, 'utf-8');
        } catch { /* 台账写失败不影响插件运行 */ }
        this.bus.emit(EventBus.event('plugin.outbound', { id: inst.manifest.id, kind: rec.kind, detail: rec.detail }));
      },
    };
  }

  /** 彻底卸载时按 manifest.cleanup 处理私有存储：keep 保留（默认）/ archive 归档 / purge 清除 */
  private applyCleanup(inst: PluginInstance): void {
    const strategy = inst.manifest.cleanup ?? 'keep';
    const dir = this.storageDir(inst.manifest.id);
    try {
      if (strategy === 'purge') rmSync(dir, { recursive: true, force: true });
      else if (strategy === 'archive' && existsSync(dir)) {
        const target = join(this.ctxBase.paths.data, 'archive', `${inst.manifest.id}-${Date.now()}`);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(dir, target, { recursive: true });
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[plugin] ${inst.manifest.id} 私有存储清理失败（${strategy}）:`, err instanceof Error ? err.message : String(err));
    }
    this.bus.emit(EventBus.event('plugin.cleanup', { id: inst.manifest.id, strategy, dir, outbound: inst.outboundCount ?? 0 }));
  }

  /** 构建插件上下文：一切副作用（register/on/provide/watchConfig）自动入 scope */
  private buildContext(inst: PluginInstance): PluginContext {
    const scope = inst.scope;
    const loader = this;
    const config = {
      get: <T>(key: string, def?: T): T => this.getContextConfig(inst, key, def),
      set: (key: string, value: unknown) => this.ctxBase.config.set(key, value),
      section: (pluginId: string) => {
        const base = { ...this.ctxBase.config.section(pluginId) };
        for (const layer of inst.configOverrides) {
          const value = this.readOverride(layer, pluginId);
          if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(base, value);
        }
        return base;
      },
      watch: (pattern: string, cb: (key: string, value: unknown) => void) => this.ctxBase.config.watch(pattern, cb),
    };
    // 事件门面：只透传发射，不暴露订阅——订阅必须走 ctx.on 才进得了逆元栈，
    // 裸监听会绕过 EffectScope 在卸载后残留（可逆性承诺的唯一破口在此封堵）。
    const bus: PluginBus = {
      emit: (e) => this.bus.emit(e),
      emitAsync: (e) => this.bus.emitAsync(e),
      serial: (e) => this.bus.serial(e),
      bail: (e) => this.bus.bail(e),
      parallel: (e) => this.bus.parallel(e),
      waterfall: (type, ...args) => this.bus.waterfall(type, ...args),
    };
    return {
      pluginId: inst.manifest.id,
      kernel: this.ctxBase.kernel,
      paths: this.ctxBase.kernel.paths,
      bus,
      storage: this.makeStorage(inst),
      outbound: this.makeOutbound(inst),
      config,
      trace: this.ctxBase.trace,
      cache: this.ctxBase.cache,
      register: (cap: Capability) => {
        // 可逆效应：登记能力并留下逆元（卸载时自动回收，无需作者手工 unregister）
        inst.caps.push(cap);
        if (cap.kind === 'service' && inst.state === 'started') {
          // 运行期动态注册服务：立即发布（绑定只在提供者 ACTIVE 时对依赖方可见）
          this.registerServiceCap(inst, cap.service.id, cap.service.instance);
        }
        // 注册期（onLoad）声明的 service 能力不在此发布、也不登记 provides：
        // 它由 startInternal 的 registerServiceCap 通道统一生效（两条通道各司其职，
        // 不在 provides 里留悬空键——publishPendingFor 只负责 ctx.provide 的候选）。
        this.notifyCapSet(cap.kind);
        this.bus.emit(EventBus.event('plugin.capability', {
          pluginId: inst.manifest.id, kind: cap.kind,
          name: cap.kind === 'tool' ? cap.tool.name : cap.kind === 'command' ? cap.command.name : cap.kind === 'provider' ? cap.provider.id : undefined,
        }));
        const inverse = () => {
          const i = inst.caps.indexOf(cap);
          if (i >= 0) {
            inst.caps.splice(i, 1);
            if (cap.kind === 'service') this.withdraw(`service:${cap.service.id}`, inst);
            this.notifyCapSet(cap.kind);
          }
        };
        // 返回句柄 = 移除式 disposer + 执行撤销：手动撤销时先把逆元从作用域摘除，
        // 再执行撤销——dispose 不会二次执行（旧实现直接返回 inverse，手动撤销后
        // dispose 会对已撤销的效果再执行一次撤销）
        const remove = scope.add(inverse);
        return () => { remove(); inverse(); };
      },
      on: (event: string, listener: EventListener, priority?: number) => {
        // 自动退订的事件订阅：卸载时随作用域回收，杜绝监听器泄漏
        const off = this.bus.on(event, listener, priority);
        const remove = scope.add(off);
        return () => { remove(); off(); }; // 手动退订：先摘除逆元再退订（dispose 不再二次执行）
      },
      provide: (key: string, value: unknown, priority = 0) => {
        // 候选登记始终发生（谁提供了什么必须可见），但【生效】必须等本插件 ACTIVE——
        // 「绑定只在提供者活动时对依赖方可见」是启动/停用语义的基石：否则一个
        // enabled=false / lazy 的插件在注册期就能顶掉活动插件的服务。
        const binding: ProviderBinding = { pluginId: inst.manifest.id, value, seq: this.factSeq++, ts: Date.now(), priority };
        this.declareBinding(key, binding);
        if (!inst.provides.includes(key)) inst.provides.push(key);
        if (inst.state === 'started') this.publish(key, binding);
        else {
          // 声明登记：候选可见（可观测「谁声明了什么」），但不参与仲裁、不改变生效值
          this.bus.emit(EventBus.event('service.declared', { key, pluginId: inst.manifest.id, priority }));
        }
        // 逆元：撤回本绑定（幂等——重复调用安全）。已发布的绑定被手动撤销时同样正确回退。
        const inverse = () => this.withdraw(key, inst);
        const remove = scope.add(inverse);
        return () => { remove(); inverse(); };
      },
      inject: (key: string, onChange?: (v: unknown | undefined) => void) => {
        // v3 智能重载：登记依赖声明（用服务绑定 seq 做签名分量——绑定换主即 seq 变）
        inst.depHooks.push(() => `service:${key}@${loader.providers.get(key)?.seq ?? 'none'}`);
        let off: () => void = () => {};
        if (onChange) {
          let set = loader.dependents.get(key);
          if (!set) { set = new Set(); loader.dependents.set(key, set); }
          set.add(onChange);
          off = () => {
            const s = loader.dependents.get(key);
            if (s) { s.delete(onChange); if (s.size === 0) loader.dependents.delete(key); }
          };
          scope.add(off);
        }
        return {
          value: loader.traceServiceGet(key, inst.manifest.id, this.ctxBase.trace)?.value,
          stop: off, // 显式退订（未退订时卸载随作用域回收；重复退订幂等）
        };
      },
      onCapabilities: (kind: Capability['kind'], cb: () => void) => {
          // v3 智能重载：登记依赖声明（per-kind 版本）
          inst.depHooks.push(() => `caps:${kind}@${loader.capVersions.get(kind) ?? 0}`);
          let set = loader.capSubs.get(kind);
          if (!set) { set = new Set(); loader.capSubs.set(kind, set); }
          set.add(cb);
          const off = () => {
            const s = loader.capSubs.get(kind);
            if (s) { s.delete(cb); if (s.size === 0) loader.capSubs.delete(kind); }
          };
          scope.add(off);
          return off;
        },
        watchConfig: (key: string, cb: (value: unknown) => void) => {
          // v3 智能重载：登记配置依赖（读当前值，配置变化即 bumpFact）
          inst.depHooks.push(() => `cfg:${key}@${String(loader.ctxBase.config.get(key))}`);
          // 声明式配置对账：按「变了哪个键」分派（最小干预），并递增依赖事实版本
          const off = loader.ctxBase.config.watch(key, (_k, v) => {
            loader.bumpFact();
            cb(v);
          });
          scope.add(off);
          return off;
        },
        watchEnv: (name: string, cb?: (value: string | undefined) => void) => {
          // v3.1 智能重载：登记 env 依赖（per-name 版本——.env 变更即重载该插件）。
          // 先初始化 envVersions 的 key：bumpEnv() 无参时以此收集「全部已知 env 依赖」
          if (!loader.envVersions.has(name)) loader.envVersions.set(name, 0);
          inst.depHooks.push(() => `env:${name}@${loader.envVersions.get(name) ?? 0}`);
          let off: () => void = () => {};
          if (cb) {
            let set = loader.envSubs.get(name);
            if (!set) { set = new Set(); loader.envSubs.set(name, set); }
            set.add(cb);
            off = () => {
              const s = loader.envSubs.get(name);
              if (s) { s.delete(cb); if (s.size === 0) loader.envSubs.delete(name); }
            };
          }
          scope.add(off);
          return off;
        },
      configWith: (overrides: Record<string, unknown>) => {
        const layer = { ...overrides };
        inst.configOverrides.push(layer);
        const remove = scope.add(() => {
          const i = inst.configOverrides.indexOf(layer);
          if (i >= 0) inst.configOverrides.splice(i, 1);
        });
        return () => {
          remove();
          const i = inst.configOverrides.indexOf(layer);
          if (i >= 0) inst.configOverrides.splice(i, 1);
        };
      },
      effect: <T>(fn: () => T | Promise<T>, makeInverse: (v: T) => () => void | Promise<void>) => {
        return scope.effect(fn, makeInverse);
      },
      logger: {
        info: (msg, meta) => console.log(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        warn: (msg, meta) => console.warn(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        error: (msg, meta) => console.error(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        debug: (msg, meta) => { if (process.env.DEBUG) console.debug(`[${inst.manifest.id}] ${msg}`, meta ?? ''); },
      },
    };
  }

  private readOverride(layer: Record<string, unknown>, key: string): unknown {
    if (Object.prototype.hasOwnProperty.call(layer, key)) return layer[key];
    let value: unknown = layer;
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  private getContextConfig<T>(inst: PluginInstance, key: string, def?: T): T {
    for (let i = inst.configOverrides.length - 1; i >= 0; i--) {
      const value = this.readOverride(inst.configOverrides[i], key);
      if (value !== undefined && value !== null) return value as T;
    }
    return this.ctxBase.config.get(key, def);
  }

  // ---------- 服务共效应注册表（反应性依赖 + 优先级接管） ----------

  /**
   * 仲裁：哪个绑定生效。规则极简且可预测——priority 大者胜；同优先级先到者胜
   * （seq 全局单调，保证「先提供者不被后到者静默顶掉」这一稳定语义）。
   *
   * 关键：只仲裁【已发布】的候选。注册期登记的声明（published=false）是「意图」而非
   * 「生效」——它们不参与竞争，否则一个 enabled=false / lazy 的插件在 onLoad 里声明
   * 一句 provide 就能靠高优先级顶掉活动插件的服务，而它自己从未启动。
   */
  private arbitrate(key: string): ProviderBinding | undefined {
    let best: ProviderBinding | undefined;
    for (const b of this.bindings.get(key)?.values() ?? []) {
      if (!b.published) continue;
      if (!best || b.priority > best.priority || (b.priority === best.priority && b.seq < best.seq)) best = b;
    }
    return best;
  }

  /** 把仲裁结果落回 providers 视图；返回「生效者是否发生变化」。*/
  private syncWinner(key: string): boolean {
    const prev = this.providers.get(key);
    const next = this.arbitrate(key);
    if (!prev && !next) return false;
    if (prev && next && prev === next) return false; // 同一绑定对象仍在生效：无变化
    if (next) this.providers.set(key, next); else this.providers.delete(key);
    return true;
  }

  /**
   * 发布一个【已登记】的候选绑定：重新仲裁 → 生效者变化时通知依赖方。
   * 可接管（priority 更高）时不打断提供方，只切换「谁对依赖方可见」。
   */
  private publish(key: string, binding: ProviderBinding): void {
    const prev = this.providers.get(key); // 发布【前】的生效者，用于判定事件语义
    binding.published = true; // 已进入仲裁：此后不再被当作「新声明」
    const changed = this.syncWinner(key);
    if (!changed) {
      // 发布成功但未夺魁（本键已有更高优先级的活动提供者）：只是并存候选，不惊动依赖方
      this.bus.emit(EventBus.event('service.declared', { key, pluginId: binding.pluginId, priority: binding.priority }));
      return;
    }
    this.bumpFact(); // 服务绑定变化 = 依赖事实变化（智能重载依据）
    const winner = this.providers.get(key);
    // 事件语义按「生效者是否换人」判定，而不是「发布者是否夺魁」：
    //  - 此前无人生效 → provided（首次激活）
    //  - 此前有别人生效 → overridden（接管，含从「休眠候选」上线接管活动绑定的情形）
    const type = prev && prev !== winner ? 'service.overridden' : 'service.provided';
    this.bus.emit(EventBus.event(type, {
      key,
      pluginId: winner?.pluginId ?? binding.pluginId,
      priority: winner?.priority ?? binding.priority,
    }));
    this.notifyDependents(key, winner?.value);
  }

  /** 服务能力（kind:'service'）的发布：构造候选绑定并立即生效（调用点必在 started 之后）。
   *  与 ctx.provide 共用同一候选集——两条注册通道语义一致，不产生旁路绑定。 */
  private registerServiceCap(inst: PluginInstance, id: string, instance: unknown): void {
    const key = `service:${id}`;
    const binding: ProviderBinding = { pluginId: inst.manifest.id, value: instance, seq: this.factSeq++, ts: Date.now(), priority: 0 };
    this.declareBinding(key, binding);
    if (!inst.provides.includes(key)) inst.provides.push(key);
    this.publish(key, binding);
  }

  /** 启动期补发布：把该插件在注册期（onLoad）登记的候选此刻生效。
   *  这是「声明在注册期、生效在启动期」的实现——两个阶段分离，停用插件不占服务。
   *  按插件→候选精确取（每个键下每插件至多一条），不触碰其它插件的候选。 */
  private publishPendingFor(inst: PluginInstance): void {
    const id = inst.manifest.id;
    for (const key of inst.provides) {
      for (const [owner, b] of this.bindings.get(key) ?? []) {
        if (owner === id && !b.published) this.publish(key, b);
      }
    }
  }

  /** 登记候选绑定（不生效）。绑定按（键, 插件）唯一：同插件重复 provide 覆盖前者。 */
  private declareBinding(key: string, binding: ProviderBinding): void {
    let byPlugin = this.bindings.get(key);
    if (!byPlugin) { byPlugin = new Map(); this.bindings.set(key, byPlugin); }
    byPlugin.set(binding.pluginId, binding);
  }

  /** 撤回绑定：移除本插件在该键的候选 → 重新仲裁。
   *  若移除的是生效者且仍有候选（如被接管的原实现、或次高优先级），自动回退到胜出者，
   *  依赖方收到新值而非 undefined——「接管者卸载后服务不消失」。 */
  private withdraw(key: string, inst: PluginInstance): void {
    const byPlugin = this.bindings.get(key);
    if (!byPlugin?.delete(inst.manifest.id)) return;
    if (!byPlugin.size) this.bindings.delete(key);
    const changed = this.syncWinner(key);
    if (!changed) return;
    this.bumpFact();
    const winner = this.providers.get(key);
    this.bus.emit(EventBus.event(
      winner ? 'service.provided' : 'service.withdrawn',
      { key, pluginId: winner?.pluginId ?? inst.manifest.id },
    ));
    this.notifyDependents(key, winner?.value);
  }

  /** 服务键下全部候选绑定（可观测：谁在提供、谁被接管、各自优先级） */
  bindingCandidates(key: string): { pluginId: string; priority: number; active: boolean; published: boolean; seq: number; ts: number }[] {
    const winner = this.providers.get(key);
    return [...(this.bindings.get(key)?.values() ?? [])]
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
      .map((b) => ({ pluginId: b.pluginId, priority: b.priority, active: b === winner, published: !!b.published, seq: b.seq, ts: b.ts }));
  }

  /** 当前全部服务键（服务注册表投影，供管理面/调试列出「已提供的服务」） */
  serviceKeys(): string[] {
    return [...this.bindings.keys()];
  }
  private notifyDependents(key: string, value: unknown | undefined): void {
    const subs = this.dependents.get(key);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(value); } catch (err) {
        console.warn(`[loader] 依赖方通知失败 (${key}):`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 能力集变化通知（onCapabilities 订阅者） */
  private notifyCapSet(kind: Capability['kind']): void {
    this.bumpFact(); // 能力集变化 = 依赖事实变化（依赖该 kind 的插件需重载）
    this.capVersions.set(kind, (this.capVersions.get(kind) ?? 0) + 1); // per-kind 版本：签名精确定位
    const subs = this.capSubs.get(kind);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(); } catch (err) {
        console.warn(`[loader] 能力集通知失败 (${kind}):`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 内核/服务端向插件外消费方暴露的同步解析（如 server 层取 chat 服务）——自动埋服务调用追踪 */
  resolveService(key: string, consumer?: string): unknown | undefined {
    return this.traceServiceGet(key, consumer ?? 'external', this.ctxBase.trace)?.value;
  }

  /** 服务解析的可观测形式：保留提供者身份，供调试/管理面使用。 */
  resolveTraced(key: string, consumer?: string): { provider: string; value: unknown } | undefined {
    const binding = this.traceServiceGet(key, consumer ?? 'external', this.ctxBase.trace);
    return binding ? { provider: binding.pluginId, value: binding.value } : undefined;
  }

  /**
   * 服务级调用追踪（v3）：解析服务绑定并记录「消费方 → 提供方」的 service_call Trace 步骤。
   *  - providers 记录提供者插件 id + 提供时刻 seq/ts；
   *  - 每次取值（inject / resolveService / capabilities 关联）都经此，记录到 Trace。
   *  - consumer 缺省记 'external'（非插件消费方，如 server 层）。
   */
  traceServiceGet(key: string, consumer: string, trace?: TraceLike): { pluginId: string; value: unknown; seq: number; ts: number } | undefined {
    const binding = this.providers.get(key);
    if (!binding) return undefined;
    // 服务调用入 Trace：可写盘、可前端口径的 span（复用现有三态输出）。
    // 注意：本处无 traceId 上下文（非执行路径），用空串，step 仍会上环形缓冲与 SSE。
    if (trace?.startStep) {
      const step = trace.startStep({
        traceId: '',
        turn: 0,
        type: 'service_call',
        name: key,
      });
      step.finish({ outputSummary: `${consumer} → ${binding.pluginId} (${key})` });
    }
    return binding;
  }

  /** 依赖事实版本号（v3 智能重载：外部可读取，如 server 层判断是否需重载） */
  getDependencyVersion(): number {
    return this.factVersion;
  }

  /**
   * 环境变量变更登记（v3.1，智能重载的 env 维度）：
   * server 在 .env 变更后调用——bump 指定 key（不传则全部已知 env 依赖）的版本，
   * 通知 watchEnv 订阅者立即收到新值，并递增依赖事实版本（reloadChanged 据此重载）。
   * 注意：只 bump 不重载——调用方随后显式调 reloadChanged()。
   */
  bumpEnv(names?: string[]): void {
    const keys = names?.length ? names : [...this.envVersions.keys()];
    if (!keys.length) return;
    for (const name of keys) {
      this.envVersions.set(name, (this.envVersions.get(name) ?? 0) + 1);
    }
    // 订阅者即时通知（无需等 reload：惰性读 env 的插件直接拿到新值）
    for (const name of keys) {
      const subs = this.envSubs.get(name);
      if (!subs) continue;
      for (const cb of [...subs]) {
        try { cb(process.env[name]); } catch (err) {
          console.warn(`[loader] env 订阅通知失败 (${name}):`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    this.bumpFact(); // env 变化 = 依赖事实变化（reloadChanged 快速路径需要）
  }

  /** 递增依赖事实版本：任何可能改变插件运行观察面的事实变化（服务绑定/能力集/配置）
   *  都应调用，供 reloadChanged 做签名比对。返回新版本号。 */
  private bumpFact(): number {
    return ++this.factVersion;
  }

  // ---------- 生命周期（chain 串行队列：真排队，替代 check-then-act 惯性） ----------

  /** 排队一个生命周期操作到实例链尾。
   *  run 的结果/错误返回给调用方；链尾挂 run.catch 吞错续链（队列不因单次失败断裂）。 */
  private enqueue(inst: PluginInstance, body: () => Promise<void>): Promise<void> {
    const run = inst.chain.then(body);
    inst.chain = run.catch(() => {});
    return run;
  }

  async start(inst: PluginInstance): Promise<void> {
    return this.enqueue(inst, () => this.startInternal(inst));
  }

  async stop(inst: PluginInstance): Promise<void> {
    return this.enqueue(inst, () => this.stopInternal(inst));
  }

  /** start 内部实现（不排队——已由 enqueue 保证串行，内部再排队会死锁）。
   *  失败：置 error 态后 rethrow——调用方（reload 事务/enable）据此走回滚/报错，
   *  而不是把 error 态实例当成功提交。
   *  v8 新增：超时保护 + 熔断器——防止单个插件挂起或反复崩溃影响全局。 */
  private async startInternal(inst: PluginInstance): Promise<void> {
    if (inst.state === 'started') return;

    // 熔断器检查：连续失败达阈值后进入熔断态，跳过启动
    const cb = inst.circuitBreaker;
    const threshold = inst.manifest.limits?.circuitBreakerThreshold ?? DEFAULT_CB_THRESHOLD;
    const resetMs = inst.manifest.limits?.circuitBreakerResetMs ?? DEFAULT_CB_RESET_MS;
    if (threshold > 0 && cb.failures >= threshold) {
      const elapsed = Date.now() - cb.openedAt;
      if (elapsed < resetMs) {
        const remainSec = Math.ceil((resetMs - elapsed) / 1000);
        console.warn(`[plugin] ${inst.manifest.id} 熔断态：连续失败 ${cb.failures} 次，${remainSec}s 后重试`);
        inst.state = 'error';
        inst.error = `熔断态：连续失败 ${cb.failures} 次，${remainSec}s 后自动重试`;
        this.bus.emit(EventBus.event('plugin.error', { id: inst.manifest.id, error: inst.error, circuitBreaker: true }));
        return;
      }
      // 熔断冷却期已过：重置计数器，允许重试
      console.log(`[plugin] ${inst.manifest.id} 熔断冷却期已过，重置失败计数，允许重试`);
      cb.failures = 0;
      cb.openedAt = 0;
    }

    inst.state = 'loading';
    const lifecycleTimeout = inst.manifest.limits?.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    try {
      // 依赖硬校验（启动前置）：requires 的插件必须已加载（loaded/started）——
      // 注册期只校验存在性（跨扫描顺序合法），启动前确保依赖先于本插件就绪。
      // 拓扑排序已保证启动顺序；此校验兜底 enable/热重载等单插件路径。
      const missingDep = (inst.manifest.requires ?? []).find((dep) => {
        const d = this.registry.get(dep);
        return !d || d.state === 'registered' || d.state === 'error';
      });
      if (missingDep) {
        throw new Error(`缺少依赖插件: ${missingDep}（依赖未加载，无法启动）`);
      }
      // 超时保护：onStart 挂起超过阈值则强制失败（不取消原 Promise，但标记错误）
      await withTimeout(
        Promise.resolve(inst.plugin?.onStart?.(this.buildContext(inst))),
        lifecycleTimeout,
        `${inst.manifest.id}.onStart`,
      );
      inst.state = 'started';
      // 启动成功：重置熔断器
      cb.failures = 0;
      cb.openedAt = 0;
      this.bus.emit(EventBus.event('plugin.started', { id: inst.manifest.id }));
      // 服务共效应发布：started 后插件提供的服务才对依赖方可见（绑定只在 ACTIVE 时有效）。
      // 注册期（onLoad）用 ctx.provide 登记的候选在此刻统一生效——声明与生效两阶段分离。
      this.publishPendingFor(inst);
      for (const cap of inst.caps) {
        if (cap.kind === 'service') this.registerServiceCap(inst, cap.service.id, cap.service.instance);
      }
      // 能力集反应性通知：started 后能力才对 capabilities() 可见——
      // 通知订阅者（如 chat 的 persona 集订阅），保证「启动即生效」而非等下次变化
      for (const kind of new Set(inst.caps.map((c) => c.kind))) this.notifyCapSet(kind);
    } catch (err) {
      // 失败回收：onLoad/onStart 已入 scope 的副作用（订阅/能力/服务绑定）一并清除——
      // stopInternal 对 error 态直接返回，不清理；不回收则 error 实例滞留监听器/服务，
      // 热重载/enable 重试后出现旧副作用与新实例叠加
      await inst.scope.dispose().catch(() => undefined);
      inst.scope = new EffectScope();
      inst.state = 'error';
      inst.error = err instanceof Error ? err.message : String(err);
      // 熔断器递增：记录失败
      cb.failures++;
      if (threshold > 0 && cb.failures >= threshold) {
        cb.openedAt = Date.now();
        console.warn(`[plugin] ${inst.manifest.id} 连续失败 ${cb.failures} 次，进入熔断态（${resetMs / 1000}s 后重试）`);
      }
      this.bus.emit(EventBus.event('plugin.error', { id: inst.manifest.id, error: inst.error }));
      throw err;
    }
  }

  /** stop 内部实现（不排队）：LIFO 回收插件全部副作用 */
  private async stopInternal(inst: PluginInstance): Promise<void> {
    if (inst.state !== 'started' && inst.state !== 'loaded') return;
    // L-Leave：先标记停供（依赖方看到停用后自行降级），再执行逆元
    inst.state = 'unloading';
    // 可逆效应：LIFO 回收插件全部副作用（能力/订阅/服务绑定/配置变更一并恢复）
    const tracked = inst.scope.size;
    const outbound = inst.outboundCount ?? 0;
    await inst.scope.dispose();
    if (tracked > 0 || outbound > 0) {
      this.bus.emit(EventBus.event('plugin.reverted', { id: inst.manifest.id, effects: tracked, outbound }));
    }
    // 旧式钩子保留：有手工清理的插件仍可在此补位（自动回收已覆盖大部分场景）
    try { await inst.plugin?.onStop?.(this.buildContext(inst)); } catch { /* 忽略 */ }
    try { await inst.plugin?.onUnload?.(this.buildContext(inst)); } catch { /* 忽略 */ }
    // 依赖声明清空（B3）：enable 重部署时 onLoad 会重新登记 depHooks——
    // 不清空则新旧两代依赖声明叠加，残留分量（如已撤回服务的 @none）造成签名漂移
    inst.depHooks = [];
    inst.forceFresh = undefined;
    inst.state = 'stopped';
    // 换新作用域：enable 重新部署时（onLoad 重跑）副作用进入新作用域，与已回收的旧作用域隔离
    inst.scope = new EffectScope();
    this.bus.emit(EventBus.event('plugin.stopped', { id: inst.manifest.id }));
  }

  /**
   * 事务性热重载：旧实例效果全部回收（但旧模块保留在内存）→ 加载新版本 → 成功则提交；
   * 失败则丢弃半成品、用旧模块重建实例（回滚）——系统永不进入"半加载"状态。
   * 排队执行时从 registry 重新取实例（等待期间 registry 可能已被并发 reload 替换——
   * 操作过期实例会使其副作用脱离注册表视线，造成监听器/绑定永久泄漏）。
   */
  async reload(id: string, start = true): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    return this.enqueue(inst, async () => {
      const cur = this.registry.get(id);
      if (!cur) return; // 等待期间已被卸载删除
      await this.reloadInternal(cur, start);
    });
  }

  /** reload 内部实现（不排队）。提交/回滚时新实例继承链尾（并发排队操作不丢失）。 */
  private async reloadInternal(inst: PluginInstance, start: boolean): Promise<void> {
    const { dir } = inst;
    const registryId = inst.manifest.id;
    const oldModule = inst.plugin;        // 备份旧模块（事务回滚用；其依赖引用同样是旧版本）
    const oldManifest = inst.manifest;
    const oldLoadDir = inst.loadDir;      // 旧快照目录：回滚期间保留，失败版本回收
    const forceFresh = !!inst.forceFresh; // 依赖签名变化触发的 reload：强制刷新模块记录
    inst.forceFresh = false;              // 消费即复位（只刷一次）
    // 事务阶段 1：回收旧实例的全部效果（可逆恢复）——旧模块引用保留
    await this.stopInternal(inst);
    this.bus.emit(EventBus.event('plugin.unloaded', { id: registryId }));

    // 事务阶段 2：加载新版本（内容快照 + 独立作用域，暂不进入注册表）
    const snap = this.snapshotOf(dir);
    const fresh: PluginInstance = { manifest: oldManifest, dir, loadDir: snap.dir, loadHash: snap.hash, state: 'registered', caps: [], scope: new EffectScope(), provides: [], depHooks: [], depSignature: inst.depSignature, configOverrides: [], chain: inst.chain, circuitBreaker: { ...inst.circuitBreaker } };
    try {
      // 重读 plugin.json：清单本身可能已变更（入口/依赖/启停声明）；解析失败走回滚
      try {
        fresh.manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as PluginManifest;
      } catch {
        throw new Error('新版本 plugin.json 解析失败');
      }
      if (fresh.manifest.id !== registryId) {
        throw new Error(`新版本 plugin.json 的 id "${fresh.manifest.id}" 与已注册 id "${registryId}" 不一致（热重载不支持变更插件 id）`);
      }
      const mod = await import(this.entryUrl(fresh.loadDir, fresh.manifest.entry, fresh.loadHash, forceFresh));
      fresh.plugin = (mod.default ?? mod) as Plugin;
      await this.runLoad(fresh);
      if (start && fresh.manifest.enabled !== false && !fresh.manifest.lazy) {
        await this.startInternal(fresh); // 失败会 rethrow（见 startInternal）
      }
      // 双保险：即使 start 失败未通过异常呈现（如未来内部实现变化），error 态也不提交
      if (fresh.state === 'error') throw new Error(fresh.error ?? '新版本启动失败');
      // 提交：替换注册表（旧实例已无副作用残留），回收历史快照（只留当前版本）
      this.registry.set(registryId, fresh);
      pruneSnapshots(dir, [fresh.loadDir]);
      this.bus.emit(EventBus.event('plugin.reloaded', { id: registryId }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 事务回滚：丢弃半成品，用旧模块重建（其副作用已随旧 scope 恢复，重建即还原）
      try {
        await fresh.scope.dispose(); // 回收半成品副作用
        const rollback: PluginInstance = {
          manifest: oldManifest, dir, loadDir: oldLoadDir, loadHash: inst.loadHash, state: 'registered',
          caps: [], scope: new EffectScope(), provides: [], configOverrides: [], plugin: oldModule,
          depHooks: [], depSignature: inst.depSignature,
          chain: inst.chain,
          circuitBreaker: { ...inst.circuitBreaker },
        };
        await this.runLoad(rollback);
        if (start && rollback.manifest.enabled !== false && !rollback.manifest.lazy) {
          await this.startInternal(rollback);
        }
        this.registry.set(registryId, rollback);
        pruneSnapshots(dir, [oldLoadDir]); // 失败版本的快照一并回收
        console.warn(`[plugin] ${registryId} 新版本加载失败，已回滚到旧版本: ${msg}`);
        this.bus.emit(EventBus.event('plugin.error', { id: registryId, error: msg, rollback: true }));
        this.bus.emit(EventBus.event('plugin.reloaded', { id: registryId, rollback: true }));
      } catch (err2) {
        // 回滚也失败：插件进入 error 态（最坏情况，仍有错误信息可查）
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        inst.state = 'error';
        inst.error = `${msg}；回滚失败: ${msg2}`;
        this.registry.set(registryId, inst);
        this.bus.emit(EventBus.event('plugin.error', { id: registryId, error: inst.error }));
      }
    }
  }

  /** 重载全部插件（环境变量/全局配置变化后调用；单个失败回滚到旧版本，不阻断其余） */
  async reloadAll(): Promise<void> {
    const ids = [...this.registry.keys()];
    for (const id of ids) {
      try {
        await this.reload(id);
      } catch (err) {
        console.warn(`[plugin] 重载失败 ${id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * v3 依赖驱动智能重载（核心亮点，超越 Cordis）：
   * 遍历全部插件，重算各自依赖签名（服务注入 seq / 能力集 per-kind 版本 / 配置快照），
   * **仅对签名变化的插件执行 reload**；签名不变者保留原实例——服务绑定不断、
   * 依赖方不反复收到停用/激活通知、零级联抖动。
   * 签名比对以 factVersion 为前提：factVersion 未变 → 直接跳过（快速路径）。
   */
  private recomputeSignature(inst: PluginInstance): string {
    // 收集 depHooks 当前分量；除依赖分量外，requires 插件的版本也算入（依赖升级 = 重载）
    const parts = inst.depHooks.map((hook) => {
      try { return hook(); } catch { return ''; }
    });
    for (const dep of inst.manifest.requires ?? []) {
      const depInst = this.registry.get(dep);
      parts.push(`req:${dep}@${depInst?.manifest.version ?? 'missing'}`);
    }
    return parts.sort().join('|');
  }

  /** v3：仅重载签名变化的插件（返回实际重载的 id 列表）。 */
  async reloadChanged(): Promise<string[]> {
    const changed: string[] = [];
    for (const inst of [...this.registry.values()]) {
      // 跳过未进入运行态的（registered/enabled=false/lazy 未启动者无运行依赖）
      if (inst.state !== 'started') continue;
      const signature = this.recomputeSignature(inst);
      if (!inst.depSignature) {
        // 首次建立快照（新启用/reload 提交后的新实例）：只登记，不重载
        inst.depSignature = signature;
        continue;
      }
      if (signature === inst.depSignature) continue; // 依赖未变：保留实例，零抖动
      // 依赖签名变化（可能不含文件内容变化，如 env/config 变更）→ 强制刷新模块记录，
      // 否则入口 hash 不变 → import 命中 ESM 缓存 → onLoad/onStart 读到的还是旧值
      inst.forceFresh = true;
      try {
        const keepActive = !(inst.manifest.enabled === false || inst.manifest.lazy);
        await this.reload(inst.manifest.id, keepActive);
        // 提交成功才更新签名——reload 会以新实例替换 registry（新实例继承旧签名），
        // 必须对 registry 中的当前实例写新值；失败回滚时保持旧值，后续同类依赖
        // 变化仍能触发重载（旧实现先写后 reload，失败后签名已是新值导致重载失效）
        const cur = this.registry.get(inst.manifest.id);
        if (cur) cur.depSignature = signature;
        changed.push(inst.manifest.id);
      } catch (err) {
        console.warn(`[plugin] 依赖驱动重载失败 ${inst.manifest.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
    return changed;
  }

  /** v3：初始装载完成后为已启动插件建立依赖签名快照（供后续比对）。 */
  private primeSignatures(): void {
    for (const inst of this.registry.values()) {
      if (inst.state === 'started' && !inst.depSignature) {
        inst.depSignature = this.recomputeSignature(inst);
      }
    }
  }

  // ---------- 对外管理 API ----------

  /** 插件清单投影（不暴露 scope/plugin/chain 等内部结构——内核实现细节不是公共 API） */
  list(): { manifest: PluginManifest; state: string; error?: string; circuitBreaker?: { failures: number; openedAt: number } }[] {
    return [...this.registry.values()].map((i) => ({
      manifest: i.manifest,
      state: i.state,
      error: i.error,
      circuitBreaker: i.circuitBreaker.failures > 0 ? i.circuitBreaker : undefined,
    }));
  }

  get(id: string): PluginInstance | undefined {
    return this.registry.get(id);
  }

  /** 按能力类型聚合查询（如全部 tool；仅活动插件）。
   *  确定性排序：插件 id 字典序 + 插件内注册序——enable/disable/reload 后数组顺序稳定，
   *  不破坏 L3 前缀（工具定义数组顺序抖动 = 前缀缓存全失效）。 */
  capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[] {
    const out: Extract<Capability, { kind: T }>[] = [];
    for (const id of [...this.registry.keys()].sort()) {
      const inst = this.registry.get(id);
      if (!inst || inst.state !== 'started') continue;
      for (const cap of inst.caps) if (cap.kind === kind) out.push(cap as Extract<Capability, { kind: T }>);
    }
    return out;
  }

  /** 插件 API 清单（含所属插件 id）：server 层按 /api/plugins/<id>/<mount> 动态分发 */
  apiRoutes(): { pluginId: string; mount: string; router: unknown }[] {
    const out: { pluginId: string; mount: string; router: unknown }[] = [];
    for (const inst of this.registry.values()) {
      if (inst.state !== 'started') continue;
      for (const cap of inst.caps) {
        if (cap.kind === 'api') out.push({ pluginId: inst.manifest.id, mount: cap.api.mount, router: cap.api.router });
      }
    }
    return out;
  }

  /**
   * 前端页面贡献清单：插件在 plugin.json 声明 nav 即在前端拥有一个标签页。
   *
   * 只列【已启动】插件（停用即页面下线，与能力可见性同一规则）；同时要求插件确实
   * 注册了 api 能力——声明了页面却没有数据通道是配置错误，不应产出死标签。
   * mount 一并返回：前端据 /api/plugins/<id>/<mount><page|panel> 拼出真实地址。
   */
  navContributions(): {
    pluginId: string;
    name: string;
    mount: string;
    nav: NavDef;
    /** module 模式的 UI 入口 URL（含内容哈希，UI 改动即时生效）；非 module 模式为 null */
    moduleUrl: string | null;
  }[] {
    const out: { pluginId: string; name: string; mount: string; nav: NavDef; moduleUrl: string | null }[] = [];
    for (const id of [...this.registry.keys()].sort()) {
      const inst = this.registry.get(id);
      if (!inst || inst.state !== 'started' || !inst.manifest.nav) continue;
      const api = inst.caps.find((c) => c.kind === 'api');
      if (!api || api.kind !== 'api') continue;
      out.push({
        pluginId: inst.manifest.id,
        name: inst.manifest.name,
        mount: api.api.mount,
        nav: inst.manifest.nav,
        moduleUrl: this.moduleUrlOf(inst),
      });
    }
    return out;
  }

  /** module 模式的 UI 入口 URL：入口取插件目录 ui/ 子目录内、路径不得越界，版本取内容哈希 */
  private moduleUrlOf(inst: PluginInstance): string | null {
    const nav = inst.manifest.nav;
    if (!nav || nav.mode !== 'module' || !nav.module) return null;
    const rel = nav.module.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return null;
    const digest = fileDigest(join(inst.dir, 'ui', rel));
    return digest ? `/api/plugins/${inst.manifest.id}/ui/${rel}?v=${digest}` : null;
  }

  async enable(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    return this.enqueue(inst, async () => {
      const cur = this.registry.get(id);
      if (!cur) return; // 等待期间已被卸载删除
      await this.enableInternal(cur);
    });
  }

  /** enable 内部实现（不排队） */
  private async enableInternal(inst: PluginInstance): Promise<void> {
    // 停用=完全撤离（副作用已随 stop 全部回收）；重新启用=重新部署（onLoad 重跑重建能力）——
    // 与论文的 disabled 字段语义一致：置位卸载 fiber，清除重载。
    // registered（未加载）/ loaded（lazy 声明：onLoad 已执行但未启动）/ stopped（停用后）
    // 均可激活——dynamic capability loading：能力按需进入上下文
    if (inst.state !== 'registered' && inst.state !== 'loaded' && inst.state !== 'stopped') {
      throw new Error(`插件当前状态: ${inst.state}`);
    }
    if (inst.state === 'stopped' && inst.plugin) {
      await this.runLoad(inst); // 重建全部能力（进入新作用域）
    }
    await this.startInternal(inst);
  }

  async disable(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    // essential 插件：允许 disable（进入降级模式），但记录警告
    if (inst.manifest.essential) {
      console.warn(`[plugin] ${id} 是核心必要插件（essential=true），disable 后进入降级模式（服务返回 503）`);
    }
    return this.enqueue(inst, async () => {
      const cur = this.registry.get(id);
      if (!cur) return; // 等待期间已被卸载删除
      await this.stopInternal(cur);
    });
  }

  /** 卸载插件：停止 → 回收副作用 → 删除插件目录 → 从注册表移除。
   *  essential 插件禁止卸载（只能 disable 进入降级模式）。
   *  仅允许卸载用户插件目录（plugins/）下的插件，core/ 插件不可卸载。 */
  async uninstall(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    if (inst.manifest.essential) {
      throw new Error(`插件 "${id}" 是核心必要插件（essential=true），不可卸载——如需停用请使用 disable`);
    }
    // 只允许卸载用户插件目录下的插件
    if (!inst.dir.startsWith(this.userDir)) {
      throw new Error(`插件 "${id}" 是内置插件（core），不可卸载`);
    }
    return this.enqueue(inst, async () => {
      const cur = this.registry.get(id);
      if (!cur) return;
      // 停止 + 回收全部副作用
      await this.stopInternal(cur);
      // 删除插件目录
      try {
        rmSync(cur.dir, { recursive: true, force: true });
        console.log(`[plugin] 已卸载插件 ${id}（目录已删除: ${cur.dir}）`);
      } catch (err) {
        console.warn(`[plugin] 插件目录删除失败（插件已从注册表移除）: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 从注册表移除
      this.registry.delete(id);
      pruneSnapshots(cur.dir); // 连同内容快照一起清理
      this.applyCleanup(cur);  // 私有存储按 manifest.cleanup 处理（数据归属可预期）
      this.bus.emit(EventBus.event('plugin.unloaded', { id }));
    });
  }

  // ---------- 热监听（仅用户插件目录） ----------

  watch(): void {
    if (!existsSync(this.userDir)) return;
    try {
      this.watcher = watch(this.userDir, { recursive: true }, (_event, filename) => {
        clearTimeout(this.reloadTimer);
        // 归一化 Windows 反斜杠；null（某些平台事件）视为目录级
        const name = filename ? String(filename).replace(/\\/g, '/') : null;
        this.reloadTimer = setTimeout(() => void this.onFileChange(name), 500);
      });
    } catch (err) {
      console.warn('[plugin] 目录监听不可用（Windows 递归监听失败时退化为手动 reload）:', err);
    }
  }

  /** 文件变更分派（防抖后执行）：filename 可定位到插件 → 定向 reload（只动一个插件，
   *  不再全目录重扫误伤无关插件）；定位不到（新建目录/null 事件）才全扫。
   *  rescanning 互斥：在途重扫/重载期间的新分派直接返回。 */
  private async onFileChange(filename: string | null): Promise<void> {
    if (this.rescanning) return;
    // 内容快照的创建/删除同样落在监听目录里（快照与插件目录同级）：不是插件变更，直接忽略
    if (filename && SNAPSHOT_SUFFIX.test(filename.split('/')[0])) return;
    this.rescanning = true;
    try {
      const first = filename?.split('/')[0] ?? '';
      const target = first
        ? [...this.registry.values()].find((i) => i.dir.startsWith(this.userDir) && basename(i.dir) === first)
        : undefined;
      if (target) {
        // 目录已删除（删除插件产生的是文件/目录级删除事件，仍可定位到目标）：
        // 定向 reload 会因 plugin.json 缺失失败并走回滚——用内存旧模块「复活」已删插件。
        // 改走重扫：rescanUser 对已消失目录执行 stop + registry.delete（真卸载）。
        if (!existsSync(target.dir)) {
          await this.rescanUser();
          return;
        }
        // 文件级事件（filename 含路径分隔，如 "myplugin/index.ts"）：内容确已变化 → 直接 reload；
        // 目录级事件（filename 恰为目录名，多为 touch/句柄扰动）：mtime 未变则跳过
        if (filename === first) {
          const mtime = this.snapshotMtime(target.dir);
          const prev = this.dirMtimes.get(target.dir);
          this.dirMtimes.set(target.dir, mtime);
          if (prev === mtime) return; // 目录未变化：跳过（编辑器保存常触发无实效的目录事件）
        }
        // 生命周期：lazy/停用声明的插件文件变化时重载但保持未激活
        const keepActive = !(target.manifest.enabled === false || target.manifest.lazy);
        await this.reload(target.manifest.id, keepActive);
        return;
      }
      await this.rescanUser();
    } finally {
      this.rescanning = false;
    }
  }

  /** 目录 mtime 快照：目录本体 + plugin.json 的较大值（子文件增删/改名会更新目录 mtime） */
  private snapshotMtime(dir: string): number {
    let m = 0;
    for (const p of [dir, join(dir, 'plugin.json')]) {
      try { m = Math.max(m, statSync(p).mtimeMs); } catch { /* 忽略：目录可能已被删除 */ }
    }
    return m;
  }

  /** 用户插件目录重扫：新目录注册、变更重载（事务性）、删除卸载 */
  private async rescanUser(): Promise<void> {
    const now = new Set<string>();
    if (existsSync(this.userDir)) {
      const entries = await readdir(this.userDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (SNAPSHOT_SUFFIX.test(e.name)) continue; // 内容快照目录不是插件
        if (!existsSync(join(this.userDir, e.name, 'plugin.json'))) continue;
        now.add(e.name);
        const existing = [...this.registry.values()].find((i) => basename(i.dir) === e.name);
        if (existing) {
          // 生命周期：lazy/停用声明的插件文件变化时重载但保持未激活
          if (existing.manifest.enabled === false || existing.manifest.lazy) {
            await this.reload(existing.manifest.id, false);
          } else {
            await this.reload(existing.manifest.id);
          }
        } else {
          const inst = await this.register(join(this.userDir, e.name));
          // 生命周期：新注册插件同样遵守 enabled=false / lazy 声明（按需加载，不进上下文）
          if (inst && inst.manifest.enabled !== false && !inst.manifest.lazy) await this.start(inst);
        }
      }
    }
    // 卸载已删除的
    for (const inst of [...this.registry.values()]) {
      if (inst.dir.startsWith(this.userDir) && !now.has(basename(inst.dir))) {
        await this.stop(inst);
        this.registry.delete(inst.manifest.id);
        this.dirMtimes.delete(inst.dir);
        pruneSnapshots(inst.dir); // 插件目录已删除：连它的内容快照一并清理（不留孤儿）
        this.applyCleanup(inst);  // 私有存储按 manifest.cleanup 处理
        this.bus.emit(EventBus.event('plugin.unloaded', { id: inst.manifest.id }));
      }
    }
  }

  async dispose(): Promise<void> {
    this.offConfigWatch?.();
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
    for (const inst of [...this.registry.values()].reverse()) await this.stop(inst);
  }
}
