/**
 * server/index.ts —— HTTP 服务入口
 * 启动内核 → 注册路由 → 静态托管前端（ui/dist，生产）→ 监听端口。
 * 环境变量与插件文件一样支持热更新：监听 .env 变化 → 刷新 process.env → 重载全部插件。
 * 页面感知自动停止：前端唯一常驻连接（/api/events SSE）全部断开超过
 * AUTO_STOP_IDLE_MS（默认 30s，设 0 关闭）后优雅退出——「页面关了，后端就不该再跑」。
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync, watch } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Kernel } from '../kernel';
import { Store, DEFAULT_PERSONA, hasEncryptedProviderKeys } from './db';
import { resolveSecretKey } from './secrets';
import { registerRoutes, refreshChatProviders, refreshChatPersonas } from './routes';
import { isSafeWorkspaceRoot } from './routes/workspaces';
import { policyPosture } from './routes/rules';
import { approvalTokenRequired } from './routes/approvals';
import { discoverProviders } from '../core/chat/provider';
import { ClientTracker } from './client-tracker';
import { auditAuthorizationDenial, auditAuthorizationGrant, CredentialFailureLimiter, decideCredentialAuthorization } from './security-policy';
import { apiContractFor, setApiSchemaHeaders } from './api-contract';
import { validateAgainstSchema } from '../kernel/validate';

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

// ---- A6-b 变更类端点的可选 token 门 ----
/** 校验头名（前端接线时用同一个常量，避免拼写漂移） */
export const MUTATION_TOKEN_HEADER = 'x-maharness-token';
/** 需要显式授权的变更类方法（GET/HEAD 只读端点不受影响） */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function auditRouteObject(req: express.Request): string {
  const path = typeof req.path === 'string'
    ? req.path
    : typeof req.originalUrl === 'string'
      ? req.originalUrl.split('?', 1)[0]
      : '';
  const segments = path.split('/');
  return `/api/${segments[2] ?? segments[1] ?? ''}`;
}

/**
 * 当前生效的 API token。
 * **每次请求都读** process.env（不是启动快照）：与本项目「.env 改动即生效」的心智模型一致，
 * 也让运维可以经 .env 热更新开关这道门。空/未设 = 关闭。
 */
export function requiredApiToken(): string {
  return String(process.env.MAHARNESS_API_TOKEN ?? '').trim();
}

/** 常量时间比较（长度不等直接 false，避免逐字节早退把 token 长度/前缀做成侧信道） */
function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 中间件：变更类请求（POST/PATCH/PUT/DELETE，/api 前缀内）必须携带匹配头。
 *
 * 威胁模型边界（必须讲清，否则这道门会被误解成「鉴权」）：
 *  · 本服务只绑 127.0.0.1，挡的是局域网/外网；Host+Origin 挡的是浏览器跨源页面。
 *    剩下的敞口是**本机任意进程**——它可以直接读写工作区文件、直接改 data/rules.json，
 *    所以「有了 token 就安全」是假的：同用户身份的进程本就能读到这个 env 与数据目录。
 *  · token 的真实意义是把「改变 agent 行为与审批语义」这件事变成需要显式授权：
 *    无意图的本机进程（其它工具、脚本、被注入的插件、端口扫描）不再能一次 HTTP
 *    调用就批准危险命令、把沙箱根切到盘符根、或注入 {tool:"*",effect:"allow"}。
 *    这是**抬高门槛**，不是隔离边界——真正的隔离边界是 OS 用户/文件权限。
 *  · 未设置 MAHARNESS_API_TOKEN 时完全放行，保持既有本机免鉴权用法（不破坏现有使用方式）。
 *  · 注册位置：Host/Origin 校验之后、业务路由与插件 API 之前（含 /api/plugins/*）。
 *  · 前端接线（设置后由页面自动带上该头）需要改 ui/（api.ts 单点 + 页面注入 token），
 *    属另一条改造；本门默认关闭即不影响现有前端。
 */
