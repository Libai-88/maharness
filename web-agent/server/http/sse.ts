/**
 * server/routes/sse.ts —— 事件流写入与连接配额
 * SSE 是只读消费：写一帧、限个句柄数，不承载任何业务判断。
 */
import type { Response } from 'express';

/** 写一帧 SSE 事件 */
export function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 进程级 SSE 句柄配额，供全局事件流与聊天流共享。 */
export class SseConnectionLimiter {
  private readonly active = new Set<unknown>();
  constructor(private readonly maxConnections = 8) {}
  tryAcquire(connection: unknown): boolean {
    if (this.active.has(connection)) return true;
    if (this.active.size >= this.maxConnections) return false;
    this.active.add(connection);
    return true;
  }
  release(connection: unknown): void {
    this.active.delete(connection);
  }
  get size(): number {
    return this.active.size;
  }
}
