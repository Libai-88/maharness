/**
 * kernel/bus.ts —— EventBus 事件总线
 * 内核与插件、插件与插件之间的唯一通信通道。
 * 事件命名：域.对象.动作；支持通配符（agent.*）与优先级订阅。
 */
import type { Event, EventListener, KernelEvents } from './types';

/** 通配符匹配：'agent.*' 匹配 'agent.turn.started'；'*' 匹配一切 */
function match(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1));
  return false;
}

interface ListenerEntry {
  pattern: string;
  listener: EventListener;
  priority: number;
  seq: number;
}

/** emitAsync 中单个监听器超过该时长仍未完成时告警一次（不中断、不取消） */
const ASYNC_LISTENER_WARN_MS = 10_000;

/** 递归深度保护错误标记：enter 抛错时附带，emit 据此识别并向上传播（而非被监听器错误隔离吞掉） */
const DEPTH_ERROR = Symbol('bus.depth-error');

function isDepthError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<PropertyKey, unknown>)[DEPTH_ERROR] === true;
}

export class EventBus {
  /** 桶结构（B8）：priority → 监听器数组（同 priority 按 seq 升序）。
   *  替代旧插入排序数组——订阅 O(1) 追加，emit 按 priority 降序遍历桶；
   *  监听器上千（trace.step 类高频事件）时不再有 O(n²) 累积。 */
  private buckets = new Map<number, ListenerEntry[]>();
  /** 已排序（降序）的 priority 列表：emit 遍历顺序（桶为空时同步移除） */
  private priorities: number[] = [];
  private seq = 0;
  /** 实例级递归深度计数：emit 与 emitAsync 共享。
   *  进入 +1 / 退出 -1；监听器同步 re-emit（如 config.set 联动 config.changed 死循环）
   *  会令深度递增，超过上限立即抛错打断递归链——比"截断前 N 个监听器"正确：
   *  截断会静默丢弃后续监听器，且无法阻止无限递归消耗栈/内存。 */
  private depth = 0;
  private readonly MAX_DEPTH = 64;

