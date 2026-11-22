import type { Express, Request, NextFunction, Response } from 'express';
import type { RunService } from '../run-service';
import { RunError } from '../run-service';
import type { FrameworkChanges } from '../framework-changes';
import { taskPluginService } from '../../kernel/task-plugins';
import type { RouteDeps } from './shared';
import { tenantIdOf } from './shared';

type Wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => void;
type Ctx = { wrap: Wrap; id: (req: Request) => string; changes: FrameworkChanges };

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000)
    throw new RunError(400, 'INVALID_INPUT', `${label}必须是有效文本`);
  return value;
}

/** 插件开发授权（工作区级） */
function registerPluginGrant(app: Express, deps: RouteDeps, service: RunService, { wrap }: Ctx): void {
  app.put(
    '/api/v2/workspace/plugin-development',
    wrap((req, res) => {
      const role = (req as Request & { apiRole?: string }).apiRole;
      if (role && role !== 'admin') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '插件开发授权需要用户管理员');
      const { enabled, permissions, dependencies, revision } = req.body ?? {};
      const allowed = ['workspace.read', 'workspace.write', 'network', 'process', 'delegate'];
      const packages = deps.kernel.config.get<string[]>('plugins.allowedDependencies', []);
      if (
        typeof enabled !== 'boolean' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        !Array.isArray(permissions) ||
        permissions.some((p) => !allowed.includes(p)) ||
        !Array.isArray(dependencies) ||
        dependencies.some((p) => typeof p !== 'string' || !packages.includes(p))
      )
        throw new RunError(400, 'INVALID_PLUGIN_GRANT', '插件开发授权范围无效');
      const result = service.setPluginDevelopment(
        tenantIdOf(req),
        {
          enabled,
          permissions: [...new Set(permissions)] as import('../../kernel/types').ToolPermission[],
          dependencies: [...new Set(dependencies)] as string[],
        },
        revision,
      );
      deps.store.appendAuthorizationAudit({
        outcome: 'granted',
        subject: 'user-api',
        capability: 'workspace.plugin-development',
        object: result.workspace,
        reason: JSON.stringify(result.pluginDevelopment),
      });
      res.json(result);
    }),
  );
}

/** run 级插件绑定查询、保存与插件自定义 API 挂载 */
function registerRunPlugins(app: Express, deps: RouteDeps, service: RunService, { wrap, id }: Ctx): void {
  app.get(
    '/api/v2/runs/:id/plugins',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      res.json({
        plugins: deps.store.runs.plugins(run.id).map(({ files, ...binding }) => ({ ...binding, files: Object.keys(files) })),
        grant: run.authorization.pluginDevelopment ?? { enabled: false, permissions: [], dependencies: [] },
      });
    }),
  );
  app.post(
    '/api/v2/runs/:id/plugins/:pluginId/save',
    wrap((req, res) => {
      const run = service.get(id(req), tenantIdOf(req));
      const role = (req as Request & { apiRole?: string }).apiRole;
      if (role && role !== 'admin') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '保存插件需要用户管理员');
      const plugins = taskPluginService(deps.kernel);
      if (!plugins) throw new RunError(503, 'PLUGIN_SERVICE_UNAVAILABLE', '插件服务未启用');
      try {
        plugins.save(run, String(req.params.pluginId), text(req.body?.hash, '插件版本'));
      } catch (error) {
        throw new RunError(409, 'PLUGIN_SAVE_CONFLICT', String(error));
      }
      res.json({ saved: true });
    }),
  );
  app.use('/api/v2/runs/:id/plugins/:pluginId/api/:mount', (req, res, next) => {
    try {
      const run = service.get(id(req), tenantIdOf(req));
      const role = (req as Request & { apiRole?: string }).apiRole;
      if (role && role !== 'admin') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '任务插件接口需要用户管理员');
      const route = taskPluginService(deps.kernel)
        ?.routes(run.id)
        .find((item) => item.pluginId === req.params.pluginId && item.mount === req.params.mount);
      if (!route) {
        res.status(404).json({ code: 'PLUGIN_ROUTE_UNAVAILABLE' });
        return;
      }
      return Promise.resolve((route.router as (req: Request, res: Response, next: NextFunction) => unknown)(req, res, next)).catch(next);
    } catch (error) {
      if (error instanceof RunError) res.status(error.status).json({ code: error.code, error: error.message });
      else next(error);
    }
  });
}

