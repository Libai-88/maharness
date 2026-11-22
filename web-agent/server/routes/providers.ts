/**
 * server/routes/providers.ts —— Provider 管理（协议适配层，ADR 0010）
 *
 * 这里只解析请求、调用例、映射状态码；校验、SSRF 边界、并发版本与健康联动都在
 * `server/usecases/providers.ts`。路由文件的体积因此与"端点数"成正比，而不是与业务复杂度成正比。
 */
import type { Express, Response } from 'express';
import type { RouteDeps } from './shared';
import { UsecaseError } from '../usecases/error';
import {
  checkToolCall,
  createProvider,
  listChatModels,
  listProviders,
  providerDiagnostics,
  providerGateway,
  removeProvider,
  testProvider,
  updateProvider,
} from '../usecases/providers';
import { pullModels, readModels, updateModelProfile } from '../usecases/provider-models';
import { buildProviderDiagnostics, buildProviderGatewaySnapshot } from '../usecases/provider-support';
import type { ProviderDiagnosticModel, ProviderDiagnostics } from '../usecases/provider-support';

export type { ProviderDiagnosticModel, ProviderDiagnostics };
export { buildProviderDiagnostics, buildProviderGatewaySnapshot };

/** 用例错误 → HTTP 响应；其它异常交给 express 的兜底处理（与原实现一致）。 */
function fail(res: Response, error: unknown): Response | undefined {
  if (error instanceof UsecaseError) return res.status(error.status).json({ error: error.message });
  return undefined;
}

export function registerProviderRoutes(app: Express, deps: RouteDeps): void {
  const ctx = { kernel: deps.kernel, store: deps.store };
  const route =
    (handler: (req: { params: Record<string, string>; body: unknown; query: Record<string, unknown> }) => unknown) =>
    async (req: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> }, res: Response) => {
      try {
        const out = await handler({
          params: req.params ?? {},
          body: req.body ?? {},
          query: req.query ?? {},
        });
        if (!res.headersSent) res.json(out);
      } catch (error) {
        if (!fail(res, error)) throw error;
      }
    };

  app.post('/api/providers/:id/tool-check', async (req, res) => {
    try {
      res.json(await checkToolCall(ctx, req.params.id, (req.body ?? {}) as Record<string, unknown>));
    } catch (error) {
      // Transport failure cannot establish or revoke model capability.
      if (error instanceof UsecaseError && error.status === 502) return res.status(502).json({ error: error.message, status: 'unknown' });
      if (!fail(res, error)) throw error;
    }
  });

  app.get(
    '/api/providers/gateway',
    route(() => providerGateway(ctx)),
  );
  app.get(
    '/api/providers',
    route(() => listProviders(ctx)),
  );
  app.get(
    '/api/providers/:id/diagnose',
    route(({ params }) => providerDiagnostics(ctx, params.id)),
  );
  app.post(
    '/api/providers',
    route(({ body }) => createProvider(ctx, body as Record<string, unknown>)),
  );
  app.patch(
    '/api/providers/:id',
    route(({ params, body }) => updateProvider(ctx, params.id, body as Record<string, unknown>)),
  );
  app.delete(
    '/api/providers/:id',
    route(({ params, body }) => removeProvider(ctx, params.id, body as Record<string, unknown>)),
  );

  /** 连接测试：HTTP 语义与原来一致——失败也是 400，body 带 ok:false。 */
  app.post('/api/providers/test', async (req, res) => {
    try {
      const out = await testProvider(ctx, (req.body ?? {}) as Record<string, unknown>);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (error) {
      if (!fail(res, error)) throw error;
    }
  });

  // ---------- 模型 ----------
  app.post(
    '/api/providers/models',
    route(({ body }) => pullModels(ctx, body as Record<string, unknown>)),
  );
  app.get(
    '/api/providers/:id/models',
    route(({ params }) => readModels(ctx.store, params.id)),
  );
  app.patch(
    '/api/providers/:id/models',
    route(({ params, query, body }) => updateModelProfile(ctx, params.id, query, body as Record<string, unknown>)),
  );
  app.get(
    '/api/models',
    route(() => listChatModels(ctx)),
  );
}
