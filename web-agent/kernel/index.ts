/**
 * kernel/index.ts —— 内核聚合入口
 * 内核 7 大件：EventBus / Config / Trace / Cache / Budget(认知资源) /
 *             EffectScope(可逆效应引擎) / PluginLoader(时空可组合性)。
 * 其余一切能力由插件提供（含对话本身）。
 */
import { join } from 'node:path';
import { EventBus } from './bus';
import { Config, paths } from './config';
import { Trace } from './trace';
import { Cache } from './cache';
import { Budget } from './budget';
import { PluginLoader } from './plugin-loader';
import type { Paths } from './config';
import type { KernelLike } from './types';

export { EventBus } from './bus';
export { Config, paths } from './config';
export { Trace } from './trace';
export { Cache } from './cache';
export { Budget, classifyTask } from './budget';
export { EffectScope } from './scope';
export { Service } from './service';
export { PluginLoader, KERNEL_PROVIDER_ID } from './plugin-loader';
export { SERVICE_KEYS, resolveRunnerFactory, makeRunner } from './loop';
export type { AgentEvent, AgentHookCtx, AgentLoop, RunOptions, RunnerFactory } from './loop';
export * from './types';
export { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart } from './sandbox';
export type { ReadResult } from './sandbox';

export class Kernel {
  readonly bus = new EventBus();
  readonly config: Config;
  readonly plugins: PluginLoader;
  readonly paths: Paths;
  readonly rootDir: string;

  /** 内核内置实现（不在解析路径上）：仅作初始化与委托兜底。
   *  对外的 cache/trace/budget 是【解析视图】——见下方同名 getter。 */
  private readonly builtinTrace: Trace;
  private readonly builtinCache: Cache;
  private readonly builtinBudget: Budget;
  /** 内置实现最后一道兜底：解析层若为空（被插件接管后又被撤销）也不会让内核崩 */
  private readonly builtin = new Map<string, unknown>();

  /**
   * @param opts.dataDir        数据目录覆盖（DB/traces/cache 落此；默认 <rootDir>/data，与历史行为一致）
   * @param opts.userPluginsDir 用户插件目录覆盖（默认 <rootDir>/plugins）；core 插件目录始终为 <rootDir>/core
   * @param opts.corePluginsDir 内置插件目录覆盖（默认 <rootDir>/core）——供测试在临时根目录里
   *   装载真实 core 插件栈（否则临时 rootDir 下没有 core/，内核只能跑空插件集）
   * （供 selftest 等场景做临时目录隔离，不污染生产数据；不传时行为与旧签名完全一致）
   */
  constructor(rootDir: string, defaults: Record<string, unknown> = {}, opts: { dataDir?: string; userPluginsDir?: string; corePluginsDir?: string } = {}) {
    this.rootDir = rootDir;
    const base = paths(rootDir);
    this.paths = opts.dataDir
      ? {
        ...base,
        data: opts.dataDir,
        traces: join(opts.dataDir, 'traces'),
        dbFile: join(opts.dataDir, 'agent.db'),
        cacheFile: join(opts.dataDir, 'cache.json'),
      }
      : base;
    this.config = new Config(this.bus, defaults, this.paths.configFile);
    this.builtinTrace = new Trace(this.bus, this.paths.traces);
    this.builtinCache = new Cache(undefined, {
      l1TextThreshold: this.config.get<number>('cache.l1Threshold', 0.58),
      l2TtlMs: this.config.get<number>('cache.l2TtlMin', 30) * 60_000,
    }, this.paths.cacheFile);
    // 缓存参数热更新：config.json 的 cache.* 键变化即时生效（无需重启/重建 Cache）
    this.config.watch('cache.*', (key, value) => {
      if (key === 'cache.l1Threshold' && typeof value === 'number') {
        this.builtinCache.setConfig({ l1TextThreshold: value });
      } else if (key === 'cache.l2TtlMin' && typeof value === 'number') {
        this.builtinCache.setConfig({ l2TtlMs: value * 60_000 });
      }
    });
    this.builtinBudget = new Budget(
      this.config.get<number>('budget.subagentMaxTotal', 8),
      join(this.paths.data, 'task-profile.json'),
    );
    this.builtin.set('service:cache', this.builtinCache);
    this.builtin.set('service:trace', this.builtinTrace);
    this.builtin.set('service:budget', this.builtinBudget);
    this.plugins = new PluginLoader(
      this.bus,
      {
        kernel: this as unknown as KernelLike,
        paths: this.paths,
        config: this.config,
        trace: this.builtinTrace,
        cache: this.builtinCache,
        budget: this.builtinBudget,
      },
      opts.corePluginsDir ?? join(rootDir, 'core'),
      opts.userPluginsDir ?? join(rootDir, 'plugins'),
    );
  }

  /**
   * 内核子系统的解析视图（第一性原理：内核只提供「默认实现」，不垄断实现）。
   * 每个访问器都走与插件服务相同的仲裁解析——插件用
   * `ctx.provide('service:cache', impl, priority > 0)` 即可接管缓存/轨迹/预算，
   * 卸载后自动回退到内核内置实现。调用点（含 137 处 ctx.cache/kernel.trace）无需感知。
   */
  private resolveBuiltin<T>(key: string): T {
    return (this.plugins.resolveService(key) ?? this.builtin.get(key)) as T;
  }

  /** 三层缓存（可被插件接管：service:cache） */
  get cache(): Cache { return this.resolveBuiltin<Cache>('service:cache'); }
  /** 可观测性（可被插件接管：service:trace） */
  get trace(): Trace { return this.resolveBuiltin<Trace>('service:trace'); }
  /** 认知资源管理（可被插件接管：service:budget） */
  get budget(): Budget { return this.resolveBuiltin<Budget>('service:budget'); }

  async start(): Promise<void> {
    await this.plugins.loadAll();
    this.plugins.watch();
    this.bus.emit(EventBus.event('kernel.started', {
      root: this.rootDir,
      plugins: this.plugins.list().map((p) => `${p.manifest.id}(${p.state})`),
      l1Cache: this.cache.l1Enabled,
    }));
  }

  async stop(): Promise<void> {
    await this.plugins.dispose();
    this.cache.save(); // 缓存落盘（跨重启保留命中）
    this.trace.flush(); // 轨迹队列兜底落盘（不必等定时器/进程退出钩子）
    this.trace.dispose(); // 移除 exit 监听器（反复 start/stop 不累积）
    this.bus.emit(EventBus.event('kernel.stopped', {}));
  }
}
