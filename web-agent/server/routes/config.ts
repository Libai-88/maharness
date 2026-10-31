/**
 * server/routes/config.ts —— 运行时配置 + 元信息
 * 上下文管理 / 缓存参数 / 思维链预算，config.changed 热生效；设置页「打开目录」等。
 */
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { openInExplorer, type RouteDeps } from './shared';
import { stopAllWarmups } from './warmup';

export function registerConfigRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const setPersistentBatch = (entries: [string, unknown][], expectedRevision?: string): boolean => {
    const config = kernel.config as typeof kernel.config & {
      setPersistentBatch?: (changes: readonly (readonly [string, unknown])[], expectedRevision?: string) => boolean;
    };
    if (typeof config.setPersistentBatch === 'function') return config.setPersistentBatch(entries, expectedRevision);
    for (const [key, value] of entries) config.setPersistent(key, value);
    return true;
  };
  const expectedRevision = (body: unknown): string | undefined => {
    const value = body && typeof body === 'object' ? (body as Record<string, unknown>).revision : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const boundedNumber = (value: unknown, name: string, min: number, max: number, integer = false): number => {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) throw new Error(`${name} 须为${integer ? '整数' : '有限数字'}`);
    return Math.max(min, Math.min(max, n));
  };

  app.get('/api/config', (_req, res) => {
    res.json({
      revision: (kernel.config as typeof kernel.config & { getPersistedRevision?: () => string }).getPersistedRevision?.() ?? 'unversioned',
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
        modelRouting: kernel.config.get<Record<string, string>>('agent.modelRouting', {}),
      },
      checkpoint: {
        retentionDays: kernel.config.get<number>('checkpoint.retentionDays', 30),
      },
      provider: {
        circuitBreakerThreshold: kernel.config.get<number>('provider.circuitBreakerThreshold', 3),
        circuitBreakerResetMs: kernel.config.get<number>('provider.circuitBreakerResetMs', 60_000),
      },
      // 路由目标候选（provider@model 全清单，含能力标注）——前端下拉用，避免手敲
      routingTargets: (kernel.plugins.resolveService('service:chat') as
        { providers?: { id: string; label: string; defaultModel: string; models?: { modelId: string; vision: boolean; tools: boolean; reasoning: boolean; contextWindow: number; latencyMs?: number; privacyTier?: string; riskLevel?: string }[] }[] } | undefined)
        ?.providers?.flatMap((p) => {
          const models = p.models?.length ? p.models : [{ modelId: p.defaultModel, vision: false, tools: true, reasoning: false, contextWindow: 0 }];
          return models.map(m => ({
            value: `${p.id}@${m.modelId}`,
            label: `${p.label} · ${m.modelId}`,
            vision: m.vision, tools: m.tools, reasoning: m.reasoning, contextWindow: m.contextWindow,
            ...(m.latencyMs === undefined ? {} : { latencyMs: m.latencyMs }),
            ...(m.privacyTier === undefined ? {} : { privacyTier: m.privacyTier }),
            ...(m.riskLevel === undefined ? {} : { riskLevel: m.riskLevel }),
          }));
        }) ?? [],
      taskTypes: ['默认', '代码', '文件操作', '检索', '写作', '问答', '其他'],
    });
  });

  app.patch('/api/config', (req, res) => {
    try {
      const revision = expectedRevision(req.body);
      const revisionReader = kernel.config as typeof kernel.config & { getPersistedRevision?: () => string };
      const currentRevision = revisionReader.getPersistedRevision?.();
      if (currentRevision !== undefined && revision !== undefined && revision !== currentRevision) {
        return res.status(409).json({ error: '配置已被其他写入者修改，请重新读取后再保存', revision: currentRevision });
      }
      const { context, cache, agent, provider, checkpoint } = req.body ?? {};
      const changes: [string, unknown][] = [];
      const persist = (key: string, value: unknown): void => { changes.push([key, value]); };
      let warmupOff = false;
      let retentionMs: number | undefined;
      if (context?.maxTokens !== undefined) {
        persist('context.maxTokens', Math.max(2000, Math.min(200_000, Number(context.maxTokens))));
      }
      if (context?.truncateInject !== undefined) persist('context.truncateInject', Boolean(context.truncateInject));
      if (context?.compact !== undefined) persist('context.compact', Boolean(context.compact));
      // M11 契约清理：cache 参数热更已由 kernel 侧 config.watch 统一接管
      //（config.set 广播 config.changed → kernel 订阅刷新 cache 实例），
      // server 不再手动补写 kernel.cache——避免「config 与 cache 状态双写漂移」。
      if (cache?.l1Threshold !== undefined) {
        persist('cache.l1Threshold', Math.min(1, Math.max(0.5, Number(cache.l1Threshold))));
      }
      if (cache?.l2TtlMin !== undefined) {
        persist('cache.l2TtlMin', Math.max(1, Math.min(1440, Number(cache.l2TtlMin))));
      }
      if (cache?.l3Enabled !== undefined) persist('cache.l3Enabled', Boolean(cache.l3Enabled));
      if (cache?.warmup !== undefined && ['off', 'light', 'auto'].includes(String(cache.warmup))) {
        const warmup = String(cache.warmup);
        persist('cache.warmup', warmup);
        warmupOff = warmup === 'off';
      }
      if (agent?.reasoningBudget !== undefined) {
        persist('agent.reasoningBudget', Math.max(100, Math.min(16000, Number(agent.reasoningBudget))));
      }
      if (agent?.reasoningTotalBudget !== undefined) {
        persist('agent.reasoningTotalBudget', Math.max(200, Math.min(64000, Number(agent.reasoningTotalBudget))));
      }
      if (agent?.thinkInEnglish !== undefined) {
        persist('agent.thinkInEnglish', Boolean(agent.thinkInEnglish));
      }
      if (provider?.circuitBreakerThreshold !== undefined) {
        persist('provider.circuitBreakerThreshold', boundedNumber(provider.circuitBreakerThreshold, 'circuitBreakerThreshold', 1, 20, true));
      }
      if (provider?.circuitBreakerResetMs !== undefined) {
        persist('provider.circuitBreakerResetMs', boundedNumber(provider.circuitBreakerResetMs, 'circuitBreakerResetMs', 1_000, 3_600_000, true));
      }
      if (checkpoint?.retentionDays !== undefined) {
        const days = boundedNumber(checkpoint.retentionDays, 'checkpoint.retentionDays', 1, 3650, true);
        persist('checkpoint.retentionDays', days);
        retentionMs = days * 24 * 60 * 60 * 1000;
      }
      // 任务类型 → provider@model 路由表（值为空表示删除该类目路由）
      if (agent?.modelRouting !== undefined) {
        const raw = agent.modelRouting as Record<string, unknown>;
        if (raw === null || typeof raw !== 'object') throw new Error('modelRouting 须为对象');
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          const key = String(k).trim().slice(0, 20);
          const value = String(v ?? '').trim();
          if (!key) continue;
          if (!value) continue;
          if (!/^[\w.\-]+(@[\w.\-:/]+)?$/.test(value)) throw new Error(`路由目标格式非法: ${value}（应为 providerId 或 providerId@model）`);
          clean[key] = value;
        }
        persist('agent.modelRouting', clean);
      }
      // 轮数上限（按模式可调）：超限后断点保留，可继续推进
      if (agent?.maxTurns !== undefined) {
        persist('agent.maxTurns', Math.max(1, Math.min(200, Number(agent.maxTurns))));
      }
      if (agent?.maxTurnsPlan !== undefined) {
        persist('agent.maxTurnsPlan', Math.max(1, Math.min(400, Number(agent.maxTurnsPlan))));
      }
      if (agent?.maxTurnsGoal !== undefined) {
        persist('agent.maxTurnsGoal', Math.max(1, Math.min(400, Number(agent.maxTurnsGoal))));
      }
      if (!setPersistentBatch(changes, revision)) {
        const code = (kernel.config as typeof kernel.config & { getPersistentFailureCode?: () => string | undefined }).getPersistentFailureCode?.();
        const latest = revisionReader.getPersistedRevision?.();
        if (code === 'concurrent_write') return res.status(409).json({ error: '配置已被其他写入者修改，请重新读取后再保存', revision: latest });
        return res.status(503).json({ error: '配置未提交，原配置保持不变' });
      }
      if (warmupOff) stopAllWarmups();
      if (retentionMs !== undefined) deps.store.setCheckpointRetentionMs(retentionMs);
      res.json({ ok: true, revision: revisionReader.getPersistedRevision?.() ?? 'unversioned' });
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
