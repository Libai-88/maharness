/**
 * server/routes/stats.ts —— 统计（上下文用量 / 缓存命中率 / 总体概览）
 */
import type { Express } from 'express';
import type { RouteDeps } from './shared';

export function registerStatsRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  app.get('/api/stats', (_req, res) => {
    const trace = kernel.trace.stats();
    const cache = kernel.cache.stats();
    const overview = store.statsOverview();
    const maxCtx = kernel.config.get<number>('context.maxTokens', 60000);
    const rate = (hits: number, misses: number): { hits: number; misses: number; rate: number } => {
      const total = hits + misses;
      return { hits, misses, rate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0 };
    };
    // 每会话：消息量 / 成本 / 估算上下文用量（与预算对比）/ 截断次数
    // M1 聚合下推：tokens/cost/消息数/截断计数全部来自 SQL GROUP BY（db.aggregateSessions），
    // 不再逐会话 listMessages 全量拉 content。estimatedTokens 无法在 SQL 里区分 CJK
    //（estimateTokens = CJK数 + 非CJK/4），改用聚合字符数 /2 近似（全中文上界 1.0、
    // 全英文下界 0.25 的折中）——仅用于 contextUsage 粗展示，精确计费走 tokens 聚合。
    const agg = new Map(store.aggregateSessions().map((a) => [a.sessionId, a]));
    const perSession = store.listSessions().map((s) => {
      const a = agg.get(s.id);
      const estimatedTokens = Math.ceil((a?.chars ?? 0) / 2);
      return {
        id: s.id, title: s.title, mode: s.mode,
        messages: a?.messages ?? 0,
        tokensIn: a?.tokensIn ?? 0,
        tokensOut: a?.tokensOut ?? 0,
        cost: a?.cost ?? 0,
        estimatedTokens,
        contextBudget: maxCtx,
        contextUsage: Math.min(999, Math.round((estimatedTokens / Math.max(maxCtx, 1)) * 1000) / 10),
        truncated: (a?.truncations ?? 0) > 0,
        truncations: a?.truncations ?? 0,
      };
    });
    res.json({
      overview: { ...overview, cacheHitSteps: trace.cacheHits },
      process: {
        steps: trace.steps, llmCalls: trace.llmCalls, toolCalls: trace.toolCalls,
        tokensIn: trace.totalTokensIn, tokensOut: trace.totalTokensOut, cost: trace.totalCost,
      },
      context: { maxTokens: maxCtx, perSession },
      taskProfile: kernel.budget.taskProfile(),
      cache: {
        l1Enabled: kernel.cache.l1Enabled,
        l1: rate(cache.l1Hits, cache.l1Misses),
        l2: rate(cache.l2Hits, cache.l2Misses),
        // L3 双口径：估算（相邻调用公共前缀 token，无 provider 反馈时的降级度量）
        // + 真实（provider usage 确认的缓存命中 token，唯一权威）。
        // 真实命中率 = realTokens / (realTokens + realMissTokens)
        l3: {
          hits: cache.l3Hits, tokens: cache.l3Tokens,
          realHits: cache.l3RealHits, realTokens: cache.l3RealTokens, realMissTokens: cache.l3RealMissTokens,
          realRate: (() => {
            const total = cache.l3RealTokens + cache.l3RealMissTokens;
            return total > 0 ? Math.round((cache.l3RealTokens / total) * 1000) / 10 : 0;
          })(),
        },
        savedCost: cache.savedCost,
        // 综合命中率：L1 直接回答 + L2 工具结果 + L3 前缀复用 占总轮次比例
        overall: (() => {
          const served = cache.l1Hits + cache.l2Hits + cache.l3Hits;
          const total = trace.llmCalls + trace.toolCalls + cache.l1Hits;
          return { served, total, rate: total > 0 ? Math.round((served / total) * 1000) / 10 : 0 };
        })(),
      },
    });
  });
}
