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
 * 生命周期状态机（惯性转换）：registered → loaded → started ⇄ stopped
 *   载入/卸载/重载期间标记 loading/unloading（先停供再回收，依赖方先于逆元被通知）；
 *   同一插件在途转换未完成时不响应新目标（惯性，防快速文件变更竞态）。
 */
import { existsSync, readFileSync, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus } from './bus';
import { EffectScope } from './scope';
import type {
  Capability, EventListener, Plugin, PluginContext, PluginManifest,
} from './types';

type PluginState = 'registered' | 'loaded' | 'started' | 'stopped' | 'loading' | 'unloading' | 'error';

interface PluginInstance {
  manifest: PluginManifest;
  dir: string;
  state: PluginState;
  plugin?: Plugin;
  caps: Capability[];
  /** 可逆效应作用域：插件全部副作用的逆元在此累积，卸载按 LIFO 恢复 */
  scope: EffectScope;
  /** 惯性转换句柄：在途的 reload/unload 完成前不响应新目标 */
  inertia?: Promise<void>;
  /** 动态提供的服务键（ctx.provide 登记，供依赖图谱可查） */
  provides: string[];
  error?: string;
}

export class PluginLoader {
  private registry = new Map<string, PluginInstance>();
  private watcher?: ReturnType<typeof watch>;
  private reloadTimer?: NodeJS.Timeout;
  /** 能力集反应性订阅：onCapabilities(kind, cb)——某类能力集合变化时通知 */
  private capSubs = new Map<string, Set<() => void>>();
  /** 服务共效应注册表：key → 当前提供者绑定（每个键至多一个活动提供者） */
  private providers = new Map<string, { pluginId: string; value: unknown }>();
  /** 依赖方注册表：key → 订阅者（绑定出现/消失/换主时通知） */
  private dependents = new Map<string, Set<(v: unknown | undefined) => void>>();

  constructor(
    private bus: EventBus,
    private ctxBase: Omit<PluginContext, 'pluginId' | 'register' | 'logger' | 'bus' | 'on' | 'provide' | 'inject' | 'onCapabilities' | 'watchConfig' | 'effect'>,
    private coreDir: string,
    private userDir: string,
  ) {}

  /** 扫描并加载全部插件（core 在前，用户插件在后，确保依赖顺序）
   *  生命周期控制：manifest.enabled=false 声明停用、lazy=true 声明惰性加载
   *  （类似 OS 驱动按需加载——注册可见，但不自动进入上下文，LLM 需要时 enable_plugin 激活） */
  async loadAll(): Promise<void> {
    await this.scanDir(this.coreDir);
    await this.scanDir(this.userDir);
    for (const inst of this.registry.values()) {
      if (inst.state !== 'started' && inst.state !== 'stopped') {
        if (inst.manifest.enabled === false || inst.manifest.lazy) continue;
        await this.start(inst);
      }
    }
  }

