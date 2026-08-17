/**
 * kernel/service.ts —— 轻量 Service 抽象基类（v3.2）
 *
 * 对齐 Cordis Service 的「构造即提供」思想，落到 maharness 的 capability 形态：
 * 子类构造时自动完成「服务能力注册」（= ctx.register({ kind: 'service', service: { id, instance } })），
 * 插件启动后该服务对 capabilities('service') 可查、对依赖方经 resolveService/inject 可用，
 * 卸载时随 EffectScope 逆元自动撤销——无需作者在 onUnload 手工清理。
 *
 * 与现有 chat 插件手写 `ctx.register({ kind: 'service', ... })` 完全同构；
 * 基类额外提供类型化的 config 读取（config.<id>.* 命名空间，经上下文 override 链）。
 */
import type { PluginContext } from './types';

export abstract class Service {
  public readonly id: string;

  constructor(protected ctx: PluginContext, id: string) {
    this.id = id;
    // 服务能力注册：逆元由 EffectScope 自动回收（卸载即撤销，不重复、不泄漏）
    ctx.register({ kind: 'service', service: { id, instance: this } });
  }

  /** 读取本服务的配置（config.<id>.* 命名空间；经上下文 configWith override 链，
   *  与 ctx.config.section 同一语义——最内层 override 优先，落回全局默认）。 */
  protected config<T = Record<string, unknown>>(): T {
    return this.ctx.config.section(this.id) as T;
  }

  /** 读取配置中的单个键（点路径），带默认值。 */
  protected configGet<T>(key: string, def?: T): T {
    return this.ctx.config.get<T>(`${this.id}.${key}`, def) as T;
  }
}
