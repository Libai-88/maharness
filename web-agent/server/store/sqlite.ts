/**
 * server/store/sqlite.ts —— 端口在 SQLite 上的适配器
 *
 * 今天是"同一实现的类型收窄"（identity adapter）：每个端口直接指向 Store，
 * 因此没有第二份方法转发，也不会出现"端口与实现漂移"。
 * 换成 PostgreSQL 时，只需实现同一组 `StorePorts` 接口，服务层与用例层不用动。
 */
import type { Store } from '../db';
import type { StorePorts } from './ports';
import { defaultWriteQueue, type WriteQueueStats } from './write-queue';

export function sqlitePorts(store: Store): StorePorts {
  return {
    // 用 getter 而不是把方法解构出来：类方法的 `this` 必须绑定到 Store 实例
    get sessions() {
      return store;
    },
    get providers() {
      return store;
    },
    get models() {
      return store;
    },
    get runs() {
      return store.runs;
    },
    get tenants() {
      return store;
    },
  };
}

/** 单写者的运行统计（设置页/运维脚本可读；不暴露队列内部状态）。 */
export function writeQueueStats(): WriteQueueStats {
  return defaultWriteQueue.stats();
}
