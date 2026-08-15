/**
 * server/index.ts —— HTTP 服务入口
 * 启动内核 → 注册路由 → 静态托管前端（ui/dist，生产）→ 监听端口。
 * 环境变量与插件文件一样支持热更新：监听 .env 变化 → 刷新 process.env → 重载全部插件。
 * 页面感知自动停止：前端唯一常驻连接（/api/events SSE）全部断开超过
 * AUTO_STOP_IDLE_MS（默认 30s，设 0 关闭）后优雅退出——「页面关了，后端就不该再跑」。
 */
import dotenv from 'dotenv';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { Kernel } from '../kernel';
import { Store, DEFAULT_PERSONA } from './db';
import { registerRoutes, refreshChatProviders, refreshChatPersonas } from './routes';
import { discoverProviders } from '../core/chat/provider';
import { ClientTracker } from './client-tracker';

dotenv.config(); // 启动时读取 .env（初始快照）

const rootDir = process.env.AGENT_ROOT ?? process.cwd();
const port = Number(process.env.PORT ?? 3000);

/** DB 为空时从 .env 首次导入 Provider、写入默认人设；之后以 DB 为唯一来源 */
function seedDefaults(store: Store): void {
  if (store.listProviders().length === 0) {
    const envCfgs = discoverProviders();
    for (const c of envCfgs) {
      store.upsertProvider({
        id: c.id, label: c.id.toUpperCase(),
        baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
        priceIn: c.inputPrice, priceOut: c.outputPrice,
      });
    }
    if (envCfgs.length) console.log(`[seed] 已从 .env 导入 ${envCfgs.length} 个供应商到本地数据库`);
  }
  if (store.listPersonas().length === 0) {
    store.upsertPersona({ id: DEFAULT_PERSONA.id, name: DEFAULT_PERSONA.name, content: DEFAULT_PERSONA.content, sortOrder: 0 });
    console.log('[seed] 已写入默认人设（可在网页端「设置」编辑）');
  }
}

export async function startServer(): Promise<{ kernel: Kernel; app: express.Express; server: ReturnType<express.Express['listen']>; tracker: ClientTracker }> {
  const kernel = new Kernel(rootDir, { sandboxRoot: process.env.SANDBOX_ROOT ?? rootDir });
  await kernel.start();

  const store = new Store(kernel.paths.dbFile);
  seedDefaults(store);
  // 种子工作区：当前沙箱根目录始终可选（沙箱可切换，切换后工具边界随之热更新）
  const sandbox = kernel.config.get<string>('sandboxRoot', rootDir);
  if (!store.listWorkspaces().some((w) => w.path === sandbox)) store.addWorkspace(sandbox);
  refreshChatProviders(kernel, store); // 以 DB 配置热注入对话服务
  refreshChatPersonas(kernel, store);  // 以 DB 人设热注入对话服务
  const app = express();
  const tracker = new ClientTracker(); // 前端页面存活跟踪（/api/events 连接登记）
  registerRoutes(app, kernel, store, tracker);

  // ---- 插件 API 能力：前端是插件的一部分的数据通道 ----
  // 动态分发（每次请求取当前插件实例）——插件热重载后新路由立即生效，无需重启。
  // 路径约定：/api/plugins/<pluginId>/<mount>/...；插件提供的 GET /panel 会渲染为前端插件面板。
  app.use('/api/plugins/:pluginId', (req, res, next) => {
    const inst = kernel.plugins.get(req.params.pluginId);
    const api = inst?.caps.find((c) => c.kind === 'api');
    if (!inst || !api || api.kind !== 'api') {
      return res.status(404).json({ error: '插件不存在或未提供 API 能力' });
    }
    const router = api.api.router as unknown as (req: express.Request, res: express.Response, next: express.NextFunction) => void;
    router(req, res, next);
  });

  // 兜底错误处理：handler 异常返回 500 而非进程崩溃（安装/卸载/文件操作等异步路径）
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] 请求处理异常:', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  // 生产：托管前端构建产物（SPA fallback；/api 未命中仍走 404）
  const uiDist = join(rootDir, 'ui', 'dist');
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(join(uiDist, 'index.html'));
    });
  }

  // ---- .env 热更新：环境变量与插件文件走同一心智模型（改动即生效） ----
  // 第一性原理：API key 等配置与代码一样是「可变化的输入」，不应只活在启动快照里。
  // 监听 .env → override 刷新 process.env → 重载全部插件（search 等插件重新读取新 key）。
  const envPath = join(process.cwd(), '.env');
  let envTimer: NodeJS.Timeout | null = null;
  if (existsSync(envPath)) {
    try {
      watch(envPath, () => {
        if (envTimer) clearTimeout(envTimer);
        envTimer = setTimeout(() => {
          dotenv.config({ override: true }); // 重新读取 .env 覆盖旧值
          console.log('[env] .env 已变更，刷新环境变量并热重载全部插件');
          void kernel.plugins.reloadAll();
        }, 500);
      });
      console.log(`[env] 监听 ${envPath}（.env 变更将热重载插件）`);
    } catch (err) {
      console.warn('[env] .env 监听不可用（改动后需重启生效）:', err instanceof Error ? err.message : String(err));
    }
  }

  const server = app.listen(port, () => {
    console.log(`\n  Web Agent 已启动: http://localhost:${port}`);
    console.log(`  沙箱根目录: ${kernel.config.get<string>('sandboxRoot', kernel.rootDir)}\n`);
  });
  server.on('error', (err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
  return { kernel, app, server, tracker };
}

// 直接运行（tsx server/index.ts）
if (process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  const { server, kernel, tracker } = await startServer();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n 正在关闭…');
    server.close();
    await kernel.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ---- 页面感知自动停止：前端页面（/api/events 常驻连接）全部关闭后优雅退出 ----
  // 每 5s 检查一次「最后一个页面关闭后的空闲时长」，超过阈值（AUTO_STOP_IDLE_MS，默认
  // 30s，设 0 关闭）即停止。宽限期覆盖：刷新页面/网络抖动/EventSource 自动重连。
  // 阈值从 process.env 动态读取——.env 热更新后下次检查即生效，无需重启。
  const defaultIdle = Number(process.env.AUTO_STOP_IDLE_MS ?? 30_000);
  const idleTimer = setInterval(() => {
    if (shuttingDown) return;
    const limit = Number(process.env.AUTO_STOP_IDLE_MS ?? defaultIdle);
    if (!(limit > 0)) return; // 0/负值 = 关闭自动停止
    const idle = tracker.idleMs();
    if (idle > limit) {
      console.log(`\n[server] 前端页面已关闭 ${Math.round(idle / 1000)}s（阈值 ${Math.round(limit / 1000)}s），后端自动停止`);
      void shutdown();
    }
  }, 5000);
  // 随进程退出清理（selftest 等场景 startServer 后不依赖此定时器）
  idleTimer.unref();
}
