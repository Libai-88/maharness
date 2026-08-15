/**
 * kernel/plugin-loader.ts —— 插件加载与热管理
 *
 * 第一性原理：变化与稳定的分离——Agent 的能力边界必然随需求生长，
 * 若能力与内核耦合，每次生长都要重写内核；因此「薄内核 + 全插件化」：
 * 内核只做三件事（事件总线、配置、资源管理），一切能力以插件形式注册。
 * 插件 = plugins/<name>/ 目录（plugin.json + 入口）。现场写、现场加载、现场启停。
 * 能力注册表：插件通过 ctx.register 注册 tool/listener/command/provider。
 * 仅监听用户插件目录（plugins/），core/ 内置插件不热重载（改动需重启）。
 */
import { existsSync, readFileSync, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus } from './bus';
import type {
  Capability, Plugin, PluginContext, PluginManifest,
} from './types';

interface PluginInstance {
  manifest: PluginManifest;
  dir: string;
  state: 'registered' | 'loaded' | 'started' | 'stopped' | 'error';
  plugin?: Plugin;
  caps: Capability[];
  error?: string;
}

export class PluginLoader {
  private registry = new Map<string, PluginInstance>();
  private watcher?: ReturnType<typeof watch>;
  private reloadTimer?: NodeJS.Timeout;

  constructor(
    private bus: EventBus,
    private ctxBase: Omit<PluginContext, 'pluginId' | 'register' | 'logger' | 'bus'>,
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

  /** 注册（解析清单、依赖检查、动态加载入口） */
  async register(dir: string): Promise<PluginInstance | undefined> {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as PluginManifest;
      if (this.registry.has(manifest.id)) return this.registry.get(manifest.id);
      const inst: PluginInstance = { manifest, dir, state: 'registered', caps: [] };
      this.registry.set(manifest.id, inst);
      this.bus.emit(EventBus.event('plugin.registered', { id: manifest.id, name: manifest.name, version: manifest.version }));

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
      const plugin = (mod.default ?? mod) as Plugin;
      inst.plugin = plugin;

      const ctx = this.buildContext(inst);
      await plugin.onLoad?.(ctx);
      inst.state = 'loaded';
      this.bus.emit(EventBus.event('plugin.loaded', { id: manifest.id, caps: inst.caps.map((c) => c.kind) }));
      return inst;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin] 加载失败 ${basename(dir)}: ${msg}`);
      this.bus.emit(EventBus.event('plugin.error', { dir: basename(dir), error: msg }));
      return undefined;
    }
  }

  private buildContext(inst: PluginInstance): PluginContext {
    return {
      pluginId: inst.manifest.id,
      kernel: this.ctxBase.kernel,
      bus: this.bus,
      config: this.ctxBase.config,
      trace: this.ctxBase.trace,
      cache: this.ctxBase.cache,
      register: (cap: Capability) => {
        inst.caps.push(cap);
        this.bus.emit(EventBus.event('plugin.capability', {
          pluginId: inst.manifest.id, kind: cap.kind,
          name: cap.kind === 'tool' ? cap.tool.name : cap.kind === 'command' ? cap.command.name : cap.kind === 'provider' ? cap.provider.id : undefined,
        }));
      },
      logger: {
        info: (msg, meta) => console.log(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        warn: (msg, meta) => console.warn(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        error: (msg, meta) => console.error(`[${inst.manifest.id}] ${msg}`, meta ?? ''),
        debug: (msg, meta) => { if (process.env.DEBUG) console.debug(`[${inst.manifest.id}] ${msg}`, meta ?? ''); },
      },
    };
  }

  async start(inst: PluginInstance): Promise<void> {
    try {
      await inst.plugin?.onStart?.(this.buildContext(inst));
      inst.state = 'started';
      this.bus.emit(EventBus.event('plugin.started', { id: inst.manifest.id }));
    } catch (err) {
      inst.state = 'error';
      inst.error = err instanceof Error ? err.message : String(err);
      this.bus.emit(EventBus.event('plugin.error', { id: inst.manifest.id, error: inst.error }));
    }
  }

  async stop(inst: PluginInstance): Promise<void> {
    if (inst.state !== 'started' && inst.state !== 'loaded') return;
    try { await inst.plugin?.onStop?.(this.buildContext(inst)); } catch { /* 忽略 */ }
    // onUnload：插件在此清理资源（取消事件订阅等）。监听器泄漏的官方解法：
    // 插件保存 ctx.bus.on 返回的 off 句柄，在 onUnload 中调用。
    try { await inst.plugin?.onUnload?.(this.buildContext(inst)); } catch { /* 忽略 */ }
    inst.state = 'stopped';
    this.bus.emit(EventBus.event('plugin.stopped', { id: inst.manifest.id }));
  }

  // ---------- 对外管理 API ----------

  list(): PluginInstance[] {
    return [...this.registry.values()];
  }

  get(id: string): PluginInstance | undefined {
    return this.registry.get(id);
  }

  /** 按能力类型聚合查询（如全部 tool） */
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
    // registered（未加载）/ loaded（lazy 声明：onLoad 已执行但未启动）/ stopped（停用后）
    // 均可激活——dynamic capability loading：能力按需进入上下文
    if (inst.state === 'registered' || inst.state === 'loaded' || inst.state === 'stopped') {
      inst.plugin = inst.plugin; // 保留已加载实例
      await this.start(inst);
    } else throw new Error(`插件当前状态: ${inst.state}`);
  }

  async disable(id: string): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    await this.stop(inst);
  }

  async reload(id: string, start = true): Promise<void> {
    const inst = this.registry.get(id);
    if (!inst) throw new Error(`插件不存在: ${id}`);
    const { dir } = inst;
    await this.stop(inst);
    // 先广播卸载，让依赖 unloaded 事件的插件（如 self-extend 的状态跟踪）清理旧状态
    this.bus.emit(EventBus.event('plugin.unloaded', { id: inst.manifest.id }));
    // 清能力与实例，重新注册（新 query 参数绕过模块缓存）
    inst.caps = [];
    this.registry.delete(id);
    const fresh = await this.register(dir);
    // 生命周期：lazy/停用声明的插件重载后保持未激活（不进入上下文）
    if (fresh && start) await this.start(fresh);
    this.bus.emit(EventBus.event('plugin.reloaded', { id }));
  }

  /** 重载全部插件（环境变量/全局配置变化后调用；单个失败不阻断其余） */
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

  /** 用户插件目录重扫：新目录注册、变更重载、删除卸载 */
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