/** 工作区权限档（standard / developer） */
function registerWorkspacePermission(app: Express, deps: RouteDeps, service: RunService, { wrap }: Ctx): void {
  app.put(
    '/api/v2/workspace/permissions',
    wrap((req, res) => {
      const role = (req as Request & { apiRole?: string }).apiRole;
      if (role && role !== 'admin') throw new RunError(403, 'USER_AUTHORIZATION_REQUIRED', '修改权限档需要用户管理员授权');
      const { profile, revision } = req.body ?? {};
      if (!['standard', 'developer'].includes(profile) || !Number.isSafeInteger(revision) || revision < 0)
        throw new RunError(400, 'INVALID_PERMISSION', '权限档或版本无效');
      const permission = service.setWorkspacePermission(tenantIdOf(req), profile, revision);
      deps.store.appendAuthorizationAudit({
        outcome: 'granted',
        subject: 'user-api',
        capability: 'workspace.permission',
        object: permission.workspace,
        reason: `${profile}:${permission.revision}`,
      });
      res.json(permission);
    }),
  );
}

/** 框架隔离副本的审阅 / 校验 / 采纳 */
function registerFrameworkChanges(app: Express, deps: RouteDeps, service: RunService, { wrap, id, changes }: Ctx): void {
  const requireDeveloper = (req: Request) => {
    const role = (req as Request & { apiRole?: string }).apiRole;
    if ((role && role !== 'admin') || service.workspacePermission(tenantIdOf(req)).profile !== 'developer')
      throw new RunError(403, 'DEVELOPER_AUTHORIZATION_REQUIRED', '需要用户管理员开启工作区开发者权限');
  };
  const requireIdleChange = (req: Request) => {
    if (deps.store.runs.active(tenantIdOf(req)).some((run) => run.authorization.frameworkChangeId === id(req)))
      throw new RunError(409, 'CHANGE_BUSY', '请先停止隔离副本中的活动任务');
  };
  app.get(
    '/api/v2/framework/changes',
    wrap(async (req, res) => {
      requireDeveloper(req);
      res.json(await changes.list(tenantIdOf(req)));
    }),
  );
  app.post(
    '/api/v2/framework/changes',
    wrap(async (req, res) => {
      requireDeveloper(req);
      res.status(201).json(await changes.create(tenantIdOf(req)));
    }),
  );
  app.post(
    '/api/v2/framework/changes/:id/review',
    wrap(async (req, res) => {
      requireDeveloper(req);
      requireIdleChange(req);
      res.json(await changes.review(id(req), tenantIdOf(req)));
    }),
  );
  app.post(
    '/api/v2/framework/changes/:id/validate',
    wrap(async (req, res) => {
      requireDeveloper(req);
      requireIdleChange(req);
      res.json(await changes.validate(id(req), tenantIdOf(req)));
    }),
  );
  app.post(
    '/api/v2/framework/changes/:id/adopt',
    wrap(async (req, res) => {
      requireDeveloper(req);
      if (deps.store.runs.active(tenantIdOf(req)).length) throw new RunError(409, 'WORKSPACE_BUSY', '请先停止活动任务再采纳框架修改');
      res.json(await changes.adopt(id(req), tenantIdOf(req), text(req.body?.digest, '审阅版本')));
    }),
  );
}

export function registerWorkspaceRoutes(
  app: Express,
  deps: RouteDeps,
  service: RunService,
  helpers: { wrap: Wrap; id: (req: Request) => string; changes: FrameworkChanges },
): void {
  registerPluginGrant(app, deps, service, helpers);
  registerRunPlugins(app, deps, service, helpers);
  registerWorkspacePermission(app, deps, service, helpers);
  registerFrameworkChanges(app, deps, service, helpers);
}
