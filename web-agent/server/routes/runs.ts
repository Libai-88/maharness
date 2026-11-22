import type { Express, Request, Response, NextFunction } from 'express';
import type { RunService } from '../run-service';
import { RunError } from '../run-service';
import { MaterialError } from '../materials';
import type { RouteDeps } from './shared';
import { FrameworkChanges } from '../framework-changes';
import { registerWorkspaceRoutes } from './run-workspace';
import { streamRunEvents } from './run-events';
export { streamRunEvents };
import { RUN_TERMINAL } from '../../kernel/run';
import { tenantIdOf } from './shared';
import { validateTaskContract, type TaskCriterion } from '../../kernel/task-verifier';

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000)
    throw new RunError(400, 'INVALID_INPUT', `${label}必须是有效文本`);
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
      if (error instanceof RunError || error instanceof MaterialError)
        res.status(error.status).json({ error: error.message, code: error.code });
      else next(error);
    };
    try {
      Promise.resolve(fn(req, res)).catch(fail);
    } catch (error) {
      fail(error);
    }
  };
  const id = (req: Request) => String(req.params.id);
  registerWorkspaceRoutes(app, deps, service, { wrap, id, changes });
  app.get(
    '/api/v2/workspace/permissions',
    wrap((req, res) =>
      res.json({
        ...service.workspacePermission(tenantIdOf(req)),
        allowedPluginDependencies: deps.kernel.config?.get<string[]>('plugins.allowedDependencies', []) ?? [],
      }),
    ),
  );
  app.post(
    '/api/v2/sessions/:id/runs',
    wrap(async (req, res) => {
      const session = deps.store.getSession(id(req), tenantIdOf(req));
      if (!session) throw new RunError(404, 'SESSION_NOT_FOUND', '会话不存在');
      const body = req.body ?? {};
      const frameworkChange = body.frameworkChangeId
        ? await changes.get(text(body.frameworkChangeId, '框架修改标识'), tenantIdOf(req))
        : undefined;
      if (frameworkChange && changes.isBusy(frameworkChange.id)) throw new RunError(409, 'CHANGE_BUSY', '隔离副本正在检查或采纳');
      if (frameworkChange?.state === 'adopted') throw new RunError(409, 'CHANGE_ALREADY_ADOPTED', '该修改已采纳，请创建新的隔离副本');
      if (body.acceptance !== undefined && (!Array.isArray(body.acceptance) || body.acceptance.length > 100))
        throw new RunError(400, 'INVALID_INPUT', '验收条件必须为数组');
      const acceptance = body.acceptance as TaskCriterion[] | undefined;
      if (acceptance) {
        const issues = validateTaskContract({ objective: text(body.message, '消息'), acceptance });
        if (issues.length) throw new RunError(400, 'INVALID_ACCEPTANCE', issues.join('；'));
      }
      if (body.budgetPolicy !== undefined && !['advisory', 'enforce'].includes(body.budgetPolicy))
        throw new RunError(400, 'INVALID_INPUT', '费用策略无效');
      const record = service.create(session, {
        message: text(body.message, '消息'),
        provider: body.provider === undefined ? undefined : text(body.provider, '供应商'),
        materials: body.materials,
        reworkOfRunId: body.reworkOfRunId === undefined ? undefined : text(body.reworkOfRunId, '原任务'),
        model: body.model === undefined ? undefined : text(body.model, '模型'),
        budgetPolicy: body.budgetPolicy,
        requestKey: req.get('Idempotency-Key'),
        budgetUsd: explicitNumber(body.budgetUsd, '费用上限'),
        budgetTokens: body.budgetTokens === undefined ? undefined : Math.trunc(explicitNumber(body.budgetTokens, 'token 上限')!),
        deadlineAt: explicitNumber(body.deadlineAt, '截止时间'),
        acceptance,
        principalRole: (req as Request & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole,
        frameworkChange,
        projectId: body.projectId === undefined ? undefined : text(body.projectId, '项目'),
      });
      res.status(202).json({ runId: record.id, run: record });
    }),
  );
  app.get(
    '/api/v2/runs',
    wrap((req, res) => {
      const runs = deps.store.runs.list(tenantIdOf(req), typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined);
      if (req.query.summary !== '1') {
        res.json(runs);
        return;
      }
      res.json(
        runs.map(({ id, sessionId, parentId, objective, status, origin, workOrderId, updatedAt }) => ({
          id,
          sessionId,
          parentId,
          objective,
          status,
          origin,
          workOrderId,
          updatedAt,
        })),
      );
    }),
  );
  app.get(
    '/api/v2/runs/:id',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      res.json({ ...run, supplements: deps.store.runs.supplementStatus(run.id), eventCursor: deps.store.runs.eventCursor(run.id) });
    }),
  );
  app.get(
    '/api/v2/runs/:id/model-calls',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      const offset = Number(req.query.offset ?? 0),
        limit = Number(req.query.limit ?? 100);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RunError(400, 'INVALID_RANGE', '调用读取范围无效');
      res.json(deps.store.runs.modelCalls(run.id, offset, limit));
    }),
  );
  app.post(
    '/api/v2/runs/:id/billing/acknowledge',
    wrap((req, res) => {
      const role = (req as Request & { apiRole?: string }).apiRole;
      if (role === 'readonly') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '需要用户写权限');
      const run = service.get(id(req), tenantIdOf(req));
      if (!RUN_TERMINAL.has(run.status)) throw new RunError(409, 'RUN_ACTIVE', '任务结束后可确认费用');
      res.json(deps.store.runs.acknowledgeBilling(run));
    }),
  );
  app.get(
    '/api/v2/runs/:id/children',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      res.json(deps.store.runs.children(run.id, run.tenantId));
    }),
  );
  app.get(
    '/api/v2/runs/:id/artifacts',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      res.json(deps.store.runs.artifacts(run.id));
    }),
  );
  app.get(
    '/api/v2/runs/:id/tools',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      res.json(deps.store.runs.toolCalls(run.id));
    }),
  );
  app.get(
    '/api/v2/runs/:id/inputs',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      const before = req.query.before;
      if (before !== undefined && (typeof before !== 'string' || before.length > 100))
        throw new RunError(400, 'INVALID_RANGE', '输入游标无效');
      res.json(deps.store.runs.modelInputs(run.id, 10, before));
    }),
  );
  app.get(
    '/api/v2/runs/:id/results/:callId',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      const offset = Number(req.query.offset ?? 0);
      const limit = Number(req.query.limit ?? 4000);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000)
        throw new RunError(400, 'INVALID_RANGE', '结果读取范围无效');
      const page = deps.store.runs.readTool(run.id, String(req.params.callId), offset, limit);
      if (!page) throw new RunError(404, 'RESULT_NOT_FOUND', '工具结果不存在');
      res.json(page);
    }),
  );
  app.post(
    '/api/v2/runs/:id/messages',
    wrap((req, res) =>
      res
        .status(202)
        .json({ messageId: service.supplement(id(req), tenantIdOf(req), text(req.body?.message, '消息'), req.get('Idempotency-Key')) }),
    ),
  );
  app.post(
    '/api/v2/runs/:id/cancel',
    wrap((req, res) => res.json(service.cancel(id(req), tenantIdOf(req), req.body?.resumable === true))),
  );
  app.post(
    '/api/v2/runs/:id/resume',
    wrap((req, res) => {
      service.get(id(req), tenantIdOf(req));
      const eventCursor = deps.store.runs.eventCursor(id(req));
      const run = service.resume(id(req), tenantIdOf(req), (req as Request & { apiRole?: 'admin' | 'member' | 'readonly' }).apiRole);
      res.status(202).json({ ...run, eventCursor });
    }),
  );
  app.get(
    '/api/v2/runs/:id/events',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      streamRunEvents(req, res, run, deps, service);
    }),
  );
}
