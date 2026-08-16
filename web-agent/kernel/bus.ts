/**
 * kernel/bus.ts —— EventBus 事件总线
 * 内核与插件、插件与插件之间的唯一通信通道。
 * 事件命名：域.对象.动作；支持通配符（agent.*）与优先级订阅。
 */
import type { Event, EventListener } from './types';

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

export class EventBus {
  /** 按 priority 降序维护的监听表（插入排序：订阅时定位，emit 时零排序开销）。
   *  同 priority 按 seq 升序（先订阅先执行）。 */
  private entries: ListenerEntry[] = [];
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
    // 插入排序：从头找第一个 priority 严格更小的位置（同 priority 组的尾部 = seq 递增）
    let i = 0;
    while (i < this.entries.length && this.entries[i].priority >= priority) i++;
    this.entries.splice(i, 0, entry);
    return () => {
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
    };
  }

  /** 同步发布：监听器抛错被记录，不影响其他监听器。
   *  递归深度超限时抛错（由调用方决定如何呈现——打断事件风暴优先于静默）。 */
  emit(e: Event): void {
    this.enter(e.type);
    try {
      for (const en of this.entries) {
        if (!match(en.pattern, e.type)) continue;
        try {
          en.listener(e);
        } catch (err) {
          console.error(`[bus] listener error on "${e.type}":`, err);
        }
      }
    } finally {
      this.depth--;
    }
  }

  /** 异步发布：等待所有监听器（含 async）完成后返回，用于生命周期等关键路径。
   *  与 emit 共享递归深度计数；单个监听器超时未完成告警一次（不中断）。 */
  async emitAsync(e: Event): Promise<void> {
    this.enter(e.type);
    try {
      for (const en of this.entries) {
        if (!match(en.pattern, e.type)) continue;
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
  private watchSlowListener(p: Promise<void>, en: ListenerEntry, type: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      timer = undefined;
      console.warn(`[bus] "${type}" 的监听器（pattern="${en.pattern}"）已执行超过 ${ASYNC_LISTENER_WARN_MS / 1000}s 仍未完成（仅告警，不中断）`);
    }, ASYNC_LISTENER_WARN_MS);
    return p.finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<void>;
  }

  /** 进入一次分发：递归深度超限抛错（打断递归链，如 config.set ↔ config.changed 死循环） */
  private enter(type: string): void {
    if (++this.depth > this.MAX_DEPTH) {
      this.depth--;
      throw new Error(`[bus] 事件递归深度超过 ${this.MAX_DEPTH}："${type}"（疑似监听器联动死循环，如 config.set ↔ config.changed；请检查事件监听器是否无条件 re-emit）`);
    }
  }

  /** 事件工厂 */
  static event<T>(type: string, data?: T, traceId?: string): Event<T> {
    return { type, data, traceId, ts: Date.now() };
  }
}
