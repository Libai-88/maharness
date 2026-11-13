import type { Express, Request, Response, NextFunction } from 'express';
import type { RunService } from '../run-service';
import { RunError } from '../run-service';
import { RUN_TERMINAL } from '../../kernel/run';
import type { RouteDeps } from './shared';
import { tenantIdOf } from './shared';
import { validateTaskContract, type TaskCriterion } from '../../kernel/task-verifier';
import { FrameworkChanges } from '../framework-changes';
import { approvalTokens } from './approvals';
import { getChatService } from './shared';

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000) throw new RunError(400, 'INVALID_INPUT', `${label}必须是有效文本`);
  return value;
}
function explicitNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RunError(400, 'INVALID_INPUT', `${label}必须是非负数`);
  return value;
}
export function registerRunRoutes(app: Express, deps: RouteDeps, service: RunService): void {
  const changes = new FrameworkChanges(deps.kernel.rootDir);
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    const fail = (error: unknown) => {
      if (error instanceof RunError) res.status(error.status).json({ error: error.message, code: error.code });
      else next(error);
    };
    try { Promise.resolve(fn(req, res)).catch(fail); } catch (error) { fail(error); }
  };
  const id = (req: Request) => String(req.params.id);
  app.get('/api/v2/workspace/permissions', wrap((req, res) => res.json(service.workspacePermission(tenantIdOf(req)))));
  app.put('/api/v2/workspace/permissions', wrap((req, res) => {
    const role = (req as Request & { apiRole?: string }).apiRole;
    if (role && role !== 'admin') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '修改权限档需要用户管理员授权');
    const { profile, revision } = req.body ?? {};
    if (!['standard', 'developer'].includes(profile) || !Number.isSafeInteger(revision) || revision < 0) throw new RunError(400, 'INVALID_PERMISSION', '权限档或版本无效');
    const permission = service.setWorkspacePermission(tenantIdOf(req), profile, revision);
    deps.store.appendAuthorizationAudit({ outcome: 'granted', subject: 'user-api', capability: 'workspace.permission', object: permission.workspace, reason: `${profile}:${permission.revision}` });
    res.json(permission);
  }));
  app.post('/api/v2/sessions/:id/runs', wrap(async (req, res) => {
    const session = deps.store.getSession(id(req), tenantIdOf(req));
    if (!session) throw new RunError(404, 'SESSION_NOT_FOUND', '会话不存在');
    const body = req.body ?? {};
    const frameworkChange = body.frameworkChangeId ? await changes.get(text(body.frameworkChangeId, '框架修改标识'), tenantIdOf(req)) : undefined;
    if (frameworkChange && changes.isBusy(frameworkChange.id)) throw new RunError(409, 'CHANGE_BUSY', '隔离副本正在检查或采纳');
    if (frameworkChange?.state === 'adopted') throw new RunError(409, 'CHANGE_ALREADY_ADOPTED', '该修改已采纳，请创建新的隔离副本');
    if (body.acceptance !== undefined && (!Array.isArray(body.acceptance) || body.acceptance.length > 100)) throw new RunError(400, 'INVALID_INPUT', '验收条件必须为数组');
    const acceptance = body.acceptance as TaskCriterion[] | undefined;
    if (acceptance) {
      const issues = validateTaskContract({ objective: text(body.message, '消息'), acceptance });
      if (issues.length) throw new RunError(400, 'INVALID_ACCEPTANCE', issues.join('；'));
    }
    const record = service.create(session, {
      message: text(body.message, '消息'), provider: body.provider === undefined ? undefined : text(body.provider, '供应商'),
      model: body.model === undefined ? undefined : text(body.model, '模型'),
      requestKey: req.get('Idempotency-Key'), budgetUsd: explicitNumber(body.budgetUsd, '费用上限'),
      deadlineAt: explicitNumber(body.deadlineAt, '截止时间'),
      acceptance,
      principalRole: (req as Request & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole,
      frameworkChange,
    });
    res.status(202).json({ runId: record.id, run: record });
  }));
  const requireDeveloper = (req: Request) => {
    const role = (req as Request & { apiRole?: string }).apiRole;
    if (role && role !== 'admin' || service.workspacePermission(tenantIdOf(req)).profile !== 'developer') throw new RunError(403, 'DEVELOPER_AUTHORIZATION_REQUIRED', '需要用户管理员开启工作区开发者权限');
  };
  const requireIdleChange = (req: Request) => {
    if (deps.store.runs.active(tenantIdOf(req)).some(run => run.authorization.frameworkChangeId === id(req))) throw new RunError(409, 'CHANGE_BUSY', '请先停止隔离副本中的活动任务');
  };
  app.get('/api/v2/framework/changes', wrap(async (req, res) => { requireDeveloper(req); res.json(await changes.list(tenantIdOf(req))); }));
  app.post('/api/v2/framework/changes', wrap(async (req, res) => { requireDeveloper(req); res.status(201).json(await changes.create(tenantIdOf(req))); }));
  app.post('/api/v2/framework/changes/:id/review', wrap(async (req, res) => { requireDeveloper(req); requireIdleChange(req); res.json(await changes.review(id(req), tenantIdOf(req))); }));
  app.post('/api/v2/framework/changes/:id/validate', wrap(async (req, res) => { requireDeveloper(req); requireIdleChange(req); res.json(await changes.validate(id(req), tenantIdOf(req))); }));
  app.post('/api/v2/framework/changes/:id/adopt', wrap(async (req, res) => {
    requireDeveloper(req);
    if (deps.store.runs.active(tenantIdOf(req)).length) throw new RunError(409, 'WORKSPACE_BUSY', '请先停止活动任务再采纳框架修改');
    res.json(await changes.adopt(id(req), tenantIdOf(req), text(req.body?.digest, '审阅版本')));
  }));
  app.get('/api/v2/runs', wrap((req, res) => res.json(deps.store.runs.list(tenantIdOf(req), typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined))));
  app.get('/api/v2/runs/:id', wrap((req, res) => res.json(service.get(id(req), tenantIdOf(req)))));
  app.get('/api/v2/runs/:id/children', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req)); res.json(deps.store.runs.children(run.id, run.tenantId));
  }));
  app.get('/api/v2/runs/:id/artifacts', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req)); res.json(deps.store.runs.artifacts(run.id));
  }));
  app.get('/api/v2/runs/:id/tools', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req)); res.json(deps.store.runs.toolCalls(run.id));
  }));
  app.get('/api/v2/runs/:id/inputs', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req));
    const before = req.query.before;
    if (before !== undefined && (typeof before !== 'string' || before.length > 100)) throw new RunError(400, 'INVALID_RANGE', '输入游标无效');
    res.json(deps.store.runs.modelInputs(run.id, 10, before));
  }));
  app.get('/api/v2/runs/:id/results/:callId', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req));
    const offset = Number(req.query.offset ?? 0); const limit = Number(req.query.limit ?? 4000);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new RunError(400, 'INVALID_RANGE', '结果读取范围无效');
    const page = deps.store.runs.readTool(run.id, String(req.params.callId), offset, limit);
    if (!page) throw new RunError(404, 'RESULT_NOT_FOUND', '工具结果不存在');
    res.json(page);
  }));
  app.post('/api/v2/runs/:id/messages', wrap((req, res) => res.status(202).json({ messageId: service.supplement(id(req), tenantIdOf(req), text(req.body?.message, '消息'), req.get('Idempotency-Key')) })));
  app.post('/api/v2/runs/:id/cancel', wrap((req, res) => res.json(service.cancel(id(req), tenantIdOf(req)))));
  app.post('/api/v2/runs/:id/resume', wrap((req, res) => {
    service.get(id(req), tenantIdOf(req));
    const eventCursor = deps.store.runs.eventCursor(id(req));
    const run = service.resume(id(req), tenantIdOf(req), (req as Request & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole);
    res.status(202).json({ ...run, eventCursor });
  }));
  app.get('/api/v2/runs/:id/events', wrap((req, res) => {
    const run = service.get(id(req), tenantIdOf(req));
    streamRunEvents(req, res, run, deps, service);
  }));
}


