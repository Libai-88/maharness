/**
 * server/store/ports.ts —— 仓储端口（ADR 0007 / v4 C2）
 *
 * 端口用 `Pick<Store, ...>` 从现有实现推导：实现改签名，端口自动跟着改，不会出现
 * "手写接口与实现各说各话"。服务层只依赖端口，换库时换适配器即可。
 */
import type { Store } from '../db';

/** 会话与消息（读多写少，几乎所有页面都要） */
export type SessionPort = Pick<
  Store,
  'createSession' | 'getSession' | 'listSessions' | 'updateSession' | 'countSessions' | 'deleteSessions' | 'touchSession'
> &
  Pick<Store, 'addMessage' | 'listMessages' | 'updateMessageStats'>;

/** Provider 配置（含密钥的加解密由实现负责，端口只承诺行为） */
export type ProviderPort = Pick<Store, 'listProviders' | 'getProvider' | 'upsertProvider' | 'deleteProvider' | 'setProviderEnabled'>;

/** 模型与能力画像 */
export type ModelPort = Pick<Store, 'listModels' | 'upsertModels' | 'updateModel'>;

/** 任务事实源（事件、断点、账本都在这里，端口直接复用仓库类型） */
export type RunPort = Store['runs'];

/** 租户配额与聚合 */
export type TenantPort = Pick<Store, 'getTenant' | 'aggregateSessions'>;

export interface StorePorts {
  sessions: SessionPort;
  providers: ProviderPort;
  models: ModelPort;
  runs: RunPort;
  tenants: TenantPort;
}

/**
 * Provider 用例实际需要的最小集合（扁平写法，调用点不用改前缀）：
 * 它同时是"这些代码被允许碰哪些表"的书面声明——想摸别的表必须改这个类型。
 */
export type ProviderStore = Pick<
  Store,
  | 'listProviders'
  | 'getProvider'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setProviderEnabled'
  | 'listModels'
  | 'upsertModels'
  | 'updateModel'
  | 'runs'
>;
