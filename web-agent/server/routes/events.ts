/**
 * server/routes/events.ts —— 全局事件流（前端实时面板，SSE）
 */
import type { Express } from 'express';
import { APPROVAL_TIMEOUT } from '../../core/chat/approvals';
import { approvalTokens } from './approvals';
import { getChatService, SseConnectionLimiter, type RouteDeps } from './shared';
import { auditSseLifecycle } from '../security-policy';

// ---- M2 /api/events 事件类型白名单 ----
// 只转发前端实际消费的事件（ui/src/App.tsx 确认：trace.step / plan.updated /
// todo.updated / workbench.updated / approval.requested / provider.*），宁少勿多——
// 其余总线事件（plugin.* / config.changed / kernel.* 等）属于内部观测噪声，不进 SSE；
// 前端将来需要新事件时在此显式登记。
// parallel.progress：并行小队的分头进度——不让它进白名单，用户就只能干等一条
// 4 分钟超时后的结果（"小队在干嘛"完全没有回声）。
const SSE_EVENT_TYPES = new Set([
  'trace.step', 'plan.updated', 'todo.updated', 'workbench.updated',
  'approval.requested', 'provider.error', 'provider.ok', 'parallel.progress',
]);
/** SSE 单连接待发缓冲上限：write 返回 false（内核缓冲满）且超过该值 → 销毁连接（慢客户端背压保护） */
const SSE_BACKPRESSURE_BYTES = 1_048_576;

export function registerEventRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, tracker } = deps;
  const connectionLimiter = deps.sseLimiter ?? new SseConnectionLimiter(
    Math.max(1, kernel.config.get<number>('sse.maxConnections', 8)),
  );

  // ---------- 全局事件流（前端实时面板） ----------
  app.get('/api/events', (req, res) => {
    if (!connectionLimiter.tryAcquire(res)) {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({ error: '实时事件连接数已达上限，请稍后重试' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-SSE-Retry': '15000',
    });
    // EventSource 会按该值自动重连；服务端不依赖客户端自定义重试逻辑。
    res.write('retry: 15000\n\n');
    // 页面存活跟踪：SSE 常驻连接 = 前端页面开着的证据（关闭页面/刷新 → 连接断开）
    tracker?.onConnect(res);
    auditSseLifecycle(kernel, deps.store, 'connected');
    /** 与事件总线同一帧格式写出去（回放也用同一个出口，格式不会漂移） */
    const writeEvent = (type: string, data: unknown, traceId?: string): void => {
      let frame: string;
      try {
        frame = `event: event\ndata: ${JSON.stringify({ type, traceId, data, ts: Date.now() })}\n\n`;
      } catch {
        return;
      }
      try {
        // M2 背压：write 返回 false（内核发送缓冲满）且待发缓冲超上限 → 销毁连接，
        // 慢客户端不无限占用内存（其 EventSource 会自动重连）
        if (!res.write(frame) && res.writableLength > SSE_BACKPRESSURE_BYTES) res.destroy();
      } catch { /* 已关闭 */ }
    };
    // ---- 连接即回放：断开/刷新期间错过的"未完成事项"补一遍 ----
    // 审批是唯一"服务端在等用户、用户却看不见"的状态（挂起最长 10 分钟），
    // 新连接必须立刻知道有哪些卡在等它点头。
    try {
      for (const a of getChatService(kernel)?.listApprovals() ?? []) {
        writeEvent('approval.requested', { approvalId: a.id, name: a.name, summary: a.summary, sessionId: a.sessionId, createdAt: a.createdAt, expiresAt: a.expiresAt, approvalToken: approvalTokens.issue(a.id, a.sessionId, a.expiresAt) });
      }
    } catch { /* 服务未就绪时静默：事件流本身仍可用 */ }
    // SSE 心跳：长连接保活
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    const off = kernel.bus.on('*', (e) => {
      // M2 事件类型白名单：只转发前端实际消费的事件（见 SSE_EVENT_TYPES 注释）
      if (!SSE_EVENT_TYPES.has(e.type)) return;
      // A6-c：子代理/并行的审批经全局总线到达（父执行器阻塞在子任务 handler 内，
      // 其 approval_required 无法从会话 SSE 流出）——转发时铸发一次性凭据，
      // 与本文件连接回放、chat.ts 会话内审批三处口径一致，前端只需回带同一个字段。
      // 过期时刻取审批板里的**真实** expiresAt（总线事件本身不带），查不到才退回
      // 「现在 + 超时常量」——凭据寿命不该长于它所标识的那次挂起。
      if (e.type === 'approval.requested') {
        const d = (e.data ?? {}) as { approvalId?: string; sessionId?: string };
        if (d.approvalId) {
          const live = getChatService(kernel)?.listApprovals().find((a) => a.id === d.approvalId);
          writeEvent(e.type, {
            ...d,
            sessionId: d.sessionId ?? live?.sessionId,
            createdAt: (d as { createdAt?: number }).createdAt ?? live?.createdAt,
            expiresAt: live?.expiresAt ?? Date.now() + APPROVAL_TIMEOUT,
            approvalToken: approvalTokens.issue(
              d.approvalId,
              d.sessionId ?? live?.sessionId,
              live?.expiresAt ?? Date.now() + APPROVAL_TIMEOUT,
            ),
          }, e.traceId);
          return;
        }
      }
      writeEvent(e.type, e.data, e.traceId);
    });
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      off();
      clearInterval(heartbeat);
      connectionLimiter.release(res);
      tracker?.onDisconnect(res);
      auditSseLifecycle(kernel, deps.store, 'disconnected');
    };
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  });
}
