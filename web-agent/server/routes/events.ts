/**
 * server/routes/events.ts —— 全局事件流（前端实时面板，SSE）
 */
import type { Express } from 'express';
import { getChatService, type RouteDeps } from './shared';

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

  // ---------- 全局事件流（前端实时面板） ----------
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 页面存活跟踪：SSE 常驻连接 = 前端页面开着的证据（关闭页面/刷新 → 连接断开）
    tracker?.onConnect(res);
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
        writeEvent('approval.requested', { approvalId: a.id, name: a.name, summary: a.summary, sessionId: a.sessionId, createdAt: a.createdAt, expiresAt: a.expiresAt });
      }
    } catch { /* 服务未就绪时静默：事件流本身仍可用 */ }
    // SSE 心跳：长连接保活
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    const off = kernel.bus.on('*', (e) => {
      // M2 事件类型白名单：只转发前端实际消费的事件（见 SSE_EVENT_TYPES 注释）
      if (!SSE_EVENT_TYPES.has(e.type)) return;
      writeEvent(e.type, e.data, e.traceId);
    });
    req.on('close', () => { off(); clearInterval(heartbeat); tracker?.onDisconnect(res); });
  });
}
