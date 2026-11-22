import type { Express, NextFunction, Request, Response } from 'express';
import { OrganizationError } from '../organization-store';
import type { SocietyPort } from '../host/ports';
import { tenantIdOf, type RouteDeps } from './shared';

type Wrap = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => void;
type Ctx = { wrap: Wrap; requireWrite: (req: Request) => void };

function projectOf(body: unknown): string {
  const value = (body as { projectId?: unknown } | undefined)?.projectId;
  return typeof value === 'string' ? value : '';
}

/** 社会看板：快照、调度 tick、实验与角色生平 */
function registerSocietyBoard(app: Express, society: SocietyPort, { wrap, requireWrite }: Ctx): void {
  app.get(
    '/api/organization/society',
    wrap((req, res) => {
      res.json(society.snapshot(tenantIdOf(req), typeof req.query.projectId === 'string' ? req.query.projectId : undefined));
    }),
  );
  app.post(
    '/api/organization/society/tick',
    wrap((req, res) => {
      requireWrite(req);
      res.json(society.tick(tenantIdOf(req), projectOf(req.body)));
    }),
  );
  app.get(
    '/api/organization/society/experiments/:taskId',
    wrap((req, res) => {
      res.json(society.experiment(String(req.params.taskId), tenantIdOf(req)));
    }),
  );
  app.get(
    '/api/organization/roles/:id/life',
    wrap((req, res) => {
      res.json({ life: society.roleLife(tenantIdOf(req), String(req.params.id)) });
    }),
  );
}

/** 能力与写入需求必须显式声明（不从任务文本猜） */
function requireExplicitCapabilities(body: { requiredCapabilities?: unknown; needsWrite?: unknown; teamMode?: unknown }): {
  capabilities: string[];
  teamMode?: 'auto' | 'solo' | 'team';
} {
  const capabilities = Array.isArray(body.requiredCapabilities)
    ? body.requiredCapabilities.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (!capabilities.length)
    throw new OrganizationError(400, 'TASK_CAPABILITIES_REQUIRED', '创建社会任务需要显式声明 requiredCapabilities（1–20 个能力）');
  if (typeof body.needsWrite !== 'boolean')
    throw new OrganizationError(400, 'TASK_CAPABILITIES_REQUIRED', '创建社会任务需要显式声明 needsWrite（是否需要写入产物）');
  if (body.teamMode !== undefined && !['auto', 'solo', 'team'].includes(String(body.teamMode)))
    throw new OrganizationError(400, 'TASK_CAPABILITIES_REQUIRED', 'teamMode 只能是 auto、solo 或 team');
  return { capabilities, teamMode: body.teamMode as 'auto' | 'solo' | 'team' | undefined };
}

/** 创建社会任务 */
function registerSocietyTaskCreate(app: Express, society: SocietyPort, { wrap, requireWrite }: Ctx): void {
  app.post(
    '/api/organization/society/tasks',
    wrap((req, res) => {
      requireWrite(req);
      const { capabilities, teamMode } = requireExplicitCapabilities(req.body ?? {});
      res.status(201).json({
        task: society.createTask({
          tenantId: tenantIdOf(req),
          projectId: projectOf(req.body),
          objective: String(req.body?.objective ?? ''),
          acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : [],
          materials: Array.isArray(req.body?.materials) ? req.body.materials : [],
          valueUsd: Number(req.body?.valueUsd),
          maxBudgetUsd: Number(req.body?.maxBudgetUsd),
          maxBudgetTokens: req.body?.maxBudgetTokens === undefined ? undefined : Number(req.body.maxBudgetTokens),
          priority: req.body?.priority,
          departmentId: typeof req.body?.departmentId === 'string' ? req.body.departmentId : undefined,
          requiredCapabilities: capabilities,
          needsWrite: req.body.needsWrite,
          ...(teamMode === undefined ? {} : { teamMode: teamMode as 'auto' | 'solo' | 'team' }),
          branches: Array.isArray(req.body?.branches) ? req.body.branches : undefined,
          economics:
            typeof req.body?.economics === 'object' && req.body.economics !== null && !Array.isArray(req.body.economics)
              ? req.body.economics
              : undefined,
        }),
      });
    }),
  );
}

/** 人工批准与释放 */
function registerSocietyDecisions(app: Express, society: SocietyPort, { wrap, requireWrite }: Ctx): void {
  app.post(
    '/api/organization/society/tasks/:id/approve',
    wrap((req, res) => {
      requireWrite(req);
      if (typeof req.body?.approved !== 'boolean') throw new OrganizationError(400, 'INVALID_DECISION', '需要明确的批准结果');
      res.json({ task: society.approveTask(String(req.params.id), tenantIdOf(req), req.body.approved) });
    }),
  );
  app.post(
    '/api/organization/society/tasks/:id/release',
    wrap((req, res) => {
      requireWrite(req);
      const outcome = req.body?.outcome;
      if (outcome !== 'completed' && outcome !== 'failed')
        throw new OrganizationError(400, 'INVALID_SOCIETY_OUTCOME', '释放结果必须为 completed 或 failed');
      res.json(society.releaseTask(String(req.params.id), tenantIdOf(req), outcome, String(req.body?.summary ?? '')));
    }),
  );
}

export function registerSocietyRoutes(app: Express, deps: RouteDeps & { society: SocietyPort }, helpers: Ctx): void {
  const { society } = deps;
  registerSocietyBoard(app, society, helpers);
  registerSocietyTaskCreate(app, society, helpers);
  registerSocietyDecisions(app, society, helpers);
}
