/**
 * server/routes/approvals.ts —— 审批（执行器级安全机制）
 */
import type { Express } from 'express';
import { getChatService, type RouteDeps } from './shared';

export function registerApprovalRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.post('/api/approvals/:id', (req, res) => {
    const approved = req.body?.approved === true;
    const chat = getChatService(kernel);
    if (!chat) return res.status(500).json({ error: '对话服务未加载' });
    const ok = chat.approveApproval(req.params.id, approved);
    if (!ok) return res.status(404).json({ error: '审批不存在或已过期' });
    res.json({ ok: true, approved });
  });
}
