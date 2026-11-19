import type { Express, NextFunction, Request, Response } from 'express';
import type { RunService } from '../run-service';
import { isOrganizationError, OrganizationService } from '../organization';
import { OrganizationError } from '../organization-store';
import type { ExceptionStatus, ProposalStatus } from '../organization-store';
import type { SocietyService } from '../society';
import { tenantIdOf, type RouteDeps } from './shared';

export function registerOrganizationRoutes(
  app: Express,
  deps: RouteDeps & { organization: OrganizationService; society: SocietyService },
  runs: RunService,
): void {
  const { organization, society } = deps;
  const wrap = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try {
      Promise.resolve(handler(req, res)).catch(error => {
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

  app.post('/api/work-orders', wrap((req, res) => {
    requireWrite(req);
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    if (!runId) throw new OrganizationError(400, 'INVALID_RUN', '创建或登记工作单需要任务 ID');
    const run = runs.get(runId, tenantIdOf(req));
    if (run.parentId) throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '子任务不能单独创建工作单');
    res.status(201).json({ workOrder: organization.createForRun(run, typeof req.body?.projectId === 'string' ? req.body.projectId : '') });
  }));

  app.get('/api/work-orders', wrap((req, res) => {
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
  }));

  app.get('/api/work-orders/:id', wrap((req, res) => {
    res.json(organization.detail(String(req.params.id), tenantIdOf(req)));
  }));

  app.get('/api/work-orders/:id/ledger', wrap((req, res) => {
    const tenantId = tenantIdOf(req);
    if (!deps.store.organization.getWorkOrder(String(req.params.id), tenantId))
      throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
    res.json({ ledger: deps.store.organization.ledger(String(req.params.id), tenantId) });
  }));

  app.get('/api/work-orders/:id/receipt', wrap((req, res) => {
    const tenantId = tenantIdOf(req);
    const receipt = deps.store.organization.receipt(String(req.params.id), tenantId);
    if (!receipt) throw new OrganizationError(404, 'RECEIPT_NOT_FOUND', '工作回执尚未生成');
    res.json({ receipt });
  }));

  app.get('/api/organization/roles', wrap((req, res) => {
    const tenantId = tenantIdOf(req);
    const roles = deps.store.organization.listRoles(
      tenantId,
      typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
      req.query.includePaused === 'true',
    );
    res.json({ roles });
  }));

  app.patch('/api/organization/roles/:id', wrap((req, res) => {
    requireWrite(req);
    const revision = Number(req.body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '角色版本无效');
    if (!req.body?.patch || typeof req.body.patch !== 'object' || Array.isArray(req.body.patch))
      throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '需要角色变更内容');
    res.json({
      role: organization.updateRole(
        String(req.params.id),
        tenantIdOf(req),
        revision,
        req.body.patch,
        String(req.body?.reason ?? ''),
      ),
    });
  }));

  app.post('/api/organization/roles/:id/confirm', wrap((req, res) => {
    requireWrite(req);
    res.json({ role: organization.confirmPersistentRole(String(req.params.id), tenantIdOf(req)) });
  }));

  app.get('/api/organization/roles/:id/versions', wrap((req, res) => {
    const history = organization.roleHistory(String(req.params.id), tenantIdOf(req));
    res.json({ versions: history.versions });
  }));

  app.get('/api/organization/roles/:id/audits', wrap((req, res) => {
    const history = organization.roleHistory(String(req.params.id), tenantIdOf(req));
    res.json({ audits: history.audits });
  }));

  app.post('/api/organization/roles/:id/rollback', wrap((req, res) => {
    requireWrite(req);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new OrganizationError(400, 'ROLE_VERSION_INVALID', '角色回滚版本无效');
    res.json({
      role: organization.rollbackRole(
        String(req.params.id),
        tenantIdOf(req),
        version,
        String(req.body?.reason ?? ''),
      ),
    });
  }));

  app.get('/api/organization/evaluations', wrap((req, res) => {
    res.json(organization.evaluationHistory(tenantIdOf(req)));
  }));

  app.post('/api/organization/evaluations', wrap((req, res) => {
    requireWrite(req);
    if (!req.body?.policy || typeof req.body.policy !== 'object' || Array.isArray(req.body.policy))
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '需要评价标准内容');
    res.status(201).json({
      evaluation: organization.updateEvaluation(
        tenantIdOf(req),
        req.body.policy,
        String(req.body?.reason ?? ''),
      ),
    });
  }));

  app.post('/api/organization/evaluations/rollback', wrap((req, res) => {
    requireWrite(req);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new OrganizationError(400, 'EVALUATION_VERSION_INVALID', '评价标准回滚版本无效');
    res.json({
      evaluation: organization.rollbackEvaluation(
        tenantIdOf(req),
        version,
        String(req.body?.reason ?? ''),
      ),
    });
  }));

  app.get('/api/organization/scorecards', wrap((req, res) => {
    res.json({ scorecards: organization.scorecards(tenantIdOf(req)) });
  }));

  app.get('/api/organization/wellbeing', wrap((req, res) => {
    res.json({ wellbeing: organization.wellbeing(tenantIdOf(req), typeof req.query.projectId === 'string' ? req.query.projectId : undefined) });
  }));

  app.get('/api/organization/society', wrap((req, res) => {
    res.json(society.snapshot(
      tenantIdOf(req),
      typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
    ));
  }));

  app.post('/api/organization/society/tasks', wrap((req, res) => {
    requireWrite(req);
    res.status(201).json({
      task: society.createTask({
        tenantId: tenantIdOf(req),
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : '',
        objective: String(req.body?.objective ?? ''),
        acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : [],
        materials: Array.isArray(req.body?.materials) ? req.body.materials : [],
        valueUsd: Number(req.body?.valueUsd),
        maxBudgetUsd: Number(req.body?.maxBudgetUsd),
        maxBudgetTokens: req.body?.maxBudgetTokens === undefined ? undefined : Number(req.body.maxBudgetTokens),
        priority: req.body?.priority,
        departmentId: typeof req.body?.departmentId === 'string' ? req.body.departmentId : undefined,
        requiredCapabilities: Array.isArray(req.body?.requiredCapabilities)
          ? req.body.requiredCapabilities.filter((item: unknown): item is string => typeof item === 'string')
          : undefined,
        needsWrite: typeof req.body?.needsWrite === 'boolean' ? req.body.needsWrite : undefined,
        branches: Array.isArray(req.body?.branches) ? req.body.branches : undefined,
        economics: typeof req.body?.economics === 'object'
          && req.body.economics !== null
          && !Array.isArray(req.body.economics)
          ? req.body.economics
          : undefined,
      }),
    });
  }));

  app.post('/api/organization/society/tick', wrap((req, res) => {
    requireWrite(req);
    res.json(society.tick(
      tenantIdOf(req),
      typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
    ));
  }));

  app.post('/api/organization/society/tasks/:id/approve', wrap((req, res) => {
    requireWrite(req);
    if (typeof req.body?.approved !== 'boolean')
      throw new OrganizationError(400, 'INVALID_DECISION', '需要明确的批准结果');
    res.json({ task: society.approveTask(String(req.params.id), tenantIdOf(req), req.body.approved) });
  }));

  app.post('/api/organization/society/tasks/:id/release', wrap((req, res) => {
    requireWrite(req);
    const outcome = req.body?.outcome;
    if (outcome !== 'completed' && outcome !== 'failed')
      throw new OrganizationError(400, 'INVALID_SOCIETY_OUTCOME', '释放结果必须为 completed 或 failed');
    res.json(society.releaseTask(
      String(req.params.id), tenantIdOf(req), outcome, String(req.body?.summary ?? ''),
    ));
  }));

  app.get('/api/organization/society/experiments/:taskId', wrap((req, res) => {
    res.json(society.experiment(String(req.params.taskId), tenantIdOf(req)));
  }));

  app.get('/api/organization/roles/:id/life', wrap((req, res) => {
    res.json({ life: society.roleLife(tenantIdOf(req), String(req.params.id)) });
  }));

  app.post('/api/organization/institution', wrap((req, res) => {
    requireWrite(req);
    res.status(201).json({
      institution: society.updateInstitution(tenantIdOf(req), {
        ...(typeof req.body?.policies === 'object' && req.body.policies ? req.body.policies : {}),
        reason: String(req.body?.reason ?? ''),
      }),
    });
  }));

  app.post('/api/organization/institution/rollback', wrap((req, res) => {
    requireWrite(req);
    const version = Number(req.body?.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new OrganizationError(400, 'INSTITUTION_VERSION_INVALID', '回滚版本无效');
    res.json({ institution: society.rollbackInstitution(tenantIdOf(req), version, String(req.body?.reason ?? '')) });
  }));

  app.get('/api/organization/exceptions', wrap((req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : '';
    if (raw && !['open', 'auto_resolved', 'waiting_human', 'resolved', 'dismissed'].includes(raw))
      throw new OrganizationError(400, 'INVALID_EXCEPTION_STATUS', '异常状态无效');
    res.json({ exceptions: deps.store.organization.exceptions(tenantIdOf(req), raw as ExceptionStatus | undefined) });
  }));

  app.post('/api/organization/exceptions', wrap((req, res) => {
    requireWrite(req);
    res.status(201).json({
      exception: organization.raiseException({
        tenantId: tenantIdOf(req),
        workOrderId: String(req.body?.workOrderId ?? ''),
        contractId: typeof req.body?.contractId === 'string' ? req.body.contractId : undefined,
        kind: req.body?.kind,
        summary: String(req.body?.summary ?? ''),
        facts: Array.isArray(req.body?.facts) ? req.body.facts : [],
        evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
        createdBy: 'maharness',
      }),
    });
  }));

  app.post('/api/organization/exceptions/:id/resolve', wrap((req, res) => {
    requireWrite(req);
    if (typeof req.body?.decision !== 'string' || !req.body.decision.trim())
      throw new OrganizationError(400, 'INVALID_DECISION', '人工决定不能为空');
    res.json({ exception: organization.resolveException(String(req.params.id), tenantIdOf(req), req.body.decision) });
  }));

  app.post('/api/organization/teams/:id/:action', wrap((req, res) => {
    requireWrite(req);
    const action = String(req.params.action);
    if (!['pause', 'resume', 'dissolve'].includes(action))
      throw new OrganizationError(400, 'INVALID_TEAM_ACTION', '团队操作无效');
    const tenantId = tenantIdOf(req);
    const result = organization.setTeamState(String(req.params.id), tenantId, action as 'pause' | 'resume' | 'dissolve');
    if (action === 'dissolve') {
      for (const runId of result.runIds) {
        const run = deps.store.runs.get(runId, tenantId);
        if (run && ['queued', 'running', 'waiting_approval'].includes(run.status)) runs.cancel(runId, tenantId);
      }
    }
    res.json(result);
  }));

  app.post('/api/organization/teams/:id/contracts/:contractId/reassign', wrap((req, res) => {
    requireWrite(req);
    const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
    if (!roleId) throw new OrganizationError(400, 'ROLE_NOT_FOUND', '需要目标角色');
    res.json({ contract: organization.reassign(String(req.params.id), tenantIdOf(req), String(req.params.contractId), roleId) });
  }));

  app.get('/api/organization/proposals', wrap((req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : '';
    if (raw && !['pending', 'accepted', 'rejected'].includes(raw))
      throw new OrganizationError(400, 'INVALID_PROPOSAL_STATUS', '提案状态无效');
    res.json({ proposals: deps.store.organization.proposals(tenantIdOf(req), raw as ProposalStatus | undefined) });
  }));

  app.post('/api/organization/proposals', wrap((req, res) => {
    requireWrite(req);
    res.status(201).json({
      proposal: organization.createProposal({
        tenantId: tenantIdOf(req),
        workOrderId: String(req.body?.workOrderId ?? ''),
        category: req.body?.category,
        title: String(req.body?.title ?? ''),
        detail: String(req.body?.detail ?? ''),
        evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
        impact: req.body?.impact,
      }),
    });
  }));

  app.post('/api/organization/proposals/:id/decide', wrap((req, res) => {
    requireWrite(req);
    if (typeof req.body?.accepted !== 'boolean' || typeof req.body?.decision !== 'string')
      throw new OrganizationError(400, 'INVALID_DECISION', '需要人工采纳结论');
    res.json({
      proposal: organization.decideProposal(String(req.params.id), tenantIdOf(req), req.body.accepted, req.body.decision),
    });
  }));
}
