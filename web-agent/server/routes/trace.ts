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
    const sessionId = req.query.session_id ? String(req.query.session_id) : undefined;
    const pluginId = req.query.plugin_id ? String(req.query.plugin_id) : undefined;
    const parseTs = (key: string): number | undefined => {
      const raw = req.query[key];
      if (raw === undefined) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const fromTs = parseTs('from_ts');
    const toTs = parseTs('to_ts');
    const beforeTs = parseTs('before_ts');
    const status = req.query.status ? String(req.query.status) : undefined;
    const errorCategory = req.query.error_category ? String(req.query.error_category) : undefined;
    const includeParents = req.query.include_parents === '1';
    const requestedLimit = req.query.limit ? Number(req.query.limit) : 100;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 100;
    const baseFilter = { type, name, parentId, sessionId, pluginId, fromTs, toTs, beforeTs, status, errorCategory, limit };
    let steps = kernel.trace.query(traceId, baseFilter);
    let source: 'ring' | 'archive' = 'ring';
    if (steps.length === 0 && (traceId || parentId || sessionId || pluginId)) {
      // ring 未命中（重启/跨日期）→ 回退 JSONL 归档；带维度过滤时仍可控，
      // 无任何定位条件的全量归档查询继续禁止。
      steps = kernel.trace.queryArchive(traceId, baseFilter);
      source = 'archive';
    }
    let unresolvedParentIds: string[] = [];
    if (includeParents) {
      const graph = kernel.trace.resolveParentChain(steps);
      steps = graph.steps;
      unresolvedParentIds = graph.unresolvedParentIds;
    }
    // query/queryArchive 已按同一过滤器执行；保留统一分页出口。
    const pageLimit = includeParents ? Math.min(500, Math.max(limit, steps.length)) : limit;
    const page = steps.slice(-pageLimit);
    const nextCursor = page.length === limit && page.length > 0 ? String(page[0]!.ts) : undefined;
    res.json({ steps: page, source, ...(nextCursor ? { nextCursor } : {}), ...(includeParents ? { parentChainComplete: unresolvedParentIds.length === 0, unresolvedParentIds } : {}) });
  });

  app.get('/api/trace/stats', (_req, res) => {
    res.json({ trace: kernel.trace.statsSnapshot(), cache: kernel.cache.statsSnapshot(), l1Enabled: kernel.cache.l1Enabled });
  });
}
