import type { Express, Request } from 'express';
import { RunError, type RunService } from '../run-service';
import { tenantIdOf, type RouteDeps } from './shared';
import { streamRunEvents } from './runs';

/** Legacy transport uses the same durable runtime and authorization as /api/v2. */
export function registerChatRoutes(app: Express, deps: RouteDeps, service: RunService): void {
  app.get('/api/sessions/:id/checkpoint', (req, res) => {
    const session = deps.store.getSession(String(req.params.id), tenantIdOf(req));
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const cp = deps.store.loadCheckpoint(session.id);
    res.json({ exists: !!cp, legacy: true, resumable: false, schemaVersion: cp?.schemaVersion ?? null, turn: cp?.turn ?? 0, historyMessages: cp?.history.length ?? 0, objective: cp?.task?.objective, history: cp?.history, createdAt: cp?.createdAt ?? 0 });
  });
  app.post('/api/sessions/:id/chat', (req, res, next) => {
    try {
      const tenant = tenantIdOf(req);
      const session = deps.store.getSession(String(req.params.id), tenant);
      if (!session) throw new RunError(404, 'SESSION_NOT_FOUND', '会话不存在');
      const role = (req as Request & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole;
      const body = req.body ?? {};
      if (deps.sseLimiter && !deps.sseLimiter.tryAcquire(res)) { res.setHeader('Retry-After', '15'); throw new RunError(429, 'SSE_CAPACITY', '事件订阅数已达上限'); }
      res.on('close', () => deps.sseLimiter?.release(res));
      let run;
      if (body.resume) {
        const prior = deps.store.runs.list(tenant, session.id).find(run => !run.parentId && run.status === 'interrupted');
        if (!prior) throw new RunError(409, 'LEGACY_CHECKPOINT', '旧断点仅供查看；请确认已发生的操作后发起新任务');
        run = service.resume(prior.id, tenant, role);
      } else {
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1_000_000) throw new RunError(400, 'INVALID_MESSAGE', '消息不能为空或超出长度限制');
        if (/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body.message)) throw new RunError(400, 'INVALID_ENCODING', '消息包含无法识别的编码字符');
        if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim()) || body.provider !== undefined && (typeof body.provider !== 'string' || !body.provider.trim())) throw new RunError(400, 'INVALID_MODEL', '模型与供应商标识必须为有效文本');
        if (body.systemPrompt !== undefined) throw new RunError(400, 'UNSUPPORTED_OVERRIDE', '请通过用户规则配置提示词');
        run = service.create(session, { message: body.message, model: body.model, provider: body.provider, principalRole: role, requestKey: req.get('Idempotency-Key') });
      }
      streamRunEvents(req, res, run, deps, service);
    } catch (error) {
      deps.sseLimiter?.release(res);
      if (error instanceof RunError) res.status(error.status).json({ error: error.message, code: error.code });
      else next(error);
    }
  });
}