export function createApiTokenGuard(
  kernel?: Kernel,
  store?: Store,
  limiter: CredentialFailureLimiter = new CredentialFailureLimiter(),
): express.RequestHandler {
  return (req, res, next) => {
    const expected = requiredApiToken();
    const method = String(req.method ?? '').toUpperCase();
    if (!MUTATING_METHODS.has(method)) return next();
    const auditObject = auditRouteObject(req);
    if (!expected) {
      if (kernel) auditAuthorizationGrant(kernel, {
        subject: 'local-client', capability: `http:${method.toLowerCase()}`, object: auditObject,
      }, store);
      return next(); // 本机免 token 模式仍记录通过来源校验的变更
    }
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientKey = req.socket?.remoteAddress
      ?? req.ip
      ?? (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
      ?? 'unknown';
    const retryAfter = limiter.retryAfterMs(clientKey);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter / 1000)));
      return res.status(429).json({ error: '凭据失败次数过多，请稍后重试' });
    }
    const raw = req.headers[MUTATION_TOKEN_HEADER] ?? req.headers.authorization;
    const one = Array.isArray(raw) ? raw[0] : raw;
    const bearer = typeof one === 'string' ? /^Bearer\s+(.+)$/i.exec(one.trim()) : null;
    const provided = bearer ? bearer[1].trim() : (typeof one === 'string' ? one.trim() : '');
    const decision = decideCredentialAuthorization({
      enabled: true,
      supplied: !!provided,
      valid: tokenMatches(provided, expected),
    });
    if (decision.allowed) {
      limiter.recordSuccess(clientKey);
      if (expected && provided && kernel) auditAuthorizationGrant(kernel, {
        subject: 'api-token', capability: `http:${method.toLowerCase()}`,
        object: auditObject,
      }, store);
      return next();
    }
    // 不回显期望值、不区分「没带」与「带错」的细节（只说需要哪个头），避免给探测者提示
    if (kernel) auditAuthorizationDenial(kernel, {
      subject: 'anonymous', capability: `http:${method.toLowerCase()}`,
      object: req.route?.path ? `${req.baseUrl}${req.route.path}` : auditObject,
      reason: decision.reason === 'invalid' ? 'api-token-invalid' : 'api-token-required',
    }, store);
    if (decision.reason === 'invalid') limiter.recordFailure(clientKey);
    return res.status(401).json({
      error: `未授权：服务端已启用 MAHARNESS_API_TOKEN，变更类请求必须携带 ${MUTATION_TOKEN_HEADER} 头`,
    });
  };
}

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

