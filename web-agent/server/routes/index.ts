import { setMaintenanceModelScope } from '../../kernel/model-call';
/**
 * server/routes/index.ts —— 路由装配入口
 * 与插件解耦：对话服务通过能力注册表获取（kind=service, id=chat），不认识插件内部实现。
 * 各资源端点按文件拆分（sessions/chat/files/...），此处仅做装配与跨资源共用件
 * （JSON body 解析、健康检查）；共享工具见 shared.ts，L3 缓存预热见 warmup.ts。
 */
import express from 'express';
import { existsSync, statfsSync } from 'node:fs';
import type { Express } from 'express';
import type { Kernel } from '../../kernel';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import pkg from '../../package.json';
import { registerProviderRoutes } from './providers';
import { registerPersonaRoutes } from './personas';
import { registerSkillRoutes } from './skills';
import { registerEvolveRoutes } from './evolve';
import { registerRulesRoutes } from './rules';
import { registerSessionRoutes } from './sessions';
import { registerChatRoutes } from './chat';
import { registerWorkspaceRoutes } from './workspaces';
import { registerFileRoutes } from './files';
import { registerGitRoutes } from './git';
import { registerConfigRoutes } from './config';
import { registerPluginRoutes } from './plugins';
import { registerTraceRoutes } from './trace';
import { registerStatsRoutes } from './stats';
import { registerApprovalRoutes } from './approvals';
import { registerEventRoutes } from './events';
import { registerCommandRoutes } from './commands';
import { registerTenantRoutes } from './tenants';
import { registerScheduleRoutes } from './schedules';
import type { Scheduler } from '../scheduler';
import { getChatService, SseConnectionLimiter } from './shared';
import { activeRunCount } from '../index';
import { activeWarmupCount } from './warmup';
import { RunService } from '../run-service';
import { registerRunRoutes } from './runs';
import { getRunner } from './shared';
import { tenantSandboxRoot } from '../tenant-workspace';
import { beginRun, endRun } from '../index';
import { loadPromptRules } from '../../kernel/rules';

export { refreshChatProviders, refreshChatPersonas } from './shared';

export interface ReadinessChecks { kernel: boolean; database: boolean; providers: boolean; plugins: boolean; storage: boolean; }
export interface ReadinessSnapshot { schemaVersion: 1; ok: boolean; checks: ReadinessChecks; }

export const STORAGE_CAPACITY_THRESHOLDS = { warningFreePercent: 10, criticalFreePercent: 5 } as const;
export type StorageStatus = 'ok' | 'warning' | 'critical' | 'unknown';
export interface StorageSnapshot {
  schemaVersion: 1;
  ok: boolean;
  status: StorageStatus;
  totalBytes: number | null;
  freeBytes: number | null;
  freePercent: number | null;
  thresholds: typeof STORAGE_CAPACITY_THRESHOLDS;
}

export function buildReadinessSnapshot(input: { providerCount: number; pluginErrors: number; database: boolean; storage?: boolean }): ReadinessSnapshot {
  const checks: ReadinessChecks = { kernel: true, database: input.database, providers: input.providerCount > 0, plugins: input.pluginErrors === 0, storage: input.storage ?? true };
  return { schemaVersion: 1, ok: Object.values(checks).every(Boolean), checks };
}

export function buildStorageSnapshot(totalBytes: number, freeBytes: number): StorageSnapshot {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0
    || !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) {
    return { schemaVersion: 1, ok: false, status: 'unknown', totalBytes: null, freeBytes: null, freePercent: null, thresholds: STORAGE_CAPACITY_THRESHOLDS };
  }
  const freePercent = Math.round(freeBytes / totalBytes * 10_000) / 100;
  const status: StorageStatus = freePercent <= STORAGE_CAPACITY_THRESHOLDS.criticalFreePercent
    ? 'critical'
    : freePercent <= STORAGE_CAPACITY_THRESHOLDS.warningFreePercent ? 'warning' : 'ok';
  return { schemaVersion: 1, ok: status !== 'critical', status, totalBytes, freeBytes, freePercent, thresholds: STORAGE_CAPACITY_THRESHOLDS };
}

export function readStorageSnapshot(dataDir: string): StorageSnapshot {
  try {
    if (!existsSync(dataDir)) return { schemaVersion: 1, ok: false, status: 'unknown', totalBytes: null, freeBytes: null, freePercent: null, thresholds: STORAGE_CAPACITY_THRESHOLDS };
    const stats = statfsSync(dataDir);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return buildStorageSnapshot(totalBytes, freeBytes);
  } catch { return { schemaVersion: 1, ok: false, status: 'unknown', totalBytes: null, freeBytes: null, freePercent: null, thresholds: STORAGE_CAPACITY_THRESHOLDS }; }
}

