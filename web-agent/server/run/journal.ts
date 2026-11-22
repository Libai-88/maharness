// server/run/journal.ts —— 事件发布与订阅表（ADR 0008）
//
// HTTP 连接只是事件日志的读者：读得慢、读失败、断开都不得影响执行状态。
// 因此发布时逐个调用订阅者并吞掉异常，订阅表按 run 分组，退订时删除当初那一份集合。
import type { RunEvent } from '../../kernel/run';

export class RunJournal {
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  /** onEvent 用于在广播前刷新活动记录快照，不参与订阅语义。 */
  constructor(private readonly onEvent?: (event: RunEvent) => void) {}

  publish(event: RunEvent): void {
    this.onEvent?.(event);
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        /* A failed reader cannot change execution state. */
      }
    }
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    // 闭包捕获局部常量：退订时必须删除当初订阅的那一份集合
    const target = set;
    target.add(listener);
    return () => {
      target.delete(listener);
      if (!target.size) this.listeners.delete(id);
    };
  }

  close(): void {
    this.listeners.clear();
  }
}
