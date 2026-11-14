/**
 * 插件进程边界：把一个只提供 tool 能力的插件放进独立 Node 子进程。
 *
 * 边界能力：
 *  - 崩溃隔离：子进程异常退出不会带崩宿主；
 *  - 资源上限：V8 堆上限 + 单次工具调用硬超时（超时终止子进程）；
 *  - 最小环境：只透传运行必需变量，不默认继承父进程密钥；
 *  - 生命周期：stop/unload 关闭子进程，调用中的工具收到 abort。
 *
 * 不是安全沙箱：子进程仍拥有 Node 的 fs/network/process 能力。权限收敛仍由加载前
 * 源码审查、manifest runtime 声明和 OS 账户/容器负责。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Event, EventListener, Plugin, PluginContext, PluginManifest, ToolContext, ToolDef, ToolResult,
} from './types';
import type { HostToParent, ParentToHost, ProcessCallContext, ProcessToolDescriptor } from './plugin-process-protocol';

const HOST_PATH = fileURLToPath(new URL('./plugin-process-host.ts', import.meta.url));
const ENV_ALLOWLIST = new Set([
  'path', 'pathext', 'comspec', 'systemroot', 'windir', 'systemdrive',
  'home', 'userprofile', 'homedrive', 'homepage', 'temp', 'tmp',
  'appdata', 'localappdata', 'allusersprofile', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432',
  'lang', 'lc_all', 'tz', 'term', 'terminfo',
]);

export function buildProcessEnv(
  parentEnv: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const picked: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (!ENV_ALLOWLIST.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    picked[key] = value;
  }
  return { ...picked, ...extra };
}

function childExecArgv(memoryMb: number): string[] {
  const require = createRequire(import.meta.url);
  const resolveTsx = (specifier: string): string | undefined => {
    if (specifier !== 'tsx' && !specifier.startsWith('tsx/')) return undefined;
    try { return pathToFileURL(require.resolve(specifier)).href; } catch { return undefined; }
  };
  const args: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (arg === '-e' || arg === '--eval' || arg.startsWith('--eval=') || arg.startsWith('--inspect')) {
      if (arg === '-e' || arg === '--eval') i++;
      continue;
    }
    if (arg === '--import' || arg === '--require') {
      const specifier = process.execArgv[i + 1];
      if (specifier === undefined) continue;
      i++;
      args.push(arg, resolveTsx(specifier) ?? specifier);
      continue;
    }
    const inline = /^--(import|require)=(.+)$/.exec(arg);
    if (inline) {
      args.push(`--${inline[1]}=${resolveTsx(inline[2]!) ?? inline[2]}`);
      continue;
    }
    args.push(arg);
  }
  return [...args, `--max-old-space-size=${memoryMb}`];
}

interface PendingCall {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ProcessPluginOptions {
  manifest: PluginManifest;
  loadDir: string;
  storageDir: string;
  config: Record<string, unknown>;
  timeoutMs: number;
  memoryMb: number;
  runtime?: {
    network?: 'none' | 'allowlist' | 'full';
    networkAllowlist?: string[];
    filesystem?: 'none' | 'storage' | 'sandbox' | 'full';
    sandboxRoot?: string;
  };
  bus: PluginContext['bus'];
  eventBus: { on(event: string, listener: EventListener, priority?: number): () => void };
  logger: PluginContext['logger'];
}

export class ProcessPluginHost {
  private child?: ChildProcess;
  private hostCtx?: PluginContext;
  private seq = 0;
  private dead = false;
  private stopped = false;
  private ready?: { resolve: (tools: ProcessToolDescriptor[]) => void; reject: (error: Error) => void };
  private tools = new Map<string, ProcessToolDescriptor>();
  private toolUnregisters = new Map<string, () => void>();
  private pending = new Map<number, PendingCall>();
  private subscriptions = new Map<number, () => void>();
  private restarting?: Promise<void>;

  constructor(private opts: ProcessPluginOptions) {}

  /** 返回给 loader 的 Plugin 门面：生命周期全部转到子进程。 */
  facade(): Plugin {
    const { manifest } = this.opts;
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      onLoad: async (ctx) => {
        this.hostCtx = ctx;
        const tools = await this.spawnAndLoad();
        for (const tool of tools) this.registerTool(tool);
      },
      onStart: async () => {
        await this.requestStart();
      },
      onStop: async () => {
        await this.dispose();
      },
      onUnload: async () => {
        await this.dispose();
      },
    };
  }

  private spawnAndLoad(): Promise<ProcessToolDescriptor[]> {
    if (this.stopped) return Promise.reject(new Error(`插件 ${this.opts.manifest.id} 已停用`));
    this.dead = false;
    const child = fork(HOST_PATH, [], {
      cwd: this.opts.loadDir,
      env: buildProcessEnv(process.env, { MAHARNESS_PLUGIN_ID: this.opts.manifest.id }),
      execArgv: childExecArgv(this.opts.memoryMb),
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => process.stdout.write(`[plugin:${this.opts.manifest.id}] ${chunk}`));
    child.stderr?.on('data', (chunk: string) => process.stderr.write(`[plugin:${this.opts.manifest.id}] ${chunk}`));
    child.on('exit', (code, signal) => { if (this.child === child) this.onExit(code, signal); });
    child.on('error', (err) => { if (this.child === child) this.onExit(1, err.message); });
    child.on('message', (raw: unknown) => { if (this.child === child) this.onMessage(raw as HostToParent); });

    return new Promise<ProcessToolDescriptor[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = undefined;
        this.kill();
        reject(new Error(`插件 ${this.opts.manifest.id} 子进程加载超时`));
      }, this.opts.timeoutMs + 5_000);
      this.ready = {
        resolve: (tools) => { clearTimeout(timer); resolve(tools); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      this.send({
        type: 'load',
        pluginId: this.opts.manifest.id,
        entry: this.opts.manifest.entry,
        loadDir: this.opts.loadDir,
        storageDir: this.opts.storageDir,
        config: this.opts.config,
        env: buildProcessEnv(process.env),
        limits: {
          maxStorageBytes: this.opts.manifest.limits?.maxStorageBytes,
          maxStorageFiles: this.opts.manifest.limits?.maxStorageFiles,
        },
        ...(this.opts.runtime ? { runtime: this.opts.runtime } : {}),
      });
    });
  }

  private registerTool(descriptor: ProcessToolDescriptor): void {
    if (!this.hostCtx) throw new Error('process 插件缺少宿主上下文');
    if (descriptor.invokesTools) throw new Error('PLUGIN_PROCESS_COMPOSITION_UNSUPPORTED: ToolContext.invoke 需要可信宿主执行模式');
    if (this.toolUnregisters.has(descriptor.name)) return;
    this.tools.set(descriptor.name, descriptor);
    const def: ToolDef = {
      ...descriptor,
      handler: (args: unknown, tctx: ToolContext) => this.callTool(descriptor.name, args, tctx),
    };
    const off = this.hostCtx.register({ kind: 'tool', tool: def });
    this.toolUnregisters.set(descriptor.name, off);
  }

  private unregisterTool(name: string): void {
    this.tools.delete(name);
    const off = this.toolUnregisters.get(name);
    if (!off) return;
    this.toolUnregisters.delete(name);
    try { off(); } catch { /* 作用域回收时可能已执行 */ }
  }

  private requestStart(): Promise<void> {
    if (this.dead || this.stopped) return Promise.reject(new Error(`插件 ${this.opts.manifest.id} 子进程已终止`));
    this.send({ type: 'start' });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`插件 ${this.opts.manifest.id} 子进程启动超时`)), this.opts.timeoutMs);
      const previous = this.startWaiter;
      this.startWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      if (previous) previous.reject(new Error('启动请求被新的请求覆盖'));
    });
  }

  private startWaiter?: { resolve: () => void; reject: (err: Error) => void };

  private async ensureLive(): Promise<void> {
    if (!this.dead) return;
    if (this.stopped) throw new Error(`插件 ${this.opts.manifest.id} 已停用`);
    if (!this.restarting) {
      this.restarting = this.spawnAndLoad()
        .then((tools) => { for (const tool of tools) this.registerTool(tool); })
        .finally(() => { this.restarting = undefined; });
    }
    await this.restarting;
  }

  private async callTool(name: string, args: unknown, tctx: ToolContext): Promise<ToolResult> {
    try {
      await this.ensureLive();
    } catch (err) {
      return { ok: false, error: `插件 ${this.opts.manifest.id} 子进程重启失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const id = ++this.seq;
    const descriptor = this.tools.get(name);
    const timeoutMs = Math.max(1_000, descriptor?.timeoutMs ?? this.opts.timeoutMs);
    const context: ProcessCallContext = {
      runId: tctx.runId, parentRunId: tctx.parentRunId,
      authorization: tctx.authorization, remainingBudget: tctx.remainingBudget,
      traceId: tctx.traceId,
      turn: tctx.turn,
      sessionId: tctx.sessionId,
      tenantId: tctx.tenantId,
      stepId: tctx.stepId,
      sandboxRoot: tctx.sandboxRoot,
      approved: tctx.approved,
      approvalId: tctx.approvalId,
      policyApproved: tctx.policyApproved,
      model: tctx.model,
      providerId: tctx.providerId,
    };
    return new Promise<ToolResult>((resolve) => {
      const finish = (result: ToolResult) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.send({ type: 'abort', id });
        finish({ ok: false, error: `插件 ${this.opts.manifest.id} 工具 ${name} 超时（${timeoutMs}ms），子进程已终止` });
        this.kill();
      }, timeoutMs);
      const pending: PendingCall = {
        resolve, reject: () => undefined, timer,
        signal: tctx.signal,
        onAbort: () => {
          this.send({ type: 'abort', id });
          finish({ ok: false, error: `插件 ${this.opts.manifest.id} 工具 ${name} 已取消` });
        },
      };
      if (tctx.signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, error: `插件 ${this.opts.manifest.id} 工具 ${name} 已取消` });
        return;
      }
      this.pending.set(id, pending);
      tctx.signal?.addEventListener('abort', pending.onAbort!, { once: true });
      try {
        this.send({ type: 'call', id, tool: name, args, context });
      } catch (err) {
        finish({ ok: false, error: `插件 ${this.opts.manifest.id} 子进程通信失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  private onMessage(message: HostToParent): void {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'ready': {
        const ready = this.ready;
        this.ready = undefined;
        ready?.resolve(message.tools);
        return;
      }
      case 'register':
        try {
          this.registerTool(message.tool);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.ready?.reject(error);
          this.ready = undefined;
          this.startWaiter?.reject(error);
          this.startWaiter = undefined;
          this.kill();
        }
        return;
      case 'unregister':
        this.unregisterTool(message.name);
        return;
      case 'started':
        this.startWaiter?.resolve();
        this.startWaiter = undefined;
        return;
      case 'stopped':
        return;
      case 'result': {
        this.pending.get(message.id)?.resolve(message.result);
        this.settle(message.id);
        return;
      }
      case 'error': {
        this.pending.get(message.id)?.resolve({ ok: false, error: message.error });
        this.settle(message.id);
        return;
      }
      case 'log': {
        this.opts.logger[message.level](message.message, message.meta);
        return;
      }
      case 'outbound':
        this.hostCtx?.outbound.record(message.record);
        return;
      case 'subscribe': {
        const listener: EventListener = (event) => {
          this.send({ type: 'event', token: message.token, event: { type: event.type, data: event.data, ts: event.ts, traceId: event.traceId } });
        };
        const off = this.opts.eventBus.on(message.event, listener, message.priority);
        this.subscriptions.set(message.token, off);
        return;
      }
      case 'unsubscribe': {
        const off = this.subscriptions.get(message.token);
        this.subscriptions.delete(message.token);
        try { off?.(); } catch { /* 已退订 */ }
        return;
      }
      case 'emit':
        this.opts.bus.emit(message.event as Event);
        return;
      case 'fatal': {
        const err = new Error(`插件 ${this.opts.manifest.id} 子进程失败: ${message.error}`);
        this.ready?.reject(err);
        this.ready = undefined;
        this.startWaiter?.reject(err);
        this.startWaiter = undefined;
        this.markDead();
        return;
      }
      default:
        return;
    }
  }

  private settle(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
  }

  private onExit(code: number | null, signal: string | null): void {
    if (!this.dead) {
      const err = new Error(`插件 ${this.opts.manifest.id} 子进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`);
      this.ready?.reject(err);
      this.ready = undefined;
      this.startWaiter?.reject(err);
      this.startWaiter = undefined;
    }
    this.markDead();
  }

  private markDead(): void {
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: `插件 ${this.opts.manifest.id} 子进程已终止` });
    }
    this.pending.clear();
    for (const off of this.subscriptions.values()) {
      try { off(); } catch { /* 忽略 */ }
    }
    this.subscriptions.clear();
  }

  private send(message: ParentToHost): void {
    if (!this.child || !this.child.connected) throw new Error(`插件 ${this.opts.manifest.id} 子进程未连接`);
    this.child.send(message);
  }

  private kill(): void {
    try { this.child?.kill(); } catch { /* 忽略 */ }
    this.child = undefined;
    this.markDead();
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child?.connected) {
      try { this.send({ type: 'stop', reason: 'dispose' }); } catch { /* 忽略 */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.child?.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.kill();
    this.tools.clear();
    this.toolUnregisters.clear();
  }
}
