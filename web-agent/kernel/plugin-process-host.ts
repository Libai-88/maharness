/**
 * 插件子进程宿主：只做三件事——加载入口、把 ctx 代理回父进程、执行工具 handler。
 *
 * 这是「进程边界」而不是「安全沙箱」：子进程仍有 Node 的全部能力，
 * 真正的权限收敛仍由加载前源码审查、manifest runtime 声明与 OS 账户/容器负责。
 * 进程边界解决的是崩溃隔离、生命周期回收、环境变量最小透传与可强杀超时。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CacheLike, ConfigLike, EventListener, Logger, PathsLike, Plugin, PluginBus, PluginContext,
  PluginStorage, StepHandle, ToolContext, ToolDef, ToolResult, TraceLike,
} from './types';
import type { HostToParent, ParentToHost, ProcessToolDescriptor } from './plugin-process-protocol';
import { installNetworkGuard } from './plugin-network';
import { installFilesystemGuard } from './plugin-fs-guard';
import { createSecretBox } from './secret-box';

type Send = (message: HostToParent) => void;

const send: Send = (message) => {
  if (process.send) process.send(message);
};

let childCtx: {
  pluginId: string;
  plugin: Plugin;
  context: PluginContext;
  handlers: Map<string, ToolDef['handler']>;
  descriptors: Map<string, ProcessToolDescriptor>;
  controllers: Map<number, AbortController>;
  listeners: Map<number, EventListener>;
  inverses: (() => void | Promise<void>)[];
} | undefined;

function configGet(snapshot: Record<string, unknown>, key: string, def?: unknown): unknown {
  let value: unknown = snapshot;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return def;
    value = (value as Record<string, unknown>)[part];
  }
  return value === undefined ? def : value;
}

function makeConfig(snapshot: Record<string, unknown>): ConfigLike {
  return {
    get: <T,>(key: string, def?: T) => configGet(snapshot, key, def) as T,
    set: () => { throw new Error('process 插件不支持写配置，请通过设置页或父进程配置变更'); },
    section: (id: string) => {
      const value = configGet(snapshot, id, {});
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    },
    watch: () => () => undefined,
  };
}

function makeStorage(dir: string, maxBytes: number, maxFiles: number): PluginStorage {
  mkdirSync(dir, { recursive: true });
  const at = (name: string): string => join(dir, basename(name));
  const usage = (): { bytes: number; files: number } => {
    let bytes = 0;
    let files = 0;
    for (const name of readdirSync(dir)) {
      try {
        const stat = statSync(join(dir, name));
        if (stat.isFile()) { files++; bytes += stat.size; }
      } catch { /* 忽略瞬时消失 */ }
    }
    return { bytes, files };
  };
  return {
    dir,
    read(name) {
      const file = at(name);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    write(name, content) {
      const file = at(name);
      const current = usage();
      const exists = existsSync(file);
      const previous = exists ? statSync(file).size : 0;
      const nextBytes = current.bytes - previous + Buffer.byteLength(content, 'utf8');
      if (maxFiles > 0 && !exists && current.files + 1 > maxFiles) {
        throw new Error(`插件私有存储文件数超出配额（${maxFiles}）`);
      }
      if (maxBytes > 0 && nextBytes > maxBytes) {
        throw new Error(`插件私有存储字节数超出配额（${maxBytes}）`);
      }
      writeFileSync(file, content, 'utf8');
    },
    list() {
      return readdirSync(dir).filter((name) => {
        try { return statSync(join(dir, name)).isFile(); } catch { return false; }
      });
    },
    remove(name) {
      rmSync(at(name), { force: true });
    },
  };
}

