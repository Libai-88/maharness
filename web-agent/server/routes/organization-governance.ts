import type { Express, NextFunction, Request, Response } from 'express';
import { OrganizationError } from '../organization-store';
import type { ExceptionStatus, ProposalStatus } from '../organization-store';
import type { RunService } from '../run-service';
import type { OrganizationPort, SocietyPort } from '../host/ports';
import { tenantIdOf, type RouteDeps } from './shared';

type Wrap = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => void;
type Ctx = { wrap: Wrap; requireWrite: (req: Request) => void };
type Deps = RouteDeps & { organization: OrganizationPort; society: SocietyPort };

/** 制度制定与回滚 */
function registerInstitution(app: Express, deps: Deps, { wrap, requireWrite }: Ctx): void {
  app.post(
    '/api/organization/institution',
    wrap((req, res) => {
      requireWrite(req);
      res.status(201).json({
        institution: deps.society.updateInstitution(tenantIdOf(req), {
          ...(typeof req.body?.policies === 'object' && req.body.policies ? req.body.policies : {}),
          reason: String(req.body?.reason ?? ''),
        }),
      });
    }),
  );
  app.post(
    '/api/organization/institution/rollback',
    wrap((req, res) => {
      requireWrite(req);
      const version = Number(req.body?.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new OrganizationError(400, 'INSTITUTION_VERSION_INVALID', '回滚版本无效');
      res.json({ institution: deps.society.rollbackInstitution(tenantIdOf(req), version, String(req.body?.reason ?? '')) });
    }),
  );
}

/** 异常登记与人工裁决 */
function registerExceptions(app: Express, deps: Deps, { wrap, requireWrite }: Ctx): void {
  app.get(
    '/api/organization/exceptions',
    wrap((req, res) => {
      const raw = typeof req.query.status === 'string' ? req.query.status : '';
      if (raw && !['open', 'auto_resolved', 'waiting_human', 'resolved', 'dismissed'].includes(raw))
        throw new OrganizationError(400, 'INVALID_EXCEPTION_STATUS', '异常状态无效');
      res.json({ exceptions: deps.store.organization.exceptions(tenantIdOf(req), raw as ExceptionStatus | undefined) });
    }),
  );
  app.post(
    '/api/organization/exceptions',
    wrap((req, res) => {
      requireWrite(req);
      res.status(201).json({
        exception: deps.organization.raiseException({
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
    }),
  );
  app.post(
    '/api/organization/exceptions/:id/resolve',
    wrap((req, res) => {
      requireWrite(req);
      if (typeof req.body?.decision !== 'string' || !req.body.decision.trim())
        throw new OrganizationError(400, 'INVALID_DECISION', '人工决定不能为空');
      res.json({ exception: deps.organization.resolveException(String(req.params.id), tenantIdOf(req), req.body.decision) });
    }),
  );
}

/** 团队状态与合同改派（解散时同时取消活动 Run） */
function registerTeams(app: Express, deps: Deps, runs: RunService, { wrap, requireWrite }: Ctx): void {
  app.post(
    '/api/organization/teams/:id/:action',
    wrap((req, res) => {
      requireWrite(req);
      const action = String(req.params.action);
      if (!['pause', 'resume', 'dissolve'].includes(action)) throw new OrganizationError(400, 'INVALID_TEAM_ACTION', '团队操作无效');
      const tenantId = tenantIdOf(req);
      const result = deps.organization.setTeamState(String(req.params.id), tenantId, action as 'pause' | 'resume' | 'dissolve');
      if (action === 'dissolve') {
        for (const runId of result.runIds) {
          const run = deps.store.runs.get(runId, tenantId);
          if (run && ['queued', 'running', 'waiting_approval'].includes(run.status)) runs.cancel(runId, tenantId);
        }
      }
      res.json(result);
    }),
  );
  app.post(
    '/api/organization/teams/:id/contracts/:contractId/reassign',
    wrap((req, res) => {
      requireWrite(req);
      const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
      if (!roleId) throw new OrganizationError(400, 'ROLE_NOT_FOUND', '需要目标角色');
      res.json({ contract: deps.organization.reassign(String(req.params.id), tenantIdOf(req), String(req.params.contractId), roleId) });
    }),
  );
}

/** 提案：查询、提交与人工采纳 */
function registerProposals(app: Express, deps: Deps, { wrap, requireWrite }: Ctx): void {
  app.get(
    '/api/organization/proposals',
    wrap((req, res) => {
      const raw = typeof req.query.status === 'string' ? req.query.status : '';
      if (raw && !['pending', 'accepted', 'rejected'].includes(raw))
        throw new OrganizationError(400, 'INVALID_PROPOSAL_STATUS', '提案状态无效');
      res.json({ proposals: deps.store.organization.proposals(tenantIdOf(req), raw as ProposalStatus | undefined) });
    }),
  );
  app.post(
    '/api/organization/proposals',
    wrap((req, res) => {
      requireWrite(req);
      res.status(201).json({
        proposal: deps.organization.createProposal({
          tenantId: tenantIdOf(req),
          workOrderId: String(req.body?.workOrderId ?? ''),
          category: req.body?.category,
          title: String(req.body?.title ?? ''),
          detail: String(req.body?.detail ?? ''),
          evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
          impact: req.body?.impact,
        }),
      });
    }),
  );
  app.post(
    '/api/organization/proposals/:id/decide',
    wrap((req, res) => {
      requireWrite(req);
      if (typeof req.body?.accepted !== 'boolean' || typeof req.body?.decision !== 'string')
        throw new OrganizationError(400, 'INVALID_DECISION', '需要人工采纳结论');
      res.json({
        proposal: deps.organization.decideProposal(String(req.params.id), tenantIdOf(req), req.body.accepted, req.body.decision),
      });
    }),
  );
}

export function registerGovernanceRoutes(app: Express, deps: Deps, runs: RunService, helpers: Ctx): void {
  registerInstitution(app, deps, helpers);
  registerExceptions(app, deps, helpers);
  registerTeams(app, deps, runs, helpers);
  registerProposals(app, deps, helpers);
}
