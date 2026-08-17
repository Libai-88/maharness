/**
 * server/index.ts —— HTTP 服务入口
 * 启动内核 → 注册路由 → 静态托管前端（ui/dist，生产）→ 监听端口。
 * 环境变量与插件文件一样支持热更新：监听 .env 变化 → 刷新 process.env → 重载全部插件。
 * 页面感知自动停止：前端唯一常驻连接（/api/events SSE）全部断开超过
 * AUTO_STOP_IDLE_MS（默认 30s，设 0 关闭）后优雅退出——「页面关了，后端就不该再跑」。
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync, watch } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Kernel } from '../kernel';
import { Store, DEFAULT_PERSONA } from './db';
import { registerRoutes, refreshChatProviders, refreshChatPersonas } from './routes';
import { discoverProviders } from '../core/chat/provider';
import { ClientTracker } from './client-tracker';

dotenv.config(); // 启动时读取 .env（初始快照）

const rootDir = process.env.AGENT_ROOT ?? process.cwd();
const port = Number(process.env.PORT ?? 3000);

// ---- M3 活跃 run 计数：自动停止感知正在执行的 chat run ----
// 「页面关闭」≠「可以停止」：run 进行中（LLM 流式/工具执行）时自动停止会腰斩任务。
// routes 包裹 chat 端点调用 beginRun/endRun（导出供其 import）；
// 自动停止 tick 在 activeRuns > 0 时只重置空闲基准，等 run 结束再计宽限期。
let activeRuns = 0;
export function beginRun(): void { activeRuns++; }
export function endRun(): void { activeRuns = Math.max(0, activeRuns - 1); }
export function activeRunCount(): number { return activeRuns; }

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

export async function startServer(): Promise<{ kernel: Kernel; app: express.Express; server: ReturnType<express.Express['listen']>; tracker: ClientTracker; store: Store }> {
  // 数据目录/用户插件目录可经环境变量覆盖（AGENT_DATA_DIR / AGENT_USER_PLUGINS_DIR）：
  // selftest 等嵌入场景用临时目录隔离，不污染生产 DB；不设置时与默认行为完全一致。
  const kernel = new Kernel(rootDir, { sandboxRoot: process.env.SANDBOX_ROOT ?? rootDir }, {
    dataDir: process.env.AGENT_DATA_DIR || undefined,
    userPluginsDir: process.env.AGENT_USER_PLUGINS_DIR || undefined,
  });
  await kernel.start();

  const store = new Store(kernel.paths.dbFile);
  seedDefaults(store);
  // 种子工作区：当前沙箱根目录始终可选（沙箱可切换，切换后工具边界随之热更新）
  const sandbox = kernel.config.get<string>('sandboxRoot', rootDir);
  if (!store.listWorkspaces().some((w) => w.path === sandbox)) store.addWorkspace(sandbox);
  refreshChatProviders(kernel, store); // 以 DB 配置热注入对话服务
  refreshChatPersonas(kernel, store);  // 以 DB 人设热注入对话服务
  const app = express();

  // ---- C-S1 监听与请求校验（最高优先：防 DNS rebinding / 跨源滥用）----
  // 本服务是「本机个人的 Agent harness」，只服务本机浏览器与同机工具：
  //  (a) 只绑定回环地址，杜绝局域网直连；
  //  (b) Host 头必须精确匹配本机回环主机名+端口——DNS rebinding 把域名解析到
  //      127.0.0.1 后，攻击页发出的请求 Host 是攻击者域名，此处直接 403；
  //  (c) Origin 头存在时必须在白名单（同源前端 + Vite 开发服务器）；
  //      无 Origin（curl / 同机非浏览器工具）放行。
  // 必须注册在所有路由之前（含下方插件 API 与静态托管）。
  const allowedHosts = new Set([
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
  ]);
  const devOriginPort = process.env.DEV_ORIGIN_PORT ?? '5173';
  const allowedOrigins = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    `http://localhost:${devOriginPort}`, `http://127.0.0.1:${devOriginPort}`,
  ]);
  app.use((req, res, next) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return res.status(403).json({ error: 'Forbidden: Host 头不在本机白名单' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Forbidden: Origin 不在白名单' });
    }
    next();
  });

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
  // 监听 .env → diff 出变化的 key → bumpEnv（env 依赖版本递增 + 订阅者即时通知）→
  // reloadChanged 只重载声明了 watchEnv 的插件（v3.1 修复：旧实现签名无 env 分量，
  // reloadChanged 永远返回空——.env 变更实际不生效）。
  // L3：监听其所在目录而非单文件——Windows 编辑器普遍以「临时文件 + 重命名」保存，
  // 重命名后旧的文件级 watch 句柄失效（后续保存不再触发）；目录级监听 +
  // filename === '.env' 过滤在任何保存方式下都稳定，且 .env 不存在时也能感知创建。
  const envPath = join(process.cwd(), '.env');
  const envDir = dirname(envPath);
  let envTimer: NodeJS.Timeout | null = null;
  // 上次 .env 解析快照（diff 用）：首帧读不到（文件不存在）也不报错
  let lastEnv: Record<string, string> = {};
  try {
    lastEnv = dotenv.parse(readFileSync(envPath, 'utf-8'));
  } catch { /* .env 尚不存在：以空快照起步 */ }
  try {
    watch(envDir, (_event, filename) => {
      if (filename !== '.env') return;
      if (envTimer) clearTimeout(envTimer);
      envTimer = setTimeout(() => {
        let parsed: Record<string, string>;
        try {
          parsed = dotenv.parse(readFileSync(envPath, 'utf-8'));
        } catch {
          parsed = {}; // .env 被删除/暂不可读：视为全部 key 清空
        }
        // diff 变化 key（含新增/删除）：只 bump 真正变化的，避免无谓重载
        const changed = [...new Set([...Object.keys(parsed), ...Object.keys(lastEnv)])]
          .filter((k) => parsed[k] !== lastEnv[k]);
        lastEnv = parsed;
        if (!changed.length) return;
        dotenv.config({ override: true }); // 重新读取 .env 覆盖旧值
        console.log(`[env] .env 已变更（${changed.join(', ')}），刷新环境变量并热重载受影响插件`);
        // v3.1 依赖驱动智能重载：env 依赖版本递增 → 只重载声明了 watchEnv 的插件
        kernel.plugins.bumpEnv(changed);
        void kernel.plugins.reloadChanged()
          .then((changedIds) => {
            if (changedIds.length) console.log(`[env] 已重载依赖变化的插件: ${changedIds.join(', ')}`);
          })
          .catch(() => undefined);
      }, 500);
    });
    console.log(`[env] 监听 ${envDir}（.env 变更将热重载插件）`);
  } catch (err) {
    console.warn('[env] .env 监听不可用（改动后需重启生效）:', err instanceof Error ? err.message : String(err));
  }

  // C-S1：仅绑定回环地址——本机个人服务不对局域网/外网暴露
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`\n  Web Agent 已启动: http://localhost:${port}`);
    console.log(`  沙箱根目录: ${kernel.config.get<string>('sandboxRoot', kernel.rootDir)}\n`);
  });
  // L6 监听失败（端口占用等）以 reject 呈现给调用方——嵌入场景（selftest）可在
  // finally 中清理资源后优雅退出，而不是被 process.exit 直接击穿。
  await new Promise<void>((resolve, reject) => {
    const onListening = () => { detach(); resolve(); };
    const onError = (err: Error) => { detach(); reject(err); };
    const detach = () => { server.off('listening', onListening); server.off('error', onError); };
    server.on('listening', onListening);
    server.on('error', onError);
  });
  // 监听成功后的运行期错误：记录不退出（进程存活状态由入口直跑场景的退出码体现）
  server.on('error', (err) => console.error('[server] 运行期错误:', err.message));
  return { kernel, app, server, tracker, store };
}

// 直接运行（tsx server/index.ts）
// L4：精确比较入口模块（includes 会把「路径恰好包含该子串的模块」误判为入口，
// 如通过另一个文件 import 本模块且其路径包含 argv[1] 片段时）
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
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
      // M3：活跃 run 期间不允许自动停止——只重置空闲基准（不清除计时、不中断 run），
      // run 结束（endRun 后 activeRuns 归零）再重新起算宽限期；长任务不被「页面关闭」腰斩。
      if (activeRuns > 0) {
        tracker.resetIdle();
        return;
      }
      const idle = tracker.idleMs();
      if (idle > limit) {
        console.log(`\n[server] 前端页面已关闭 ${Math.round(idle / 1000)}s（阈值 ${Math.round(limit / 1000)}s），后端自动停止`);
        void shutdown();
      }
    }, 5000);
    // 随进程退出清理（selftest 等场景 startServer 后不依赖此定时器）
    idleTimer.unref();
  } catch (err) {
    // L6：startServer reject（端口占用等）——CLI 直跑场景维持非零退出码
    console.error('启动失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
