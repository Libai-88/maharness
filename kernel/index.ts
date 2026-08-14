/**
 * kernel/index.ts —— 内核聚合入口
 * 内核仅 5 大件：EventBus / Config / Trace / Cache / PluginLoader。
 * 其余一切能力由插件提供（含对话本身）。
 */
import { join } from 'node:path';
import { EventBus } from './bus';
import { Config, paths } from './config';
import { Trace } from './trace';
import { Cache } from './cache';
import { PluginLoader } from './plugin-loader';
import type { Paths } from './config';

export { EventBus } from './bus';
export { Config, paths } from './config';
export { Trace } from './trace';
export { Cache } from './cache';
export { PluginLoader } from './plugin-loader';
export * from './types';

export class Kernel {
  readonly bus = new EventBus();
  readonly config: Config;
  readonly trace: Trace;
  readonly cache: Cache;
  readonly plugins: PluginLoader;
  readonly paths: Paths;
  readonly rootDir: string;

  constructor(rootDir: string, defaults: Record<string, unknown> = {}) {
    this.rootDir = rootDir;
    this.paths = paths(rootDir);
    this.config = new Config(this.bus, defaults, this.paths.configFile);
    this.trace = new Trace(this.bus, this.paths.traces);
    this.cache = new Cache();
    this.plugins = new PluginLoader(
      this.bus,
      { kernel: this, config: this.config, trace: this.trace, cache: this.cache },
      join(rootDir, 'core'),
      join(rootDir, 'plugins'),
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
    this.bus.emit(EventBus.event('kernel.stopped', {}));
  }
}
