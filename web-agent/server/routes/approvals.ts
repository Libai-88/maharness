/**
 * server/routes/approvals.ts —— 审批（执行器级安全机制）
 *
 * 两条路径对称化（曾经的不对称是个真实的违和来源）：
 *   POST /api/approvals/:id  批准 / 拒绝
 *   GET  /api/approvals      挂起清单（含所属会话、"等了多久"、"何时自动作废"）
 * 主执行器的审批走会话 SSE，子代理/并行的审批走全局事件总线——两条都注册在同一块
 * 共享 ApprovalBoard 上，所以这里一份清单就能覆盖全部来源；前端首屏与刷新后据此
 * 把审批卡放回正确的聊天窗口，而不是"卡没了、服务端还在等，10 分钟后说你拒绝了它"。
 */
import type { Express } from 'express';
import { getChatService, getRunner, type RouteDeps } from './shared';

export function registerApprovalRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.get('/api/approvals', (req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json({ pending: [] });
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const now = Date.now();
    const pending = chat.listApprovals(sessionId).map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      args: a.args,
      sessionId: a.sessionId,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      // 前端直接可用的两个读数（等服务端算不如给现成的）
      waitedMs: Math.max(0, now - a.createdAt),
      expiresInMs: Math.max(0, a.expiresAt - now),
    }));
    res.json({ pending });
  });

  app.post('/api/approvals/:id', (req, res) => {
    const approved = req.body?.approved === true;
    // 审批走执行循环服务（service:runner）的共享审批板入口——与 chat 服务解耦：
    // 循环被别的插件接管时，审批语义（含子代理/并行的审批）仍由接管者负责兑现。
    const runner = getRunner(kernel);
    if (!runner) return res.status(500).json({ error: '执行循环服务未加载' });
    const ok = runner.approveApproval(req.params.id, approved);
    if (!ok) return res.status(404).json({ error: '这个请求已经过期了' });
    res.json({ ok: true, approved });
  });
}