export async function startServer(): Promise<{ kernel: Kernel; app: express.Express; server: ReturnType<express.Express['listen']>; tracker: ClientTracker; store: Store; closeEnvWatcher: () => void }> {
  // 数据目录/用户插件目录可经环境变量覆盖（AGENT_DATA_DIR / AGENT_USER_PLUGINS_DIR）：
  // selftest 等嵌入场景用临时目录隔离，不污染生产 DB；不设置时与默认行为完全一致。
  const kernel = new Kernel(rootDir, { sandboxRoot: process.env.SANDBOX_ROOT ?? rootDir }, {
    dataDir: process.env.AGENT_DATA_DIR || undefined,
    userPluginsDir: process.env.AGENT_USER_PLUGINS_DIR || undefined,
  });
  await kernel.start();

  // 凭据加密：data/secret.key 主密钥；api_key 加密落库，读取时解密。
  // A7-3：主密钥缺失/异常时不再静默重建——先问「库里是否已有 v1: 密文」（只在异常分支才查，
  // 正常路径零额外开销），有密文则按 resolveSecretKey 的策略处理（缺失→生成并显式告警；
  // 异常→保留原文件、本次不带密钥），把旧密文作废这件事从「静默」变成「必须有人说话」。
  const keyInfo = resolveSecretKey(kernel.paths.data, {
    hasExistingCiphertext: () => hasEncryptedProviderKeys(kernel.paths.dbFile),
  });
  if (keyInfo.state !== 'ok') {
    // created（首启）用 log；其余状态都是「用户必须知道」的故障，用 error 级
    const line = `[secret] ${keyInfo.path}：${keyInfo.message}`;
    if (keyInfo.state === 'created') console.log(line);
    else console.error(`[secret] 主密钥异常（${keyInfo.state}）—— ${line}`);
  }
  const store = new Store(kernel.paths.dbFile, {
    secretKey: keyInfo.key,
    masterKey: keyInfo,
    checkpointRetentionMs: kernel.config.get<number>('checkpoint.retentionDays', 30) * 24 * 60 * 60 * 1000,
  });
  seedDefaults(store);
  // A7-2：把「密钥不可解」的既成事实打出来（Store 读一遍即完成记账），
  // 否则用户只在真实请求 401 时才发现，归因会指向供应商而不是本机密钥文件。
  {
    const ks = store.keyStatus();
    if (!ks.hasMasterKey && ks.hasCiphertext) {
      console.error(`[secret] 本次运行没有可用主密钥：${ks.broken.length} 个供应商的密钥无法解密，`
        + '请在设置页重新录入，或恢复 data/secret.key 后重启（详见 /api/security）');
    } else if (ks.broken.length) {
      console.error(`[secret] ${ks.broken.length} 个供应商的 api_key 不可解：`
        + ks.broken.map((b) => `${b.id}(${b.reason})`).join(', ') + ' —— 请在设置页重新录入');
    }
  }
  // 种子工作区：当前沙箱根目录始终可选（沙箱可切换，切换后工具边界随之热更新）
  // A6-2：危险根（盘符根/家目录及其祖先/系统目录）不作为工作区登记——连种子也不放过，
  // 否则 .env 里写错 SANDBOX_ROOT=C:\ 会绕过 HTTP 校验直接把保护名单基座打掉。
  const sandbox = kernel.config.get<string>('sandboxRoot', rootDir);
  if (!store.listWorkspaces().some((w) => w.path === sandbox)) {
    if (isSafeWorkspaceRoot(sandbox)) store.addWorkspace(sandbox);
    else console.warn(`[seed] 已跳过危险的 SANDBOX_ROOT 工作区登记：${sandbox}（文件系统根/家目录/系统目录不可作为工作区）`);
  }
  refreshChatProviders(kernel, store); // 以 DB 配置热注入对话服务
  refreshChatPersonas(kernel, store);  // 以 DB 人设热注入对话服务
  const app = express();

  // API-01：统一错误外壳。保留既有 `error` 文案，补充可机器消费的版本、状态和错误码。
  // 通过包装 res.json 覆盖拆分路由，避免每个资源路由各自维护一套错误格式。
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    setApiSchemaHeaders(res);
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode < 400) {
        const contract = apiContractFor(req.method, req.path);
        let schema = contract?.schema;
        if (!schema && req.path.startsWith('/api/plugins/')) {
          const [, , , pluginId, ...parts] = req.path.split('/');
          const api = kernel.plugins.get(pluginId)?.caps.find((cap) => cap.kind === 'api');
          if (api?.kind === 'api') schema = api.api.responses?.[`${req.method} /${parts.slice(1).join('/')}`];
        }
        if (schema) {
          const issues = validateAgainstSchema(body, schema);
          if (issues.length) {
            res.statusCode = 500;
            body = { schemaVersion: 1, ok: false, code: 'response_schema_invalid', error: '响应不符合已登记的 API schema', issues };
          }
        }
      }
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
        const value = body as Record<string, unknown>;
        if (typeof value.error === 'string' && value.schemaVersion === undefined) {
          const codeByStatus: Record<number, string> = {
            400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 428: 'precondition_required',
            404: 'not_found', 409: 'conflict', 429: 'rate_limited',
            500: 'internal_error', 503: 'service_unavailable',
          };
          body = { schemaVersion: 1, ok: false, code: codeByStatus[res.statusCode] ?? 'request_failed', ...value };
        }
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

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
      auditAuthorizationDenial(kernel, {
        subject: 'anonymous', capability: `http:${String(req.method).toLowerCase()}`,
        object: `/api/${req.path.split('/')[2] ?? ''}`, reason: 'source-host-denied',
      }, store);
      return res.status(403).json({ error: 'Forbidden: Host 头不在本机白名单' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      auditAuthorizationDenial(kernel, {
        subject: 'anonymous', capability: `http:${String(req.method).toLowerCase()}`,
        object: `/api/${req.path.split('/')[2] ?? ''}`, reason: 'source-origin-denied',
      }, store);
      return res.status(403).json({ error: 'Forbidden: Origin 不在白名单' });
    }
    next();
  });

  // ---- A6-b 变更类端点的可选 token 门（紧跟 Host/Origin 之后、业务路由之前）----
  // 覆盖 /api/*（含下方插件 API 挂载点 /api/plugins/*），GET/HEAD 只读不受影响。
  // 未设 MAHARNESS_API_TOKEN 时逐请求透传 = 现有本机免鉴权行为不变。
  // 威胁模型与边界见 createApiTokenGuard 注释：这是「显式授权」门槛，不是进程隔离边界。
  app.use('/api', createApiTokenGuard(kernel, store));

  // ---- A6/A7 安全姿态只读端点：把「当前哪些门是开着的、密钥是否可用」说清楚 ----
  // 只读、无副作用、不含任何密钥材料（token / api_key / secret.key 一律不外泄）。
  // 前端接线（横幅）从这里取真实故障口径，而不是靠 401 反推。
  app.get('/api/security', (_req, res) => {
    const tokenRequired = requiredApiToken().length > 0;
    const broken = store.keyStatus();
    res.json({
      bind: '127.0.0.1',
      // 变更类端点是否需要 x-maharness-token
      mutationAuthRequired: tokenRequired,
      mutationTokenHeader: MUTATION_TOKEN_HEADER,
      // 审批一次性凭据是否强制（见 routes/approvals.ts 的 A6-1 说明）
      approvalTokenRequired: approvalTokenRequired(),
      masterKey: {
        state: keyInfo.state,
        available: !!keyInfo.key,
        path: keyInfo.path,
        message: keyInfo.message,
        backupPath: keyInfo.backupPath ?? null,
      },
      credentials: broken,
      // A6-3：当前策略是否已把全部工具的审批门整体放行（rules 服务不可用时 available:false）
      policy: policyPosture(kernel),
    });
  });

  app.get('/api/security/audit', (req, res) => {
    const rawLimit = Number(req.query.limit ?? 100);
    res.json({ events: store.listAuthorizationAudit(Number.isFinite(rawLimit) ? rawLimit : 100) });
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
    const router = api.api.router as unknown as (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
    // 异步插件 router 的 rejected Promise 必须显式交给 Express 错误中间件——
    // 手工分发调用链下 Express 不会自动捕获（否则未处理 rejection + 请求悬挂）
    try {
      const ret = router(req, res, next);
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
        (ret as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  });

  // 未命中的 API 也使用同一错误契约；非 API 请求继续交给静态托管/SPA fallback。
  app.use('/api', (_req, res, next) => {
    if (res.headersSent) return next();
    res.status(404).json({ error: '接口不存在' });
  });

  // 兜底错误处理：handler 异常返回 500 而非进程崩溃（安装/卸载/文件操作等异步路径）
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] 请求处理异常:', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
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
  let envWatcher: ReturnType<typeof watch> | null = null;
  /** 关闭 .env 监听（watcher + 防抖定时器）——嵌入场景（selftest/测试）多次
   *  start/stop 需要显式清理，否则 watcher 句柄持续存在并保持事件循环存活 */
  const closeEnvWatcher = () => {
    if (envTimer) { clearTimeout(envTimer); envTimer = null; }
    try { envWatcher?.close(); } catch { /* 忽略 */ }
    envWatcher = null;
  };
  // 上次 .env 解析快照（diff 用）：首帧读不到（文件不存在）也不报错
  let lastEnv: Record<string, string> = {};
  try {
    lastEnv = dotenv.parse(readFileSync(envPath, 'utf-8'));
  } catch { /* .env 尚不存在：以空快照起步 */ }
  try {
    envWatcher = watch(envDir, (_event, filename) => {
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
    // 监听句柄不钉住事件循环（B16 防御）：句柄照常派发事件，但嵌入方（selftest / 测试 /
    // 未来 CLI）若忘记 closeEnvWatcher，也不会导致「跑完了却退不出去」。
    envWatcher?.unref?.();
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
  return { kernel, app, server, tracker, store, closeEnvWatcher };
}

// 直接运行（tsx server/index.ts）
// L4：精确比较入口模块（includes 会把「路径恰好包含该子串的模块」误判为入口，
// 如通过另一个文件 import 本模块且其路径包含 argv[1] 片段时）
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { server, kernel, tracker, closeEnvWatcher, store } = await startServer();
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n 正在关闭…');
      server.close();
      closeEnvWatcher();
      await kernel.stop();
      store.close(); // SQLite/WAL 句柄释放（Windows 下不关会阻止文件清理/重启）
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