export function streamRunEvents(req: Request, res: Response, run: import('../../kernel/run').RunRecord, deps: RouteDeps, service: RunService): void {
    const rawCursor = req.get('Last-Event-ID') ?? req.query.after ?? '0';
    const cursor = Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RunError(400, 'INVALID_CURSOR', '事件游标无效');
    if (deps.sseLimiter && !deps.sseLimiter.tryAcquire(res)) { res.setHeader('Retry-After', '15'); throw new RunError(429, 'SSE_CAPACITY', '事件订阅数已达上限'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    let after = cursor;
    let disposed = false;
    const drain = () => {
      if (disposed || res.writableEnded || res.destroyed || res.writableNeedDrain) return;
      // Bounded batches and drain notifications keep slow readers from growing server memory.
      for (;;) {
        const batch = deps.store.runs.events(run.id, after, 100);
        for (const event of batch) {
          after = event.seq;
          const approval = event.type === 'approval_required' ? getChatService(deps.kernel)?.listApprovals().find(item => item.id === event.data.approvalId && item.sessionId === run.sessionId) : undefined;
          const data = event.type === 'approval_required'
            ? { ...event.data, active: !!approval, ...(approval ? { expiresAt: approval.expiresAt, approvalToken: approvalTokens.issue(approval.id, run.sessionId, approval.expiresAt) } : {}) }
            : event.data;
          if (!res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`)) return;
        }
        if (batch.length < 100) break;
      }
      const current = service.get(run.id, run.tenantId);
      if (RUN_TERMINAL.has(current.status)) res.end();
    };
    const unsubscribe = service.subscribe(run.id, drain);
    const heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': ping\n\n'); }, 15_000);
    res.on('drain', drain);
    res.on('close', () => { disposed = true; unsubscribe(); clearInterval(heartbeat); deps.sseLimiter?.release(res); });
    drain();
}