function makeCache(): CacheLike {
  const l2 = new Map<string, { value: unknown; expiresAt: number; createdAt: number; hits: number }>();
  const stats = {
    l2Hits: 0, l2Misses: 0, l1Hits: 0, l1Misses: 0,
    l3Hits: 0, l3Tokens: 0, l3RealHits: 0, l3RealTokens: 0, l3RealMissTokens: 0, savedCost: 0,
  };
  return {
    l2Get(key) {
      const entry = l2.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        if (entry) l2.delete(key);
        stats.l2Misses++;
        return { hit: false };
      }
      entry.hits++;
      stats.l2Hits++;
      return {
        hit: true, value: entry.value,
        meta: {
          key, namespace: key.split(':', 1)[0] ?? '', createdAt: entry.createdAt,
          ageMs: Date.now() - entry.createdAt, ttlRemainingMs: Math.max(0, entry.expiresAt - Date.now()), hits: entry.hits,
        },
      };
    },
    l2Set(key, value, ttlMs = 30 * 60_000) {
      const now = Date.now();
      l2.set(key, { value, createdAt: now, expiresAt: now + ttlMs, hits: 0 });
    },
    l2Delete(key) { l2.delete(key); },
    l2DeleteNamespace(ns) {
      for (const key of l2.keys()) if (key.startsWith(`${ns}:`)) l2.delete(key);
    },
    makeKey(parts, scope) {
      const ns = parts[0] ?? '';
      const scoped = scope?.tenantId ? [ns, `tenant:${scope.tenantId}`, ...parts.slice(1)] : parts;
      return `${ns}:${createHash('sha256').update(JSON.stringify(scoped)).digest('hex').slice(0, 32)}`;
    },
    setEmbeddingFn() { /* 子进程内不共享父进程 embedding */ },
    async l1Get() { stats.l1Misses++; return { hit: false }; },
    async l1Set() { /* 子进程内 L1 不参与语义缓存 */ },
    l1InvalidateSession() { /* 子进程内无 L1 条目 */ },
    recordPrefixRepeat() { /* 子进程内不统计 L3 */ },
    recordProviderCacheHit() { /* 子进程内不统计 L3 */ },
    recordSavedCost() { /* 子进程内不统计成本 */ },
    clear() { l2.clear(); },
    stats: () => ({ ...stats }),
  };
}

function makeTrace(): TraceLike {
  const noop: StepHandle = {
    id: 'process-noop',
    finish: () => undefined,
    fail: () => undefined,
    cancel: () => undefined,
  };
  return {
    startStep: () => noop,
    stats: () => ({
      steps: 0, llmCalls: 0, toolCalls: 0, cacheHits: 0,
      totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, writeFailures: 0,
    }),
  };
}

function makeBus(): PluginBus {
  const eventOf = (event: { type: string; data?: unknown; ts?: number; traceId?: string }) => ({
    type: event.type, data: event.data, ts: event.ts ?? Date.now(), traceId: event.traceId,
  });
  return {
    emit: (event) => send({ type: 'emit', event: eventOf(event) }),
    emitAsync: async (event) => { send({ type: 'emit', event: eventOf(event) }); },
    serial: async () => { throw new Error('process 插件不支持 serial 事件派发'); },
    bail: () => { throw new Error('process 插件不支持 bail 事件派发'); },
    parallel: async () => { throw new Error('process 插件不支持 parallel 事件派发'); },
    waterfall: async () => { throw new Error('process 插件不支持 waterfall 事件派发'); },
  };
}

