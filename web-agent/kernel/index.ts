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

export { EventBus } from './bus';
export { Config, paths } from './config';
export { Trace } from './trace';
export { Cache } from './cache';
export { Budget, classifyTask } from './budget';
export { EffectScope } from './scope';
export { Service } from './service';
export { PluginLoader } from './plugin-loader';
export * from './types';
export { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart } from './sandbox';
export type { ReadResult } from './sandbox';

export class Kernel {
  readonly bus = new EventBus();
  readonly config: Config;
  readonly trace: Trace;
  readonly cache: Cache;
  readonly budget: Budget;   // 认知资源管理（harness 管，不是 LLM 自觉）
  readonly plugins: PluginLoader;
  readonly paths: Paths;
  readonly rootDir: string;

  /**
   * @param opts.dataDir        数据目录覆盖（DB/traces/cache 落此；默认 <rootDir>/data，与历史行为一致）
   * @param opts.userPluginsDir 用户插件目录覆盖（默认 <rootDir>/plugins）；core 插件目录始终为 <rootDir>/core
   * （供 selftest 等场景做临时目录隔离，不污染生产数据；不传时行为与旧签名完全一致）
   */
  constructor(rootDir: string, defaults: Record<string, unknown> = {}, opts: { dataDir?: string; userPluginsDir?: string } = {}) {
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
    this.trace = new Trace(this.bus, this.paths.traces);
    this.cache = new Cache(undefined, {
      l1TextThreshold: this.config.get<number>('cache.l1Threshold', 0.58),
      l2TtlMs: this.config.get<number>('cache.l2TtlMin', 30) * 60_000,
    }, this.paths.cacheFile);
    // 缓存参数热更新：config.json 的 cache.* 键变化即时生效（无需重启/重建 Cache）
    this.config.watch('cache.*', (key, value) => {
      if (key === 'cache.l1Threshold' && typeof value === 'number') {
        this.cache.setConfig({ l1TextThreshold: value });
      } else if (key === 'cache.l2TtlMin' && typeof value === 'number') {
        this.cache.setConfig({ l2TtlMs: value * 60_000 });
      }
    });
    this.budget = new Budget(this.config.get<number>('budget.subagentMaxTotal', 8));
    this.plugins = new PluginLoader(
      this.bus,
      { kernel: this, config: this.config, trace: this.trace, cache: this.cache },
      join(rootDir, 'core'),
      opts.userPluginsDir ?? join(rootDir, 'plugins'),
    );
  }

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
    this.bus.emit(EventBus.event('kernel.stopped', {}));
  }
}
