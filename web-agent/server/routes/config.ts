/**
 * server/routes/config.ts —— 运行时配置 + 元信息
 * 上下文管理 / 缓存参数 / 思维链预算，config.changed 热生效；设置页「打开目录」等。
 */
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { openInExplorer, type RouteDeps } from './shared';

export function registerConfigRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.get('/api/config', (_req, res) => {
    res.json({
      context: {
        maxTokens: kernel.config.get<number>('context.maxTokens', 60000),
        truncateInject: kernel.config.get<boolean>('context.truncateInject', true),
        compact: kernel.config.get<boolean>('context.compact', true),
      },
      cache: {
        l1Threshold: kernel.config.get<number>('cache.l1Threshold', 0.58),
        l2TtlMin: kernel.config.get<number>('cache.l2TtlMin', 30),
        l3Enabled: kernel.config.get<boolean>('cache.l3Enabled', true),
        warmup: kernel.config.get<'off' | 'light' | 'auto'>('cache.warmup', 'auto'),
      },
      agent: {
        reasoningBudget: kernel.config.get<number>('agent.reasoningBudget', 800),
        reasoningTotalBudget: kernel.config.get<number>('agent.reasoningTotalBudget', 3000),
        thinkInEnglish: kernel.config.get<boolean>('agent.thinkInEnglish', true),
      },
    });
  });

  app.patch('/api/config', (req, res) => {
    try {
      const { context, cache, agent } = req.body ?? {};
      if (context?.maxTokens !== undefined) {
        kernel.config.set('context.maxTokens', Math.max(2000, Math.min(200_000, Number(context.maxTokens))));
      }
      if (context?.truncateInject !== undefined) kernel.config.set('context.truncateInject', Boolean(context.truncateInject));
      if (context?.compact !== undefined) kernel.config.set('context.compact', Boolean(context.compact));
      // M11 契约清理：cache 参数热更已由 kernel 侧 config.watch 统一接管
      //（config.set 广播 config.changed → kernel 订阅刷新 cache 实例），
      // server 不再手动补写 kernel.cache——避免「config 与 cache 状态双写漂移」。
      if (cache?.l1Threshold !== undefined) {
        kernel.config.set('cache.l1Threshold', Math.min(1, Math.max(0.5, Number(cache.l1Threshold))));
      }
      if (cache?.l2TtlMin !== undefined) {
        kernel.config.set('cache.l2TtlMin', Math.max(1, Math.min(1440, Number(cache.l2TtlMin))));
      }
      if (cache?.l3Enabled !== undefined) kernel.config.set('cache.l3Enabled', Boolean(cache.l3Enabled));
      if (cache?.warmup !== undefined && ['off', 'light', 'auto'].includes(String(cache.warmup))) {
        kernel.config.set('cache.warmup', String(cache.warmup));
      }
      if (agent?.reasoningBudget !== undefined) {
        kernel.config.set('agent.reasoningBudget', Math.max(100, Math.min(16000, Number(agent.reasoningBudget))));
      }
      if (agent?.reasoningTotalBudget !== undefined) {
        kernel.config.set('agent.reasoningTotalBudget', Math.max(200, Math.min(64000, Number(agent.reasoningTotalBudget))));
      }
      if (agent?.thinkInEnglish !== undefined) {
        kernel.config.set('agent.thinkInEnglish', Boolean(agent.thinkInEnglish));
      }
      // 轮数上限（按模式可调）：超限后断点保留，可继续推进
      if (agent?.maxTurns !== undefined) {
        kernel.config.set('agent.maxTurns', Math.max(1, Math.min(200, Number(agent.maxTurns))));
      }
      if (agent?.maxTurnsPlan !== undefined) {
        kernel.config.set('agent.maxTurnsPlan', Math.max(1, Math.min(400, Number(agent.maxTurnsPlan))));
      }
      if (agent?.maxTurnsGoal !== undefined) {
        kernel.config.set('agent.maxTurnsGoal', Math.max(1, Math.min(400, Number(agent.maxTurnsGoal))));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 元信息（设置页「打开目录」等） ----------
  app.get('/api/meta/paths', (_req, res) => {
    const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    res.json({
      sandboxRoot: sandbox,
      dbFile: kernel.paths.dbFile,
      tracesDir: kernel.paths.traces,
      configFile: kernel.paths.configFile,
    });
  });

  app.post('/api/meta/open', (req, res) => {
    const kind = String(req.body?.kind ?? '');
    const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    const targets: Record<string, string> = {
      sandbox,
      db: kernel.paths.dbFile,
      traces: kernel.paths.traces,
      config: kernel.paths.configFile,
    };
    const target = targets[kind];
    if (!target || !existsSync(target)) return res.status(404).json({ error: '目标不存在' });
    openInExplorer(target);
    res.json({ ok: true, kind, path: target });
  });
}