function makeContext(opts: {
  pluginId: string;
  loadDir: string;
  storageDir: string;
  config: Record<string, unknown>;
  maxStorageBytes: number;
  maxStorageFiles: number;
}): PluginContext {
  let tokenSeq = 1;
  const logger: Logger = {
    info: (message, meta) => send({ type: 'log', level: 'info', message, meta }),
    warn: (message, meta) => send({ type: 'log', level: 'warn', message, meta }),
    error: (message, meta) => send({ type: 'log', level: 'error', message, meta }),
    debug: (message, meta) => send({ type: 'log', level: 'debug', message, meta }),
  };
  const paths: PathsLike = {
    root: opts.loadDir,
    data: opts.storageDir,
    traces: opts.storageDir,
    configFile: join(opts.loadDir, 'plugin.json'),
    dbFile: join(opts.storageDir, 'plugin.db'),
    cacheFile: join(opts.storageDir, 'cache.json'),
  };
  return {
    pluginId: opts.pluginId,
    get kernel(): never { throw new Error('process 插件不能直接访问内核对象'); },
    bus: makeBus(),
    config: makeConfig(opts.config),
    trace: makeTrace(),
    cache: makeCache(),
    secrets: createSecretBox(),
    paths,
    register(cap) {
      if (cap.kind !== 'tool') throw new Error('process 插件仅支持注册 tool 能力');
      const tool = cap.tool;
      if (tool.assessApproval) throw new Error('process 插件不支持动态 assessApproval，请在 manifest/ToolDef 上使用静态 approval');
      if (tool.invokesTools) throw new Error('PLUGIN_PROCESS_COMPOSITION_UNSUPPORTED: ToolContext.invoke 需要可信宿主执行模式');
      if (!childCtx) throw new Error('process 插件上下文尚未初始化');
      const descriptor: ProcessToolDescriptor = {
        version: tool.version,
        permissions: tool.permissions,
        name: tool.name, description: tool.description, parameters: tool.parameters,
        ...(tool.risk ? { risk: tool.risk } : {}),
        ...(tool.costHint ? { costHint: tool.costHint } : {}),
        ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
        ...(tool.limits ? { limits: tool.limits } : {}),
        ...(tool.output ? { output: tool.output } : {}),
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        ...(tool.idempotent !== undefined ? { idempotent: tool.idempotent } : {}),
        sideEffect: tool.sideEffect,
        ...(tool.retry ? { retry: tool.retry } : {}),
        outputSchema: tool.outputSchema,
      };
      childCtx.handlers.set(tool.name, tool.handler);
      childCtx.descriptors.set(tool.name, descriptor);
      send({ type: 'register', tool: descriptor });
      return () => {
        childCtx?.handlers.delete(tool.name);
        childCtx?.descriptors.delete(tool.name);
        send({ type: 'unregister', name: tool.name });
      };
    },
    on(event, listener, priority) {
      const token = tokenSeq++;
      childCtx?.listeners.set(token, listener);
      send({ type: 'subscribe', token, event, priority });
      return () => {
        childCtx?.listeners.delete(token);
        send({ type: 'unsubscribe', token });
      };
    },
    provide() { throw new Error('process 插件不支持服务提供'); },
    inject() { throw new Error('process 插件不支持服务注入'); },
    onCapabilities() { throw new Error('process 插件不支持能力集订阅'); },
    watchConfig() { throw new Error('process 插件不支持配置热更新订阅，请由父进程重载插件'); },
    configWith() { throw new Error('process 插件不支持 configWith'); },
    watchEnv() { return () => undefined; },
    async effect(fn, makeInverse) {
      const value = await fn();
      childCtx?.inverses.push(() => makeInverse(value)());
    },
    storage: makeStorage(opts.storageDir, opts.maxStorageBytes, opts.maxStorageFiles),
    outbound: { record: (record) => send({ type: 'outbound', record }) },
    logger,
  };
}

function normalizeResult(value: unknown): ToolResult {
  if (value && typeof value === 'object' && typeof (value as ToolResult).ok === 'boolean') return value as ToolResult;
  return { ok: true, data: value };
}

