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
    const parentId = req.query.parent_id ? String(req.query.parent_id) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    let steps = kernel.trace.query(traceId, { type, name, parentId, limit });
    let source: 'ring' | 'archive' = 'ring';
    if (steps.length === 0 && (traceId || parentId)) {
      // ring 未命中（重启/跨日期）→ 回退 JSONL 归档；无 traceId 的全量归档查询
      // 开销不可控，不做（前端按 traceId 下钻足够）
      steps = kernel.trace.queryArchive(traceId, { type, name, parentId, limit });
      source = 'archive';
    }
    res.json({ steps, source });
  });

  app.get('/api/trace/stats', (_req, res) => {
    res.json({ trace: kernel.trace.statsSnapshot(), cache: kernel.cache.statsSnapshot(), l1Enabled: kernel.cache.l1Enabled });
  });
}
