/**
 * kernel/config.ts —— 分层配置
 * defaults → config.json（用户） → 显式 env → 运行时修改（最高）
 * 变更发布 config.changed 事件，支持热更新。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from './bus';

export class Config {
  private store: Record<string, unknown>;

  constructor(
    private bus: EventBus,
    defaults: Record<string, unknown> = {},
    configPath?: string,
  ) {
    this.store = { ...defaults };
    if (configPath && existsSync(configPath)) {
      try {
        const userCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        Object.assign(this.store, userCfg);
      } catch (err) {
        console.warn(`[config] 读取 ${configPath} 失败，忽略用户配置:`, err);
      }
    }
  }

  /** 读取配置，支持点路径（a.b.c） */
  get<T>(key: string, def?: T): T {
    const value = key.split('.').reduce<unknown>((acc, k) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
      return undefined;
    }, this.store);
    return (value === undefined ? def : value) as T;
  }

  /** 运行时修改（最高层），广播 config.changed */
  set(key: string, value: unknown): void {
    const parts = key.split('.');
    let node: Record<string, unknown> = this.store;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
    this.bus.emit(EventBus.event('config.changed', { key, value }));
  }

  /** 插件的独立配置命名空间：config.<pluginId>.* */
  section(pluginId: string): Record<string, unknown> {
    return (this.get<Record<string, unknown>>(pluginId) ?? {});
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
  };
}

export type Paths = ReturnType<typeof paths>;