async function loadPlugin(message: Extract<ParentToHost, { type: 'load' }>): Promise<void> {
  if (message.runtime?.network) {
    installNetworkGuard({
      mode: message.runtime.network,
      allowlist: message.runtime.networkAllowlist,
    });
  }
  const url = pathToFileURL(join(message.loadDir, message.entry)).href;
  const mod = await import(url) as { default?: Plugin } & Plugin;
  // 文件守卫放在模块加载之后：Node 的模块解析会读取祖先 package.json，
  // 加载期就拦截会让合法插件无法解析依赖；onLoad 与工具执行仍全部受策略约束。
  if (message.runtime?.filesystem) {
    installFilesystemGuard({
      mode: message.runtime.filesystem,
      storageDir: message.storageDir,
      sandboxRoot: message.runtime.sandboxRoot,
      readOnlyRoots: [message.loadDir],
    });
  }
  const plugin = (mod.default ?? mod) as Plugin;
  if (!plugin || typeof plugin !== 'object') throw new Error('插件入口没有导出默认对象');

  const context = makeContext({
    pluginId: message.pluginId,
    loadDir: message.loadDir,
    storageDir: message.storageDir,
    config: message.config,
    maxStorageBytes: message.limits.maxStorageBytes ?? 0,
    maxStorageFiles: message.limits.maxStorageFiles ?? 0,
  });
  childCtx = {
    pluginId: message.pluginId,
    plugin,
    context,
    handlers: new Map(),
    descriptors: new Map(),
    controllers: new Map(),
    listeners: new Map(),
    inverses: [],
  };
  await plugin.onLoad?.(context);
  send({ type: 'ready', tools: [...childCtx.descriptors.values()] });
}

async function handleCall(message: Extract<ParentToHost, { type: 'call' }>): Promise<void> {
  const ctx = childCtx;
  if (!ctx) {
    send({ type: 'error', id: message.id, error: '插件尚未加载' });
    return;
  }
  const handler = ctx.handlers.get(message.tool);
  if (!handler) {
    send({ type: 'error', id: message.id, error: `工具不存在: ${message.tool}` });
    return;
  }
  const controller = new AbortController();
  ctx.controllers.set(message.id, controller);
  const tctx: ToolContext = {
    traceId: message.context.traceId,
    turn: message.context.turn,
    sessionId: message.context.sessionId,
    tenantId: message.context.tenantId,
    stepId: message.context.stepId,
    sandboxRoot: message.context.sandboxRoot,
    signal: controller.signal,
    cache: ctx.context.cache,
    trace: ctx.context.trace,
    approved: message.context.approved,
    approvalId: message.context.approvalId,
    policyApproved: message.context.policyApproved,
    model: message.context.model,
    providerId: message.context.providerId,
  };
  try {
    const value = await handler(message.args, tctx);
    send({ type: 'result', id: message.id, result: normalizeResult(value) });
  } catch (err) {
    send({ type: 'error', id: message.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    ctx.controllers.delete(message.id);
  }
}

async function shutdown(reason?: string): Promise<void> {
  const ctx = childCtx;
  childCtx = undefined;
  if (ctx) {
    try { await ctx.plugin.onStop?.(ctx.context); } catch { /* 停用失败不阻断退出 */ }
    try { await ctx.plugin.onUnload?.(ctx.context); } catch { /* 卸载失败不阻断退出 */ }
    for (const inverse of ctx.inverses.reverse()) {
      try { await inverse(); } catch { /* 逆元失败继续 */ }
    }
    for (const controller of ctx.controllers.values()) {
      try { controller.abort(); } catch { /* 忽略 */ }
    }
  }
  send({ type: 'stopped' });
  if (reason === 'fatal') process.exit(1);
  process.exit(0);
}

process.on('message', (raw: unknown) => {
  const message = raw as ParentToHost;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'load') {
    void loadPlugin(message).catch((err) => {
      send({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
      setTimeout(() => process.exit(1), 10);
    });
    return;
  }
  if (message.type === 'start') {
    void (async () => {
      try {
        await childCtx?.plugin.onStart?.(childCtx.context);
        send({ type: 'started' });
      } catch (err) {
        send({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }
  if (message.type === 'stop') {
    void shutdown(message.reason);
    return;
  }
  if (message.type === 'call') {
    void handleCall(message);
    return;
  }
  if (message.type === 'abort') {
    childCtx?.controllers.get(message.id)?.abort();
    return;
  }
  if (message.type === 'event') {
    const listener = childCtx?.listeners.get(message.token);
    if (listener) void Promise.resolve(listener(message.event as never)).catch(() => undefined);
    return;
  }
  if (message.type === 'unsubscribe') {
    childCtx?.listeners.delete(message.token);
  }
});

process.on('disconnect', () => {
  void shutdown('disconnect');
});
