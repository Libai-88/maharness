/** 长任务到点续跑：只允许调度当前租户中已有 checkpoint 的会话。 */
import type { Express } from 'express';
import { tenantIdOf, type RouteDeps } from './shared';

export function registerScheduleRoutes(app: Express, deps: RouteDeps): void {
  const { store, scheduler } = deps;

  app.post('/api/sessions/:id/resume-at', (req, res) => {
    if (!scheduler) return res.status(503).json({ error: '调度器未启用' });
    const sessionId = String(req.params.id ?? '');
    const tenantId = tenantIdOf(req);
    if (!store.getSession(sessionId, tenantId)) return res.status(404).json({ error: '会话不存在' });
    const run = store.runs
      .list(tenantId, sessionId)
      .find((run) => run.id === req.body?.runId && !run.parentId && run.status === 'interrupted');
    if (!run) return res.status(409).json({ error: '请指定该会话中可恢复的 v2 任务' });
    const rawDue = req.body?.dueAt;
    const rawDelay = req.body?.delayMs;
    const now = Date.now();
    const dueAt = rawDue !== undefined ? Number(rawDue) : rawDelay !== undefined ? now + Number(rawDelay) : NaN;
    if (!Number.isFinite(dueAt) || dueAt <= 0 || dueAt > now + 30 * 24 * 3600_000) {
      return res.status(400).json({ error: 'dueAt 需为未来 30 天内的毫秒时间戳，或提供 delayMs' });
    }
    const job = scheduler.schedule({
      sessionId,
      tenantId,
      dueAt,
      runId: run.id,
      principalRole: (req as typeof req & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole,
    });
    res.json(job);
  });

  app.get('/api/schedules', (req, res) => {
    if (!scheduler) return res.json([]);
    res.json(scheduler.list(tenantIdOf(req)));
  });

  app.delete('/api/schedules/:id', (req, res) => {
    if (!scheduler) return res.status(503).json({ error: '调度器未启用' });
    const ok = scheduler.cancel(String(req.params.id ?? ''), tenantIdOf(req));
    if (!ok) return res.status(404).json({ error: '调度不存在、已完成或正在运行' });
    res.json({ ok: true });
  });
}
