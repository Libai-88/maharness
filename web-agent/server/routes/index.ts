/**
 * server/routes/index.ts —— 路由装配入口
 * 与插件解耦：对话服务通过能力注册表获取（kind=service, id=chat），不认识插件内部实现。
 * 各资源端点按文件拆分（sessions/chat/files/...），此处仅做装配与跨资源共用件
 * （JSON body 解析、健康检查）；共享工具见 shared.ts，L3 缓存预热见 warmup.ts。
 */
import express from 'express';
import type { Express } from 'express';
import type { Kernel } from '../../kernel';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import pkg from '../../package.json';
import { registerProviderRoutes } from './providers';
import { registerPersonaRoutes } from './personas';
import { registerSkillRoutes } from './skills';
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

export { refreshChatProviders, refreshChatPersonas } from './shared';

export function registerRoutes(app: Express, kernel: Kernel, store: Store, tracker?: ClientTracker): void {
  app.use(express.json({ limit: '5mb' }));

  const deps = { kernel, store, tracker };

  // ---------- 健康检查（M4 前置：bin 脚本据此校验进程身份/版本；无鉴权阻碍，只读无害） ----------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version, pid: process.pid });
  });

  registerProviderRoutes(app, deps);   // Provider 管理 + 模型列表
  registerPersonaRoutes(app, deps);    // 人设管理
  registerSkillRoutes(app, deps);      // Skills（内置 + 市场）
  registerSessionRoutes(app, deps);    // 会话 CRUD / 消息 / 批量删除
  registerChatRoutes(app, deps);       // 对话（SSE）+ 断点
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
}
