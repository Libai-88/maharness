/**
 * server/index.ts —— HTTP 服务入口
 * 启动内核 → 注册路由 → 静态托管前端（ui/dist，生产）→ 监听端口。
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { Kernel } from '../kernel';
import { Store } from './db';
import { registerRoutes, refreshChatProviders } from './routes';
import { discoverProviders } from '../core/chat/provider';

const rootDir = process.env.AGENT_ROOT ?? process.cwd();
const port = Number(process.env.PORT ?? 3000);

/** DB 为空时从 .env 首次导入 Provider；之后以 DB 为唯一来源 */
function seedProviders(store: Store): void {
  if (store.listProviders().length > 0) return;
  const envCfgs = discoverProviders();
  for (const c of envCfgs) {
    store.upsertProvider({
      id: c.id, label: c.id.toUpperCase(),
      baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
      priceIn: c.inputPrice, priceOut: c.outputPrice,
    });
  }
  if (envCfgs.length) console.log(`[provider] 已从 .env 导入 ${envCfgs.length} 个供应商到本地数据库`);
}

export async function startServer(): Promise<{ kernel: Kernel; app: express.Express; server: ReturnType<express.Express['listen']> }> {
  const kernel = new Kernel(rootDir, { sandboxRoot: process.env.SANDBOX_ROOT ?? rootDir });
  await kernel.start();

  const store = new Store(kernel.paths.dbFile);
  seedProviders(store);
  refreshChatProviders(kernel, store); // 以 DB 配置热注入对话服务
  const app = express();
  registerRoutes(app, kernel, store);

  // 生产：托管前端构建产物（SPA fallback；/api 未命中仍走 404）
  const uiDist = join(rootDir, 'ui', 'dist');
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(join(uiDist, 'index.html'));
    });
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
