import type { Express, NextFunction, Request, Response } from 'express';
import type { RunService } from '../run-service';
import { isOrganizationError } from '../services/organization/service';
import { OrganizationError } from '../organization-store';
import type { OrganizationPort, SocietyPort } from '../host/ports';
import { tenantIdOf, type RouteDeps } from './shared';
import { registerGovernanceRoutes } from './organization-governance';
import { registerSocietyRoutes } from './organization-society';

export function registerOrganizationRoutes(
  app: Express,
  deps: RouteDeps & { organization: OrganizationPort; society: SocietyPort },
  runs: RunService,
): void {
  const { organization } = deps;
  const wrap = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try {
      Promise.resolve(handler(req, res)).catch((error) => {
        if (isOrganizationError(error)) res.status(error.status).json({ code: error.code, error: error.message });
        else next(error);
      });
    } catch (error) {
      if (isOrganizationError(error)) res.status(error.status).json({ code: error.code, error: error.message });
      else next(error);
    }
  };
  const requireWrite = (req: Request) => {
    if ((req as Request & { apiRole?: string }).apiRole === 'readonly')
      throw new OrganizationError(403, 'USER_AUTHORIZATION_REQUIRED', '需要用户写权限');
  };

  app.post(
    '/api/work-orders',
    wrap((req, res) => {
      requireWrite(req);
      const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
      if (!runId) throw new OrganizationError(400, 'INVALID_RUN', '创建或登记工作单需要任务 ID');
      const run = runs.get(runId, tenantIdOf(req));
      if (run.parentId) throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '子任务不能单独创建工作单');
      res
        .status(201)
        .json({ workOrder: organization.createForRun(run, typeof req.body?.projectId === 'string' ? req.body.projectId : '') });
    }),
  );

  app.get(
    '/api/work-orders',
    wrap((req, res) => {
      const limit = Number(req.query.limit ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new OrganizationError(400, 'INVALID_LIMIT', '读取数量必须为 1 至 500');
      res.json({
        workOrders: deps.store.organization.listWorkOrders(
          tenantIdOf(req),
          typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
          limit,
        ),
      });
    }),
  );

  app.get(
    '/api/work-orders/:id',
    wrap((req, res) => {
      res.json(organization.detail(String(req.params.id), tenantIdOf(req)));
    }),
  );

  app.get(
    '/api/work-orders/:id/ledger',
    wrap((req, res) => {
      const tenantId = tenantIdOf(req);
      if (!deps.store.organization.getWorkOrder(String(req.params.id), tenantId))
        throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
      res.json({ ledger: deps.store.organization.ledger(String(req.params.id), tenantId) });
    }),
  );

  app.get(
    '/api/work-orders/:id/receipt',
    wrap((req, res) => {
      const tenantId = tenantIdOf(req);
      const receipt = deps.store.organization.receipt(String(req.params.id), tenantId);
      if (!receipt) throw new OrganizationError(404, 'RECEIPT_NOT_FOUND', '工作回执尚未生成');
      res.json({ receipt });
    }),
  );

  app.get(
    '/api/organization/roles',
    wrap((req, res) => {
      const tenantId = tenantIdOf(req);
      const roles = deps.store.organization.listRoles(
        tenantId,
        typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
        req.query.includePaused === 'true',
      );
      res.json({ roles });
    }),
  );

  app.patch(
    '/api/organization/roles/:id',
    wrap((req, res) => {
      requireWrite(req);
      const revision = Number(req.body?.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '角色版本无效');
      if (!req.body?.patch || typeof req.body.patch !== 'object' || Array.isArray(req.body.patch))
        throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '需要角色变更内容');
      res.json({
        role: organization.updateRole(String(req.params.id), tenantIdOf(req), revision, req.body.patch, String(req.body?.reason ?? '')),
      });
    }),
  );

  app.post(
    '/api/organization/roles/:id/confirm',
    wrap((req, res) => {
      requireWrite(req);
      res.json({ role: organization.confirmPersistentRole(String(req.params.id), tenantIdOf(req)) });
    }),
  );

  app.get(
    '/api/organization/roles/:id/versions',
    wrap((req, res) => {
      const history = organization.roleHistory(String(req.params.id), tenantIdOf(req));
      res.json({ versions: history.versions });
    }),
  );

  app.get(
    '/api/organization/roles/:id/audits',
    wrap((req, res) => {
      const history = organization.roleHistory(String(req.params.id), tenantIdOf(req));
      res.json({ audits: history.audits });
    }),
  );

  app.post(
    '/api/organization/roles/:id/rollback',
    wrap((req, res) => {
      requireWrite(req);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new OrganizationError(400, 'ROLE_VERSION_INVALID', '角色回滚版本无效');
      res.json({
        role: organization.rollbackRole(String(req.params.id), tenantIdOf(req), version, String(req.body?.reason ?? '')),
      });
    }),
  );

  app.get(
    '/api/organization/evaluations',
    wrap((req, res) => {
      res.json(organization.evaluationHistory(tenantIdOf(req)));
    }),
  );

  app.post(
    '/api/organization/evaluations',
    wrap((req, res) => {
      requireWrite(req);
      if (!req.body?.policy || typeof req.body.policy !== 'object' || Array.isArray(req.body.policy))
        throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '需要评价标准内容');
      res.status(201).json({
        evaluation: organization.updateEvaluation(tenantIdOf(req), req.body.policy, String(req.body?.reason ?? '')),
      });
    }),
  );

  app.post(
    '/api/organization/evaluations/rollback',
    wrap((req, res) => {
      requireWrite(req);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1)
        throw new OrganizationError(400, 'EVALUATION_VERSION_INVALID', '评价标准回滚版本无效');
      res.json({
        evaluation: organization.rollbackEvaluation(tenantIdOf(req), version, String(req.body?.reason ?? '')),
      });
    }),
  );

  app.get(
    '/api/organization/scorecards',
    wrap((req, res) => {
      res.json({ scorecards: organization.scorecards(tenantIdOf(req)) });
    }),
  );

  app.get(
    '/api/organization/wellbeing',
    wrap((req, res) => {
      res.json({
        wellbeing: organization.wellbeing(tenantIdOf(req), typeof req.query.projectId === 'string' ? req.query.projectId : undefined),
      });
    }),
  );

  registerSocietyRoutes(app, deps, { wrap, requireWrite });
  registerGovernanceRoutes(app, deps, runs, { wrap, requireWrite });
}
