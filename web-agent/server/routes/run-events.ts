import type { Request, Response } from 'express';
import type { RunService } from '../run-service';
import { RunError } from '../run-service';
import { RUN_TERMINAL, type RunEvent, type RunRecord } from '../../kernel/run';
import type { RouteDeps } from './shared';
import { getChatService } from './shared';
import { approvalTokens } from './approvals';

const BATCH = 100;

function parseCursor(req: Request): number {
  const rawCursor = req.get('Last-Event-ID') ?? req.query.after ?? '0';
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RunError(400, 'INVALID_CURSOR', '事件游标无效');
  return cursor;
}

/** 审批事件补上 active / expiresAt / approvalToken；其余事件原样返回。 */
function eventPayload(event: RunEvent, run: RunRecord, deps: RouteDeps) {
  if (event.type !== 'approval_required') return event.data;
  const approval = getChatService(deps.kernel)
    ?.listApprovals()
    .find((item) => item.id === event.data.approvalId && item.sessionId === run.sessionId);
  if (!approval) return { ...event.data, active: false };
  return {
    ...event.data,
    active: true,
    expiresAt: approval.expiresAt,
    approvalToken: approvalTokens.issue(approval.id, run.sessionId, approval.expiresAt),
  };
}

/** 有界批量写出事件；返回最新游标，返回 undefined 表示客户端背压或连接已断。 */
function drainEvents(run: RunRecord, deps: RouteDeps, res: Response, after: number): number | undefined {
  let cursor = after;
  for (;;) {
    const batch = deps.store.runs.events(run.id, cursor, BATCH);
    for (const event of batch) {
      cursor = event.seq;
      const data = eventPayload(event, run, deps);
      if (!res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`)) return undefined;
    }
    if (batch.length < BATCH) return cursor;
  }
}

export function streamRunEvents(req: Request, res: Response, run: RunRecord, deps: RouteDeps, service: RunService): void {
  let after = parseCursor(req);
  if (deps.sseLimiter && !deps.sseLimiter.tryAcquire(res)) {
    res.setHeader('Retry-After', '15');
    throw new RunError(429, 'SSE_CAPACITY', '事件订阅数已达上限');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let disposed = false;
  const drain = () => {
    if (disposed || res.writableEnded || res.destroyed || res.writableNeedDrain) return;
    // Bounded batches and drain notifications keep slow readers from growing server memory.
    const next = drainEvents(run, deps, res, after);
    if (next === undefined) return;
    after = next;
    if (RUN_TERMINAL.has(service.get(run.id, run.tenantId).status)) res.end();
  };
  const unsubscribe = service.subscribe(run.id, drain);
  const heartbeat = setInterval(() => {
    if (!res.writableNeedDrain) res.write(': ping\n\n');
  }, 15_000);
  res.on('drain', drain);
  res.on('close', () => {
    disposed = true;
    unsubscribe();
    clearInterval(heartbeat);
    deps.sseLimiter?.release(res);
  });
  drain();
}
