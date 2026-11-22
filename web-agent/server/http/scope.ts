/**
 * server/routes/scope.ts —— 租户与装配作用域
 * 路由层最外圈的两件事：谁在调用（租户）、注册时拿到什么依赖。
 */
import type { Express } from 'express';
import type { Kernel } from '../../kernel';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import type { Scheduler } from '../scheduler';
import type { HostPorts } from '../host/ports';
import type { SseConnectionLimiter } from './sse';

/** 各资源路由文件的公共依赖（index.ts 装配时统一传入） */
export interface RouteDeps extends HostPorts {
  kernel: Kernel;
  store: Store;
  tracker?: ClientTracker;
  sseLimiter?: SseConnectionLimiter;
  /** 活跃 chat run 计数（M3 自动停止机制的事实源；句柄审计对外暴露用） */
  activeRunCount?: () => number;
  scheduler?: Scheduler;
}

export const DEFAULT_TENANT = 'default';

/** 租户作用域来自上游中间件；缺省走 default，保持单用户模式兼容。 */
export function tenantIdOf(req: unknown): string {
  const value = (req as { tenantId?: unknown } | undefined)?.tenantId;
  return typeof value === 'string' && value ? value : DEFAULT_TENANT;
}

/** 资源路由注册函数的统一签名 */
export type RegisterFn = (app: Express, deps: RouteDeps) => void;
