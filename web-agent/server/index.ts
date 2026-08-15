/**
 * server/index.ts —— HTTP 服务入口
 * 启动内核 → 注册路由 → 静态托管前端（ui/dist，生产）→ 监听端口。
 * 环境变量与插件文件一样支持热更新：监听 .env 变化 → 刷新 process.env → 重载全部插件。
 */
import dotenv from 'dotenv';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { Kernel } from '../kernel';
import { Store, DEFAULT_PERSONA } from './db';
import { registerRoutes, refreshChatProviders, refreshChatPersonas } from './routes';
import { discoverProviders } from '../core/chat/provider';

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

export async function startServer(): Promise<{ kernel: Kernel; app: express.Express; server: ReturnType<express.Express['listen']> }> {
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
  registerRoutes(app, kernel, store);

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
  return { kernel, app, server };
}

// 直接运行（tsx server/index.ts）
if (process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  const { server, kernel } = await startServer();
  const shutdown = async () => {
    console.log('\n 正在关闭…');
    server.close();
    await kernel.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
