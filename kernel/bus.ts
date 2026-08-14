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

export class EventBus {
  private entries: ListenerEntry[] = [];
  private seq = 0;
  private readonly MAX_DEPTH = 64;

  /** 订阅事件（pattern 支持通配符）。返回取消订阅函数。 */
  on(pattern: string, listener: EventListener, priority = 0): () => void {
    const entry: ListenerEntry = { pattern, listener, priority, seq: ++this.seq };
    this.entries.push(entry);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** 同步发布：监听器抛错被记录，不影响其他监听器 */
  emit(e: Event): void {
    for (const en of this.matched(e.type)) {
      try {
        en.listener(e);
      } catch (err) {
        console.error(`[bus] listener error on "${e.type}":`, err);
      }
    }
  }

  /** 异步发布：等待所有监听器（含 async）完成后返回，用于生命周期等关键路径 */
  async emitAsync(e: Event): Promise<void> {
    let depth = 0;
    for (const en of this.matched(e.type)) {
      try {
        const r = en.listener(e);
        if (r instanceof Promise) await r;
      } catch (err) {
        console.error(`[bus] listener error on "${e.type}":`, err);
      }
      if (++depth > this.MAX_DEPTH) {
        console.warn(`[bus] "${e.type}" exceeded max dispatch depth`);
        break;
      }
    }
  }

  private matched(type: string): ListenerEntry[] {
    return this.entries
      .filter((en) => match(en.pattern, type))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  /** 事件工厂 */
  static event<T>(type: string, data?: T, traceId?: string): Event<T> {
    return { type, data, traceId, ts: Date.now() };
  }
}