export function registerRoutes(app: Express, kernel: Kernel, store: Store, tracker?: ClientTracker, scheduler?: Scheduler): RunService {
  app.use(express.json({ limit: '5mb' }));

  const deps = {
    kernel, store, tracker,
    ...(scheduler ? { scheduler } : {}),
    sseLimiter: new SseConnectionLimiter(Math.max(1, kernel.config.get<number>('sse.maxConnections', 8))),
    activeRunCount: () => activeRunCount(),
  };
  const runs = new RunService({
    store, runner: () => getRunner(kernel),
    tools: () => kernel.plugins.capabilities('tool').map(capability => capability.tool),
    maxDepth: kernel.config.get<number>('agent.maxDelegationDepth', 4),
    executionSlots: kernel.config.get<number>('agent.executionSlots', 16),
    workspace: tenant => tenantSandboxRoot(kernel.config.get<string>('sandboxRoot', kernel.rootDir), tenant),
    provider: (session, selected) => {
      const providers = getChatService(kernel)?.providers ?? [];
      const provider = selected ? providers.find(p => p.id === selected) : providers.find(p => p.id === session.provider) ?? providers[0];
      return provider ? { id: provider.id, model: provider.defaultModel } : undefined;
    },
    prepare: record => {
      const chat = getChatService(kernel);
      const provider = chat?.providers.find(p => p.id === record.providerId);
      if (!chat || !provider) throw new Error('任务模型供应商不可用，请恢复配置后重试');
      const rules = loadPromptRules({ dataDir: kernel.paths.data, projectRoot: record.authorization.workspace, maxChars: Number.MAX_SAFE_INTEGER });
      return {
        provider, model: record.model, messages: [], traceId: record.id,
        contextWindow: Math.min(kernel.config.get<number>('context.maxTokens', 60_000), provider.models?.find(model => model.modelId === record.model)?.contextWindow ?? Number.POSITIVE_INFINITY),
        systemPrompt: chat.getRuntimePrompt?.() ?? chat.getSystemPrompt(),
        contextMessages: [
          ...(chat.getUserContext?.() ?? []),
          ...(rules.text ? [{ role: 'user' as const, content: rules.text, context: { id: 'workspace-rules', source: rules.sources.filter(source => source.exists).map(source => source.file).join(';'), scope: 'workspace' as const, trust: 'user' as const, retention: 'required' as const } }] : []),
          { role: 'system', content: `工作区: ${record.authorization.workspace}\n授权: ${record.authorization.profile}${record.authorization.readOnly ? '；变更需要审批' : ''}`, context: { id: 'authorization', source: 'runtime-authorization', scope: 'runtime', trust: 'core', retention: 'required' } },
        ],
        maxTurns: kernel.config.get<number>('agent.maxTurns', 30),
        fallbackProviders: kernel.config.get<string[]>('agent.fallbackProviders', []).flatMap(id => chat.providers.filter(p => p.id === id && p.id !== provider.id)),
        compactFn: (history, maxTokens, signal, onUsage) => chat.compactHistory(history, maxTokens ?? kernel.config.get<number>('context.maxTokens', 60_000), { provider, model: record.model, traceId: record.id, trace: kernel.trace, signal, onUsage }).then(result => result.messages),
      };
    },
    activity: active => active ? beginRun() : endRun(),
  });
  runs.attachMaintenance(setMaintenanceModelScope(runs.maintenanceScope()));
  registerRunRoutes(app, deps, runs);
  scheduler?.attach(runs);

  // ---------- 健康检查（M4 前置：bin 脚本据此校验进程身份/版本；无鉴权阻碍，只读无害） ----------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version, pid: process.pid });
  });

  app.get('/api/ready', (_req, res) => {
    const storage = readStorageSnapshot(kernel.paths.data);
    const snapshot = buildReadinessSnapshot({ providerCount: store.listProviders().length, pluginErrors: kernel.plugins.list().filter((plugin) => plugin.state === 'error').length, database: true, storage: storage.status !== 'critical' && storage.status !== 'unknown' });
    const chat = getChatService(kernel);
    res.status(snapshot.ok ? 200 : 503).json({
      ...snapshot,
      resources: {
        activeRuns: deps.activeRunCount(),
        sseConnections: deps.sseLimiter?.size ?? 0,
        pageConnections: tracker?.size ?? 0,
        pendingApprovals: chat?.listApprovals().length ?? 0,
        activeWarmups: activeWarmupCount(),
        activeSubagentSlots: kernel.budget.activeSubagentCount(),
      },
    });
  });

  app.get('/api/storage', (_req, res) => res.json(readStorageSnapshot(kernel.paths.data)));

  registerProviderRoutes(app, deps);   // Provider 管理 + 模型列表
  registerPersonaRoutes(app, deps);    // 人设管理
  registerSkillRoutes(app, deps);      // Skills（内置 + 市场）
  registerEvolveRoutes(app, deps);     // 技能提案（自进化）
  registerRulesRoutes(app, deps);      // 用户规则（全局/项目/策略）
  registerSessionRoutes(app, deps);    // 会话 CRUD / 消息 / 批量删除
  registerTenantRoutes(app, deps);     // OPS-01 租户注册表
  registerScheduleRoutes(app, deps);   // 长任务到点续跑
  registerChatRoutes(app, deps, runs);
  registerWorkspaceRoutes(app, deps);  // 工作区
  registerFileRoutes(app, deps);       // 文件 API（沙箱内）
  registerGitRoutes(app, deps);        // Git
  registerConfigRoutes(app, deps);     // 运行时配置 + 元信息
  registerPluginRoutes(app, deps);     // 插件管理 + 能力注册表
  registerTraceRoutes(app, deps);      // Trace 观测
  registerStatsRoutes(app, deps);      // 统计
  registerApprovalRoutes(app, deps);   // 审批
  registerEventRoutes(app, deps);      // 全局事件流（SSE）
  registerCommandRoutes(app, deps);    // 斜杠命令
  return runs;
}