  /** 订阅事件（pattern 支持通配符）。返回取消订阅函数。 */
  on(pattern: string, listener: EventListener, priority = 0): () => void {
    const entry: ListenerEntry = { pattern, listener, priority, seq: ++this.seq };
    let bucket = this.buckets.get(priority);
    if (!bucket) {
      bucket = [];
      this.buckets.set(priority, bucket);
      // 二分插入保持降序（O(log n)）：新 priority 桶就位
      let lo = 0, hi = this.priorities.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.priorities[mid] > priority) lo = mid + 1;
        else hi = mid;
      }
      this.priorities.splice(lo, 0, priority);
    }
    bucket.push(entry); // 同 priority 按 seq 升序（先订阅先执行）
    return () => {
      const b = this.buckets.get(priority);
      if (!b) return;
      const idx = b.indexOf(entry);
      if (idx >= 0) b.splice(idx, 1);
      if (b.length === 0) {
        this.buckets.delete(priority);
        const pi = this.priorities.indexOf(priority);
        if (pi >= 0) this.priorities.splice(pi, 1);
      }
    };
  }

  /** 按 priority 降序 + seq 升序遍历所有匹配监听器（emit/emitAsync/listenersOf 共享）。
   *  对桶做快照：监听器在分发中退订不跳过/不重复后续监听器。 */
  private forEachMatching(type: string, cb: (en: ListenerEntry) => void): void {
    for (const p of this.priorities) {
      const bucket = this.buckets.get(p);
      if (!bucket) continue;
      for (const en of [...bucket]) {
        if (match(en.pattern, type)) cb(en);
      }
    }
  }

  /** 同步发布：监听器抛错被记录，不影响其他监听器。
   *  递归深度超限时抛错（由调用方决定如何呈现——打断事件风暴优先于静默）。
   *  深度错误带 DEPTH_ERROR 标记：在监听器错误隔离（console.error）之外向上传播给
   *  调用方——递归链已在深处中断，调用方应知道发生了风暴（否则只静默告警）。
   *  类型化重载：事件名在 KernelEvents 契约内时，data 形状编译期检查；插件自定义
   *  事件仍走宽松 string 重载（兼容过渡）。 */
  emit<E extends keyof KernelEvents>(e: Event<KernelEvents[E]>): void;
  emit(e: Event): void;
  emit(e: Event): void {
    this.enter(e.type);
    let depthError: unknown;
    try {
      this.forEachMatching(e.type, (en) => {
        try {
          en.listener(e);
        } catch (err) {
          if (isDepthError(err)) {
            depthError ??= err; // 深度保护错误：收集，emit 收尾后上抛
          } else {
            console.error(`[bus] listener error on "${e.type}":`, err);
          }
        }
      });
    } finally {
      this.depth--;
    }
    if (depthError) throw depthError;
  }

  /* ============================================================
     v3 五语义派发：serial / bail / parallel / waterfall / onPhase
     与 emit/on/priority/通配符完全兼容。设计目标：让插件能
     「短路」「并发」「中间件化」任何事件，而不仅是广播。
     ============================================================ */

  /** 收集某事件所有匹配监听器的裸回调（内部共享） */
  private listenersOf(type: string): EventListener[] {
    const out: EventListener[] = [];
    this.forEachMatching(type, (en) => out.push(en.listener));
    return out;
  }

  /** 异步串行 + 短路：顺序 await，首个返回非 null/undefined/false 立即短路返回。
   *  用于「从多个提供者中取一个结果」的链式场景。 */
  async serial<T = unknown>(e: Event<T>): Promise<T | boolean | null | undefined> {
    this.enter(e.type);
    try {
      for (const listener of this.listenersOf(e.type)) {
        const r = await listener(e);
        if (r !== null && r !== undefined && r !== false) return r as T;
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  /** 同步短路：同步版本的首个非空返回。 */
  bail<T = unknown>(e: Event<T>): T | boolean | null | undefined {
    this.enter(e.type);
    try {
      for (const listener of this.listenersOf(e.type)) {
        // listener 返回类型为 void | Promise<void>，但它可能是同步回调（返回同态真值）；
        // 这里用 any 断开 TS 对 void/Promise 的约束（运行时按真值判定短路）
        const r = (listener as (ev: Event) => any)(e);
        if (r !== null && r !== undefined && r !== false) return r as T;
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  /** 并发执行：Promise.allSettled，错误聚合成 AggregateError（不中途放弃其它监听器）。 */
  async parallel(e: Event): Promise<void> {
    this.enter(e.type);
    try {
      const results = await Promise.allSettled(this.listenersOf(e.type).map((l) => Promise.resolve().then(() => l(e))));
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected.length) {
        throw new AggregateError(rejected.map((r) => r.reason), `[bus] "${e.type}" 有 ${rejected.length} 个监听器失败`);
      }
    } finally {
      this.depth--;
    }
  }

  /**
   * 洋葱式中间件（v3，兼容旧 hook 监听器）：
   *  - 事件的 data 保持原对象（旧监听器用 e.data 读改写，天然兼容、字节级不破坏）；
   *  - 另在每个事件上挂 `next`（可调用，实现底层串联/改写）；
   *  - 监听器返回非 undefined → 视为短路接管（result），链停；
   *  - 未返回 → 链自动继续（携带监听器对 data 的改写），落到底层 final。
   *  语义：先注册的监听器在最外层（priority 降序 + seq 升序）。
   */
  async waterfall<T = unknown>(
    type: string,
    ...args: unknown[]
  ): Promise<T> {
    const finalArg = args[args.length - 1];
    if (typeof finalArg !== 'function') throw new TypeError(`[bus] waterfall("${type}") 缺少 final 回调`);
    const final = finalArg as (data: unknown) => T | Promise<T>;
    const data = args.length === 2 ? args[0] : args.slice(0, -1);
    this.enter(type);
    try {
      const listeners = this.listenersOf(type);
      let i = 0;
      const next = async (carry: unknown = data): Promise<T> => {
        if (i >= listeners.length) return final(carry);
        const listener = listeners[i++];
        let called = false;
        let downstream: Promise<T> | undefined;
        const proceed = (value: unknown = carry): Promise<T> => {
          called = true;
          downstream ??= next(value);
          return downstream;
        };
        const e = { type, data: carry, ts: Date.now(), next: proceed } as Event & { next: typeof proceed };
        const r = await listener(e);
        if (r !== undefined) return r as T;
        return called ? (downstream as Promise<T>) : next(carry);
      };
      return next(data);
    } finally {
      this.depth--;
    }
  }

  /** 声明式三阶段钩子：before(value)/after(result, value)/rewrite(value) 注入到 waterfall 链。
   *  以 on 注册一个实监听器：before 前置、rewrite 改写 data、after 收尾。 */
  onPhase(
    pattern: string,
    phase: {
      before?: (value: unknown) => void;
      after?: (result: unknown, value: unknown) => void;
      rewrite?: (value: unknown) => unknown;
    },
    priority = 0,
  ): () => void {
    const listener: EventListener = async (e: Event) => {
      const data = e.data;
      const next = (e as Event & { next?: (d: unknown) => unknown }).next;
      try {
        phase.before?.(data);
        const rewritten = phase.rewrite ? phase.rewrite(data) : data;
        // onPhase 是纯观测/改写钩子，不短路——next 继续链，结果仅回传给 after 收尾
        if (next) {
          const result = await next(rewritten ?? data);
          phase.after?.(result, rewritten ?? data);
        }
      } catch (err) {
        console.error(`[bus] onPhase("${pattern}") hook error:`, err instanceof Error ? err.message : String(err));
        if (next) await next(data);
      }
    };
    return this.on(pattern, listener, priority);
  }

  /** 异步发布：等待所有监听器（含 async）完成后返回，用于生命周期等关键路径。
   *  与 emit 共享递归深度计数；单个监听器超时未完成告警一次（不中断）。
   *  类型化重载同 emit（KernelEvents 契约内的事件 data 编译期检查）。 */
  emitAsync<E extends keyof KernelEvents>(e: Event<KernelEvents[E]>): Promise<void>;
  emitAsync(e: Event): Promise<void>;
  async emitAsync(e: Event): Promise<void> {
    this.enter(e.type);
    try {
      // 先快照匹配监听器（桶结构），再按序逐个 await——保持原有「串行等待」语义
      const matched: ListenerEntry[] = [];
      this.forEachMatching(e.type, (en) => matched.push(en));
      for (const en of matched) {
        try {
          const r = en.listener(e);
          if (r instanceof Promise) await this.watchSlowListener(r, en, e.type);
        } catch (err) {
          console.error(`[bus] listener error on "${e.type}":`, err);
        }
      }
    } finally {
      this.depth--;
    }
  }

  /** 慢监听器观察：超过 ASYNC_LISTENER_WARN_MS 仍未完成时 console.warn 一次，不中断 */
  private watchSlowListener(p: Promise<unknown>, en: ListenerEntry, type: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      timer = undefined;
      console.warn(`[bus] "${type}" 的监听器（pattern="${en.pattern}"）已执行超过 ${ASYNC_LISTENER_WARN_MS / 1000}s 仍未完成（仅告警，不中断）`);
    }, ASYNC_LISTENER_WARN_MS);
    return p.finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<void>;
  }

  /** 进入一次分发：递归深度超限抛错（打断递归链，如 config.set ↔ config.changed 死循环）。
   *  错误附带 DEPTH_ERROR 标记——emit 识别后向上传播给调用方（不被监听器隔离吞掉）。 */
  private enter(type: string): void {
    if (++this.depth > this.MAX_DEPTH) {
      this.depth--;
      const err = new Error(`[bus] 事件递归深度超过 ${this.MAX_DEPTH}："${type}"（疑似监听器联动死循环，如 config.set ↔ config.changed；请检查事件监听器是否无条件 re-emit）`) as Error & Record<PropertyKey, unknown>;
      err[DEPTH_ERROR] = true;
      throw err;
    }
  }

  /** 事件工厂 */
  static event<T>(type: string, data?: T, traceId?: string): Event<T> {
    return { type, data, traceId, ts: Date.now() };
  }
}
