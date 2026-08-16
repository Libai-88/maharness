/**
 * server/routes/trace.ts —— Trace 观测
 */
import type { Express } from 'express';
import type { RouteDeps } from './shared';

export function registerTraceRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.get('/api/trace', (req, res) => {
    const traceId = req.query.trace_id ? String(req.query.trace_id) : undefined;
    const type = req.query.type ? String(req.query.type) : undefined;
    const name = req.query.name ? String(req.query.name) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ steps: kernel.trace.query(traceId, { type, name, limit }) });
  });

  app.get('/api/trace/stats', (_req, res) => {
    res.json({ trace: kernel.trace.statsSnapshot(), cache: kernel.cache.statsSnapshot(), l1Enabled: kernel.cache.l1Enabled });
  });
}