  /** 扫描单个插件目录（dir 下每个子目录 = 一个插件） */
  private async scanDir(root: string): Promise<void> {
    if (!existsSync(root)) return;
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      await this.register(dir);
    }
  }

  /** 注册（解析清单、依赖检查、动态加载入口、onLoad）。已注册则返回现有实例。 */
  async register(dir: string): Promise<PluginInstance | undefined> {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as PluginManifest;
      if (this.registry.has(manifest.id)) return this.registry.get(manifest.id);
      const inst: PluginInstance = { manifest, dir, state: 'registered', caps: [], scope: new EffectScope(), provides: [] };
      this.registry.set(manifest.id, inst);
      this.bus.emit(EventBus.event('plugin.registered', { id: manifest.id, name: manifest.name, version: manifest.version, provides: manifest.provides }));

      // 依赖检查（requires 中的插件必须先 loaded）
      for (const dep of manifest.requires ?? []) {
        const depInst = this.registry.get(dep);
        if (!depInst || depInst.state === 'registered') {
          throw new Error(`缺少依赖插件: ${dep}`);
        }
      }

      // 动态加载入口（query 参数绕过模块缓存，实现热重载）
      const entryUrl = pathToFileURL(join(dir, manifest.entry)).href + `?t=${Date.now()}`;
      const mod = await import(entryUrl);
      inst.plugin = (mod.default ?? mod) as Plugin;
      await this.runLoad(inst);
      return inst;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin] 加载失败 ${basename(dir)}: ${msg}`);
      this.bus.emit(EventBus.event('plugin.error', { dir: basename(dir), error: msg }));
      return undefined;
    }
  }

  /** 执行 onLoad（副作用全部进入实例的 EffectScope——卸载即自动恢复） */
  private async runLoad(inst: PluginInstance): Promise<void> {
    const ctx = this.buildContext(inst);
    await inst.plugin?.onLoad?.(ctx);
    inst.state = 'loaded';
    this.bus.emit(EventBus.event('plugin.loaded', { id: inst.manifest.id, caps: inst.caps.map((c) => c.kind), provides: [...inst.provides] }));
  }

  /** 构建插件上下文：一切副作用（register/on/provide/watchConfig）自动入 scope */
  private buildContext(inst: PluginInstance): PluginContext {
    const scope = inst.scope;
    const loader = this;
    return {
      pluginId: inst.manifest.id,
      kernel: this.ctxBase.kernel,
      bus: this.bus,
      config: this.ctxBase.config,
      trace: this.ctxBase.trace,
      cache: this.ctxBase.cache,
      register: (cap: Capability) => {
        // 可逆效应：登记能力并留下逆元（卸载时自动回收，无需作者手工 unregister）
        inst.caps.push(cap);
        if (cap.kind === 'service' && inst.state === 'started') {
          // 运行期动态注册服务：立即发布（绑定只在提供者 ACTIVE 时对依赖方可见）
          this.publish(`service:${cap.service.id}`, inst, cap.service.instance);
        }
        this.notifyCapSet(cap.kind);
        this.bus.emit(EventBus.event('plugin.capability', {
          pluginId: inst.manifest.id, kind: cap.kind,
          name: cap.kind === 'tool' ? cap.tool.name : cap.kind === 'command' ? cap.command.name : cap.kind === 'provider' ? cap.provider.id : undefined,
        }));
        const unregister = () => {
          const i = inst.caps.indexOf(cap);
          if (i >= 0) {
            inst.caps.splice(i, 1);
            if (cap.kind === 'service') this.withdraw(`service:${cap.service.id}`, inst);
            this.notifyCapSet(cap.kind);
          }
        };
        scope.add(unregister);
        return unregister;
      },
      on: (event: string, listener: EventListener, priority?: number) => {
        // 自动退订的事件订阅：卸载时随作用域回收，杜绝监听器泄漏
        const off = this.bus.on(event, listener, priority);
        scope.add(off);
        return off;
      },
      provide: (key: string, value: unknown) => {
        this.publish(key, inst, value);
        const unprovide = () => this.withdraw(key, inst);
        scope.add(unprovide);
        return unprovide;
      },
      inject: (key: string, onChange?: (v: unknown | undefined) => void) => {
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
          value: this.providers.get(key)?.value,
          stop: off, // 显式退订（未退订时卸载随作用域回收）
        };
      },
      onCapabilities: (kind: Capability['kind'], cb: () => void) => {
        let set = this.capSubs.get(kind);
        if (!set) { set = new Set(); this.capSubs.set(kind, set); }
        set.add(cb);
        const off = () => {
          const s = this.capSubs.get(kind);
          if (s) { s.delete(cb); if (s.size === 0) this.capSubs.delete(kind); }
        };
        scope.add(off);
        return off;
      },
      watchConfig: (key: string, cb: (value: unknown) => void) => {
        // 声明式配置对账：按「变了哪个键」分派（最小干预），自动退订
        const off = this.ctxBase.config.watch(key, (_k, v) => cb(v));
        scope.add(off);
        return off;
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

  // ---------- 服务共效应注册表（反应性依赖） ----------

  /** 发布绑定：键 → 提供者。通知依赖方（激活/换主）。 */
  private publish(key: string, inst: PluginInstance, value: unknown): void {
    this.providers.set(key, { pluginId: inst.manifest.id, value });
    if (!inst.provides.includes(key)) inst.provides.push(key);
    this.bus.emit(EventBus.event('service.provided', { key, pluginId: inst.manifest.id }));
    this.notifyDependents(key, value);
  }

  /** 撤回绑定（仅当当前提供者确实是本插件）。依赖方收到 undefined（停用通知）。 */
  private withdraw(key: string, inst: PluginInstance): void {
    const cur = this.providers.get(key);
    if (!cur || cur.pluginId !== inst.manifest.id) return;
    this.providers.delete(key);
    this.bus.emit(EventBus.event('service.withdrawn', { key, pluginId: inst.manifest.id }));
    this.notifyDependents(key, undefined);
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
    const subs = this.capSubs.get(kind);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(); } catch (err) {
        console.warn(`[loader] 能力集通知失败 (${kind}):`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 内核/服务端向插件外消费方暴露的同步解析（如 server 层取 chat 服务） */
  resolveService(key: string): unknown | undefined {
    return this.providers.get(key)?.value;
  }

  // ---------- 生命周期（惯性转换：在途转换完成前不响应新目标） ----------

  async start(inst: PluginInstance): Promise<void> {
    if (inst.inertia) await inst.inertia; // 惯性：等在途转换
    const task = (async () => {
      if (inst.state === 'started') return;
      inst.state = 'loading';
      try {
        await inst.plugin?.onStart?.(this.buildContext(inst));
        inst.state = 'started';
        this.bus.emit(EventBus.event('plugin.started', { id: inst.manifest.id }));
        // 服务共效应发布：started 后插件提供的服务才对依赖方可见（绑定只在 ACTIVE 时有效）
        for (const cap of inst.caps) {
          if (cap.kind === 'service') this.publish(`service:${cap.service.id}`, inst, cap.service.instance);
        }
        // 能力集反应性通知：started 后能力才对 capabilities() 可见——
        // 通知订阅者（如 chat 的 persona 集订阅），保证「启动即生效」而非等下次变化
        for (const kind of new Set(inst.caps.map((c) => c.kind))) this.notifyCapSet(kind);
      } catch (err) {
        inst.state = 'error';
        inst.error = err instanceof Error ? err.message : String(err);
        this.bus.emit(EventBus.event('plugin.error', { id: inst.manifest.id, error: inst.error }));
      }
    })();
    inst.inertia = task;
    await task;
  }

  async stop(inst: PluginInstance): Promise<void> {
    if (inst.inertia) await inst.inertia; // 惯性：等在途转换
    const task = (async () => {
      if (inst.state !== 'started' && inst.state !== 'loaded') return;
      // L-Leave：先标记停供（依赖方看到停用后自行降级），再执行逆元
      inst.state = 'unloading';
      // 可逆效应：LIFO 回收插件全部副作用（能力/订阅/服务绑定/配置变更一并恢复）
      const tracked = inst.scope.size;
      await inst.scope.dispose();
      if (tracked > 0) {
        this.bus.emit(EventBus.event('plugin.reverted', { id: inst.manifest.id, effects: tracked }));
      }
      // 旧式钩子保留：有手工清理的插件仍可在此补位（自动回收已覆盖大部分场景）
      try { await inst.plugin?.onStop?.(this.buildContext(inst)); } catch { /* 忽略 */ }
      try { await inst.plugin?.onUnload?.(this.buildContext(inst)); } catch { /* 忽略 */ }
      inst.state = 'stopped';
      // 换新作用域：enable 重新部署时（onLoad 重跑）副作用进入新作用域，与已回收的旧作用域隔离
      inst.scope = new EffectScope();
      this.bus.emit(EventBus.event('plugin.stopped', { id: inst.manifest.id }));
    })();
    inst.inertia = task;
    await task;
  }

  /**
   * 事务性热重载：旧实例效果全部回收（但旧模块保留在内存）→ 加载新版本 → 成功则提交；
   * 失败则丢弃半成品、用旧模块重建实例（回滚）——系统永不进入"半加载"状态。
   * 惯性：在途转换期间的新请求等待完成后才开始。
   */
  async reload(id: string, start = true): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    if (inst.inertia) await inst.inertia; // 惯性：等在途转换
    const task = (async () => {
      const { dir } = inst;
      const oldModule = inst.plugin;       // 备份旧模块（事务回滚用）
      const oldManifest = inst.manifest;
      // 事务阶段 1：回收旧实例的全部效果（可逆恢复）——旧模块引用保留
      await this.stop(inst);
      this.bus.emit(EventBus.event('plugin.unloaded', { id: inst.manifest.id }));

      // 事务阶段 2：加载新版本（暂不进入注册表）
      const fresh: PluginInstance = { manifest: oldManifest, dir, state: 'registered', caps: [], scope: new EffectScope(), provides: [] };
      try {
        const entryUrl = pathToFileURL(join(dir, oldManifest.entry)).href + `?t=${Date.now()}`;
        const mod = await import(entryUrl);
        fresh.plugin = (mod.default ?? mod) as Plugin;
        await this.runLoad(fresh);
        if (start && fresh.manifest.enabled !== false && !fresh.manifest.lazy) {
          await this.start(fresh);
        }
        // 提交：替换注册表（旧实例已无副作用残留）
        this.registry.set(id, fresh);
        this.bus.emit(EventBus.event('plugin.reloaded', { id }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 事务回滚：丢弃半成品，用旧模块重建（其副作用已随旧 scope 恢复，重建即还原）
        try {
          await fresh.scope.dispose(); // 回收半成品副作用
          const rollback: PluginInstance = {
            manifest: oldManifest, dir, state: 'registered',
            caps: [], scope: new EffectScope(), provides: [], plugin: oldModule,
          };
          await this.runLoad(rollback);
          if (start && rollback.manifest.enabled !== false && !rollback.manifest.lazy) {
            await this.start(rollback);
          }
          this.registry.set(id, rollback);
          console.warn(`[plugin] ${id} 新版本加载失败，已回滚到旧版本: ${msg}`);
          this.bus.emit(EventBus.event('plugin.error', { id, error: msg, rollback: true }));
          this.bus.emit(EventBus.event('plugin.reloaded', { id, rollback: true }));
        } catch (err2) {
          // 回滚也失败：插件进入 error 态（最坏情况，仍有错误信息可查）
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          inst.state = 'error';
          inst.error = `${msg}；回滚失败: ${msg2}`;
          this.registry.set(id, inst);
          this.bus.emit(EventBus.event('plugin.error', { id, error: inst.error }));
        }
      }
    })();
    inst.inertia = task;
    await task;
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

  // ---------- 对外管理 API ----------

  list(): PluginInstance[] {
    return [...this.registry.values()];
  }

  get(id: string): PluginInstance | undefined {
    return this.registry.get(id);
  }

  /** 按能力类型聚合查询（如全部 tool；仅活动插件） */
  capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[] {
    const out: Extract<Capability, { kind: T }>[] = [];
    for (const inst of this.registry.values()) {
      if (inst.state !== 'started') continue;
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

  async enable(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    if (inst.inertia) await inst.inertia; // 惯性：等在途转换
    // 停用=完全撤离（副作用已随 stop 全部回收）；重新启用=重新部署（onLoad 重跑重建能力）——
    // 与论文的 disabled 字段语义一致：置位卸载 fiber，清除重载。
    // registered（未加载）/ loaded（lazy 声明：onLoad 已执行但未启动）/ stopped（停用后）
    // 均可激活——dynamic capability loading：能力按需进入上下文
    if (inst.state === 'registered' || inst.state === 'loaded' || inst.state === 'stopped') {
      if (inst.state === 'stopped' && inst.plugin) {
        await this.runLoad(inst); // 重建全部能力（进入新作用域）
      }
      await this.start(inst);
    } else throw new Error(`插件当前状态: ${inst.state}`);
  }

  async disable(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    await this.stop(inst);
  }

  // ---------- 热监听（仅用户插件目录） ----------

  watch(): void {
    if (!existsSync(this.userDir)) return;
    try {
      this.watcher = watch(this.userDir, { recursive: true }, () => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.rescanUser(), 500);
      });
    } catch (err) {
      console.warn('[plugin] 目录监听不可用（Windows 递归监听失败时退化为手动 reload）:', err);
    }
  }

  /** 用户插件目录重扫：新目录注册、变更重载（事务性）、删除卸载 */
  private async rescanUser(): Promise<void> {
    const now = new Set<string>();
    if (existsSync(this.userDir)) {
      const entries = await readdir(this.userDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
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
        this.bus.emit(EventBus.event('plugin.unloaded', { id: inst.manifest.id }));
      }
    }
  }

  async dispose(): Promise<void> {
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
    for (const inst of [...this.registry.values()].reverse()) await this.stop(inst);
  }
}
