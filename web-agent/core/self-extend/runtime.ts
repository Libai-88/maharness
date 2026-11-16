import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { EventBus } from '../../kernel/bus';
import { Config } from '../../kernel/config';
import { PluginLoader, validatePluginManifest } from '../../kernel/plugin-loader';
import { reviewPluginSource } from '../../kernel/plugin-review';
import { runPluginTrial } from '../../kernel/plugin-trial';
import type { RunRecord } from '../../kernel/run';
import type { Capability, KernelLike, PluginManifest, ToolDef, ToolResult, ToolContext, LLMMessage } from '../../kernel/types';
import { callModel } from '../../kernel/model-call';
import { taskPluginSDK } from './sdk';
import { taskPluginExamples } from './examples';
import type { TaskPluginBinding, TaskPluginPersistence, TaskPluginService, TaskPluginSession } from '../../kernel/task-plugins';
import { pluginFilePath } from '../../kernel/plugin-files';
import { capabilityName, CAPABILITY_IDENTIFIERS } from '../../kernel/capability-identity';

const kinds = ['tool', 'service', 'context', 'listener', 'command', 'role', 'provider', 'persona', 'api'];
const reserved = /^(service:)?(runner|chat|task-plugins|authorization|approvals?|secrets?|budget|cache|trace|runs?|persistence|model-call|scheduler|provider-gateway|tool-executor|config)$/;
const lifecycle = new Set(['create_plugin', 'plugin_status', 'enable_plugin', 'disable_plugin', 'invoke_plugin']);
const validId = /^[a-z0-9][a-z0-9-]{0,31}$/;
const failure = (code: string, error: string, outcome: 'not_started' | 'unknown' = 'not_started'): ToolResult => ({ ok: false, error, failure: { code, retryable: false, outcome } });
const digest = (manifest: PluginManifest, files: Record<string, string>) => createHash('sha256').update(JSON.stringify([manifest, Object.entries(files).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');

/** Trusted-code plugin implementation. Scope limits registration, not arbitrary JavaScript. */
export class TaskPlugins implements TaskPluginService {
  private persistence?: TaskPluginPersistence;
  private sessions = new Map<string, Session>();
  constructor(private readonly kernel: KernelLike) {}
  attach(persistence: TaskPluginPersistence): void { this.persistence = persistence; }
  list(run: RunRecord): TaskPluginBinding[] { return this.persistence?.get(run.id) ?? []; }
  async open(run: RunRecord): Promise<TaskPluginSession> {
    if (!this.persistence) throw new Error('PLUGIN_PERSISTENCE_UNAVAILABLE');
    if (this.sessions.has(run.id)) throw new Error('PLUGIN_SESSION_ALREADY_OPEN');
    const session = new Session(this.kernel, run, this.persistence, () => this.sessions.delete(run.id));
    this.sessions.set(run.id, session);
    try { await session.restore(); return session; } catch (error) { await session.dispose(); throw error; }
  }
  save(run: RunRecord, id: string, hash: string): void {
    const binding = this.list(run).find(item => item.id === id && item.hash === hash);
    if (!binding) throw new Error('PLUGIN_VERSION_CONFLICT');
    if (!['validated', 'active', 'stopped'].includes(binding.state)) throw new Error('PLUGIN_NOT_VALIDATED');
    this.persistence!.save(run.tenantId, run.authorization.workspace, { ...binding, scope: 'workspace', state: 'validated' });
    this.persistence!.event(run.id, 'plugin_saved', { id, hash, scope: 'workspace' });
  }
  routes(runId: string) { return this.sessions.get(runId)?.routes() ?? []; }
  capabilities<T extends Capability['kind']>(runId: string, kind: T): Extract<Capability, { kind: T }>[] { return this.sessions.get(runId)?.capabilities(kind) ?? []; }
}

class Session implements TaskPluginSession {
  readonly bus = new EventBus();
  private active = new Map<string, { loader: PluginLoader; binding: TaskPluginBinding }>();
  private bindings: TaskPluginBinding[];
  private retired: PluginLoader[] = [];
  private version = 0;
  private closed = false;
  private disposal?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private calls = new Map<PluginLoader, Set<Promise<unknown>>>();
  private readonly config: Config;
  constructor(private kernel: KernelLike, private run: RunRecord, private store: TaskPluginPersistence, private onClose: () => void) {
    this.bindings = store.get(run.id);
    this.config = new Config(this.bus, { 'sandboxRoot': run.authorization.workspace, 'plugins.allowedDependencies': run.authorization.pluginDevelopment?.dependencies ?? [] });
  }
  revision() { return this.version; }
  async boundary(): Promise<void> {
    const retired = this.retired.splice(0);
    for (const loader of retired) {
      if (this.calls.get(loader)?.size) this.retired.push(loader);
      else await loader.dispose();
    }
  }
  private using<T>(loaders: PluginLoader[], fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('PLUGIN_SESSION_CLOSED'));
    const call = Promise.resolve().then(fn).finally(() => {
      for (const loader of loaders) { const calls = this.calls.get(loader); calls?.delete(call); if (!calls?.size) this.calls.delete(loader); }
    });
    for (const loader of loaders) { const calls = this.calls.get(loader) ?? new Set(); calls.add(call); this.calls.set(loader, calls); }
    return call;
  }
  private registrations(loader: PluginLoader) {
    return (Object.keys(CAPABILITY_IDENTIFIERS) as Capability['kind'][]).flatMap(kind => loader.capabilities(kind).map(cap => ({ kind, name: capabilityName(cap) })));
  }
  private event(type: string, data: Record<string, unknown>) { this.store.event(this.run.id, type, { ...data, revision: this.version }); }
  private persist() { this.store.put(this.run.id, this.bindings); }
  private assertGrant(manifest?: PluginManifest) {
    const grant = this.run.authorization.pluginDevelopment;
    if (!grant?.enabled || this.run.authorization.readOnly) throw new Error('PLUGIN_DEVELOPMENT_NOT_AUTHORIZED');
    if (manifest?.essential) throw new Error('PLUGIN_ESSENTIAL_NOT_ALLOWED');
    if (manifest && Object.keys(manifest.permissions.capabilities).some(kind => !kinds.includes(kind))) throw new Error('PLUGIN_CAPABILITY_UNSUPPORTED');
    if (manifest?.permissions.dependencies?.some(name => !grant.dependencies.includes(name))) throw new Error('PLUGIN_DEPENDENCY_NOT_AUTHORIZED');
    const runtime = manifest?.permissions.runtime;
    if (runtime?.process || runtime?.filesystem && runtime.filesystem !== 'none' && runtime.filesystem !== 'storage' || runtime?.network && runtime.network !== 'none') throw new Error('PLUGIN_DIRECT_RUNTIME_NOT_ALLOWED: 使用 ToolContext.invoke 调用宿主工具');
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => { if (this.closed) throw new Error('PLUGIN_SESSION_CLOSED'); return fn(); });
    this.chain = next.catch(() => undefined); return next;
  }
  async restore(): Promise<void> {
    const pending = new Set(this.bindings.filter(item => item.state === 'active').map(item => item.id));
    while (pending.size) {
      const binding = this.bindings.find(item => pending.has(item.id) && (item.manifest.requires ?? []).every(dep => this.active.has(dep)));
      if (!binding) throw new Error('PLUGIN_DEPENDENCY_MISSING_OR_CYCLIC');
      this.assertGrant(binding.manifest);
      if (digest(binding.manifest, binding.files) !== binding.hash) throw new Error('PLUGIN_VERSION_CONFLICT');
      await this.activate(binding); pending.delete(binding.id);
    }
  }
  capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[] {
    return [...this.active.values()].flatMap(item => item.loader.capabilities(kind));
  }
  routes() { return [...this.active.values()].flatMap(item => item.loader.apiRoutes()); }
  private service(key: string): unknown {
    for (const item of [...this.active.values()].reverse()) { const value = item.loader.resolveService(key); if (value !== undefined) return value; }
    return undefined;
  }
  private async activate(binding: TaskPluginBinding): Promise<void> {
    this.assertGrant(binding.manifest);
    for (const dep of binding.manifest.requires ?? []) if (!this.active.has(dep) || dep === binding.id) throw new Error('PLUGIN_DEPENDENCY_NOT_ACTIVE: ' + dep);
    const visit = (id: string, path: Set<string>): void => {
      if (path.has(id)) throw new Error('PLUGIN_DEPENDENCY_CYCLIC');
      const manifest = id === binding.id ? binding.manifest : this.active.get(id)?.binding.manifest;
      for (const dep of manifest?.requires ?? []) visit(dep, new Set([...path, id]));
    };
    visit(binding.id, new Set());
    const root = join(this.kernel.paths.data, 'task-plugins', this.run.id, binding.hash);
    const directory = join(root, 'plugins', binding.id);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(join(root, 'kernel'))) symlinkSync(join(this.kernel.rootDir, 'kernel'), join(root, 'kernel'), 'junction');
    const manifest = { ...binding.manifest, enabled: true, lazy: false, requires: [] };
    writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(binding.files)) {
      const file = pluginFilePath(directory, name);
      if (existsSync(file) && readFileSync(file, 'utf8') !== content) throw new Error('PLUGIN_VERSION_CONFLICT');
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, 'utf8');
    }
    const { default: ts } = await import('typescript');
    const program = ts.createProgram(Object.keys(binding.files).filter(name => /\.[cm]?tsx?$/.test(name)).map(name => join(directory, name)), { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, esModuleInterop: true });
    const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error && item.file && !relative(directory, item.file.fileName).startsWith('..'));
    if (diagnostics.length) {
      const error = new Error('PLUGIN_TYPE_ERROR: ' + diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n').slice(0, 8000));
      Object.assign(error, { diagnostics: diagnostics.slice(0, 30).map(item => {
        const position = item.file?.getLineAndCharacterOfPosition(item.start ?? 0);
        return { stage: 'types', code: item.code, file: item.file ? relative(directory, item.file.fileName).replaceAll('\\', '/') : undefined, line: position ? position.line + 1 : undefined, column: position ? position.character + 1 : undefined, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') };
      }) });
      throw error;
    }
    const dependencies = new Set<string>();
    const collect = (id: string) => { if (dependencies.has(id)) return; dependencies.add(id); for (const dep of this.active.get(id)?.binding.manifest.requires ?? []) collect(dep); };
    for (const dep of binding.manifest.requires ?? []) collect(dep);
    const trial = await runPluginTrial({ id: binding.id, manifest: binding.manifest as unknown as Record<string, unknown>, source: binding.files['index.ts'] ?? '', files: binding.files,
      dependencies: [...this.active.values()].filter(item => dependencies.has(item.binding.id)).map(item => ({ manifest: item.binding.manifest as unknown as Record<string, unknown>, files: item.binding.files })), timeoutMs: 15000 });
    if (!trial.ok) throw new Error('PLUGIN_TRIAL_FAILED: ' + trial.error);
    this.event('plugin_validated', { id: binding.id, hash: binding.hash, checks: ['source', 'manifest', 'types', 'trial'] });
    const paths = { ...this.kernel.paths, data: join(root, 'storage') };
    let loader!: PluginLoader;
    const base = this.kernel;
    const view: KernelLike = { ...base, rootDir: base.rootDir, paths, config: this.config, trace: base.trace, cache: base.cache, budget: base.budget,
      plugins: { ...base.plugins, capabilities: kind => [...this.capabilities(kind), ...loader.capabilities(kind)], tools: () => [...this.capabilities('tool'), ...loader.capabilities('tool')].map(cap => cap.tool),
        list: () => [...this.active.values()].flatMap(item => item.loader.list()), enable: async () => { throw new Error('USE_PLUGIN_LIFECYCLE_TOOLS'); }, disable: async () => { throw new Error('USE_PLUGIN_LIFECYCLE_TOOLS'); },
        resolveService: key => loader.resolveService(key) ?? this.service(key), resolveTraced: key => { const value = loader.resolveService(key) ?? this.service(key); return value === undefined ? undefined : { provider: binding.id, value }; },
        reloadChanged: async () => [], getDependencyVersion: () => this.version, bumpEnv: () => { throw new Error('GLOBAL_MUTATION_DENIED'); } } };
    const checkService = (key: string) => {
      if (reserved.test(key) || [...this.active].some(([id, item]) => id !== binding.id && item.loader.serviceKeys().includes(key))) throw new Error('PLUGIN_SERVICE_CONFLICT: ' + key);
    };
    loader = new PluginLoader(this.bus, { kernel: view, paths, config: this.config, trace: base.trace, cache: base.cache, budget: base.budget, secrets: { available: () => false, encrypt: () => { throw new Error('PLUGIN_SECRETS_UNAVAILABLE'); }, decrypt: () => { throw new Error('PLUGIN_SECRETS_UNAVAILABLE'); } } }, join(root, 'empty'), join(root, 'plugins'), {
      resolve: key => this.service(key), service: checkService,
      subscribe: (key, callback) => this.bus.on('scope.services.changed', () => callback(this.service(key))),
      subscribeCapabilities: (kind, callback) => this.bus.on('scope.capabilities.changed', event => { if (!event.data || (event.data as { kind: string }).kind === kind) callback(); }),
      changed: kind => { if (this.active.get(binding.id)?.loader === loader) { this.version++; this.bus.emit({ type: 'scope.capabilities.changed', ts: Date.now(), data: { kind } }); } },
      capability: cap => {
        if (cap.kind === 'service') checkService('service:' + cap.service.id);
        if (cap.kind === 'tool') {
          const tool = cap.tool;
          if (lifecycle.has(tool.name) || this.kernel.plugins.tools().some(item => item.name === tool.name) || [...this.active].some(([id, item]) => id !== binding.id && item.loader.tools().some(existing => existing.name === tool.name))) throw new Error('TOOL_DEFINITION_CONFLICT: ' + tool.name);
          if (tool.permissions?.some(permission => !this.run.authorization.pluginDevelopment!.permissions.includes(permission))) throw new Error('PLUGIN_PERMISSION_NOT_AUTHORIZED');
          if (tool.delegates && !tool.permissions.includes('delegate')) throw new Error('PLUGIN_PERMISSION_NOT_AUTHORIZED');
          const handler = tool.handler;
          tool.handler = (args, context) => handler(args, { ...context, delegate: tool.permissions.includes('delegate') ? context.delegate : undefined });
        }
        if (cap.kind !== 'tool' && cap.kind !== 'listener' && cap.kind !== 'api' && cap.kind !== 'service') {
          const key = (value: Capability) => { const item = value as unknown as Record<string, { id?: string; name?: string }>; const def = item[value.kind]; return def?.id ?? def?.name; };
          if ([...this.active].some(([id, item]) => id !== binding.id && item.loader.capabilities(cap.kind).some(existing => key(existing) === key(cap)))) throw new Error('PLUGIN_CAPABILITY_CONFLICT');
        }
      },
    });
    try {
      const instance = await loader.register(directory);
      if (!instance) throw new Error(loader.diagnostics().map(item => item.message).join('\n'));
      await loader.start(instance);
      if (instance.state !== 'started') throw new Error(instance.error ?? 'PLUGIN_START_FAILED');
      const previous = this.active.get(binding.id);
      this.active.set(binding.id, { loader, binding });
      this.bus.emit({ type: 'scope.services.changed', ts: Date.now() });
      this.bus.emit({ type: 'scope.capabilities.changed', ts: Date.now() });
      if (previous) this.retired.push(previous.loader);
      this.version++; binding.state = 'active'; delete binding.error; this.persist();
      this.event('plugin_activated', { id: binding.id, hash: binding.hash, scope: binding.scope });
    } catch (error) { await loader.dispose(); throw error; }
  }
  tools(): ToolDef[] {
    const dependencies = [...this.active.values()].map(item => item.loader);
    return [...[...this.active.values()].flatMap(({ loader, binding }) => loader.capabilities('tool').map(({ tool }) => ({ ...tool,
      discovery: { ...tool.discovery, pluginId: binding.id, pluginVersion: binding.version },
      handler: (args: unknown, ctx: ToolContext) => this.using(dependencies, () => tool.handler(args, ctx)),
    }))), ...this.lifecycleTools()];
  }
  private lifecycleTools(): ToolDef[] {
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], handler: (args: any, ctx: ToolContext) => Promise<ToolResult>, read = false): ToolDef => ({
      name, description, version: '2.0.0', permissions: read ? ['workspace.read'] : ['workspace.read', 'workspace.write'], sideEffect: read ? 'read' : 'write',
      parameters: { type: 'object', properties, required }, outputSchema: { type: 'object' },
      handler: (args, ctx) => {
        const execute = async () => {
          try { if (this.closed) throw new Error('PLUGIN_SESSION_CLOSED'); if (ctx.signal?.aborted) return failure('PLUGIN_CALL_CANCELLED', '调用已取消'); if (!read) this.assertGrant(); return await handler(args, ctx); }
          catch (error) { const message = error instanceof Error ? error.message : String(error); return failure(/^[A-Z_]+/.exec(message)?.[0] ?? 'PLUGIN_OPERATION_FAILED', message, name === 'invoke_plugin' ? 'unknown' : 'not_started'); }
        };
        return name === 'invoke_plugin' ? this.using([...this.active.values()].map(item => item.loader), execute) : read ? execute() : this.locked(execute);
      },
    });
    const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' };
    return [
      tool('plugin_status', '查看任务和工作区插件、版本、能力与开发授权。sdk=true 读取编写接口和完整最小示例；id/path 读取插件源码。均支持 offset/limit 字符范围。', { sdk: { type: 'boolean' }, example: { type: 'string', enum: taskPluginExamples.map(item => item.id), description: '读取单类完整可编译示例及 manifest' }, id, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, [], async args => {
        if (args.example) { const example = taskPluginExamples.find(item => item.id === args.example); return example ? { ok: true, data: example } : failure('PLUGIN_EXAMPLE_NOT_FOUND', '示例不存在'); }
        if (args.sdk) { const offset = args.offset ?? 0, limit = args.limit ?? 8000; return { ok: true, data: { content: taskPluginSDK.slice(offset, offset + limit), total: taskPluginSDK.length, nextOffset: offset + limit < taskPluginSDK.length ? offset + limit : undefined } }; }
        const saved = this.store.workspace(this.run.tenantId, this.run.authorization.workspace);
        if (args.path) {
          const binding = [...this.bindings, ...saved].find(item => item.id === args.id);
          const content = binding?.files[args.path];
          if (content === undefined) return failure('PLUGIN_FILE_NOT_FOUND', '插件文件不存在');
          const offset = args.offset ?? 0, limit = args.limit ?? 4000;
          return { ok: true, data: { id: binding!.id, hash: binding!.hash, path: args.path, content: content.slice(offset, offset + limit), total: content.length, nextOffset: offset + limit < content.length ? offset + limit : undefined } };
        }
        return { ok: true, data: { revision: this.version, sdk: { tool: 'plugin_status', args: { sdk: true } }, examples: taskPluginExamples.map(({ id, kind, name }) => ({ id, kind, name })), registered: [...this.active].map(([id, item]) => ({ id, capabilities: this.registrations(item.loader) })), grant: this.run.authorization.pluginDevelopment, plugins: this.bindings.map(({ files, ...binding }) => ({ ...binding, files: Object.keys(files) })), available: saved.map(({ files, ...binding }) => ({ ...binding, files: Object.keys(files) })) } };
      }, true),
      { ...tool('invoke_plugin', '显式调用任务插件的 command、role 或 provider。role 创建子任务；provider 仅执行本次请求，不改变当前模型。服务与事件在插件中通过 ctx.inject/ctx.on/ctx.bus 组合。', {
        kind: { type: 'string', enum: ['command', 'role', 'provider'] }, name: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } }, objective: { type: 'string', minLength: 1, description: 'kind=role 时必填：子任务目标' }, model: { type: 'string', minLength: 1, description: 'kind=provider 时必填：模型 ID' }, messages: { type: 'array', minItems: 1, description: 'kind=provider 时必填：本次请求消息', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'], additionalProperties: false } }, maxTokens: { type: 'integer', minimum: 1, maximum: 8192 },
      }, ['kind', 'name'], async (args, ctx) => {
        if (args.kind === 'command') {
          const command = this.capabilities('command').find(cap => cap.command.name === args.name)?.command;
          if (!command) return failure('PLUGIN_CAPABILITY_NOT_FOUND', '命令不存在');
          return { ok: true, data: { output: await command.handler(args.args ?? [], { signal: ctx.signal }) } };
        }
        if (args.kind === 'role') {
          if (!this.run.authorization.pluginDevelopment?.permissions.includes('delegate')) return failure('PLUGIN_PERMISSION_NOT_AUTHORIZED', '插件开发授权不包含委派');
          const role = this.capabilities('role').find(cap => cap.role.id === args.name)?.role;
          if (typeof args.objective !== 'string' || !args.objective.trim()) return failure('PLUGIN_ARGS_INVALID', 'role 调用必须提供非空 objective');
          if (!role) return failure('PLUGIN_CAPABILITY_NOT_FOUND', '角色不存在');
          if (!ctx.delegate) return failure('PLUGIN_SERVICE_UNAVAILABLE', '委派服务不可用');
          const result = await ctx.delegate({ objective: args.objective, instructions: role.systemPrompt, tools: role.tools === 'all' ? 'all' : 'read' }, ctx.signal);
          return result.error || result.cancelled ? { ...failure(result.cancelled ? 'PLUGIN_CHILD_CANCELLED' : 'PLUGIN_CHILD_FAILED', result.error ?? '子任务已取消', 'unknown'), data: result } : { ok: true, data: result };
        }
        const provider = this.capabilities('provider').find(cap => cap.provider.id === args.name)?.provider;
        if (!this.run.authorization.pluginDevelopment?.permissions.includes('network')) return failure('PLUGIN_PERMISSION_NOT_AUTHORIZED', '插件开发授权不包含模型网络请求');
        if (typeof args.model !== 'string' || !args.model.trim() || !Array.isArray(args.messages) || !args.messages.length) return failure('PLUGIN_ARGS_INVALID', 'provider 调用必须提供 model 和非空 messages');
        if (!provider) return failure('PLUGIN_CAPABILITY_NOT_FOUND', '供应商不存在');
        let content = ''; let usage: { input: number; output: number } | undefined;
        for await (const chunk of callModel(provider, args.messages as LLMMessage[], { model: args.model, maxTokens: args.maxTokens ?? 2048, signal: ctx.signal })) {
          if (chunk.type === 'delta') content += chunk.text;
          if (chunk.type === 'usage') usage = { input: chunk.input, output: chunk.output };
          if (chunk.type === 'tool_call') return failure('PLUGIN_PROVIDER_TOOL_CALL_UNSUPPORTED', '此显式请求未授予工具，供应商返回了工具调用');
        }
        return { ok: true, data: { content, usage } };
      }), delegates: true, timeoutMs: 240_000, executionTimeoutMs: args => {
        const call = args as { kind: string; name: string };
        return call.kind === 'command' ? this.capabilities('command').find(cap => cap.command.name === call.name)?.command.timeoutMs ?? 30_000 : 240_000;
      } },
      tool('create_plugin', '创建或更新任务插件候选版本。source 为默认导出 {id,name,version,onLoad(ctx)} 的完整 TypeScript，或传 files 和 v2 manifest。plugin_status({sdk:true}) 提供接口，plugin_status({example:"tool"}) 提供完整示例；enable_plugin 验证并激活。', { id, name: { type: 'string' }, source: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } }, manifest: { type: 'object' } }, ['id'], async args => {
        if (!validId.test(args.id)) throw new Error('PLUGIN_ID_INVALID');
        const files: Record<string, string> = args.files ?? (typeof args.source === 'string' ? { 'index.ts': args.source } : {});
        if (!Object.keys(files).length || Object.values(files).some(content => typeof content !== 'string') || JSON.stringify(files).length > 500_000) throw new Error('PLUGIN_FILES_INVALID');
        const { default: ts } = await import('typescript');
        for (const [name, content] of Object.entries(files)) {
          pluginFilePath('/plugin', name);
          const file = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
          const visit = (node: import('typescript').Node): void => {
            let specifier: string | undefined; let typeOnly = false;
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) { specifier = node.moduleSpecifier.text; typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly; }
            if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) { specifier = node.argument.literal.text; typeOnly = true; }
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
              if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error('PLUGIN_DYNAMIC_IMPORT_NOT_ALLOWED');
              specifier = node.arguments[0].text;
            }
            if (specifier?.startsWith('.') || specifier?.startsWith('/') || specifier?.includes('\\')) {
              const sdkType = typeOnly && /^\.\.\/\.\.\/kernel\/(plugin-sdk|types|loop|run|task-plugins)(\.ts)?$/.test(specifier!);
              const local = relative(resolve('/plugin'), resolve('/plugin', dirname(name), specifier!)).replaceAll('\\', '/');
              if (!sdkType && (local.startsWith('..') || ![local, local + '.ts', local + '.js', local + '/index.ts'].some(path => path in files))) throw new Error('PLUGIN_IMPORT_PATH_NOT_ALLOWED: ' + specifier);
            }
            ts.forEachChild(node, visit);
          };
          visit(file);
        }
        const review = reviewPluginSource(Object.values(files).join('\n'), undefined, { allowedDependencies: this.run.authorization.pluginDevelopment!.dependencies });
        if (!review.ok) throw new Error('PLUGIN_SOURCE_REJECTED: ' + review.issues.map(item => item.message).join('; '));
        if (!args.manifest && !review.capabilityInferenceComplete) throw new Error('PLUGIN_MANIFEST_REQUIRED: 动态能力声明需要显式 manifest；能力授权不会自动推断');
        const permissions: Record<string, string[]> = {};
        for (const cap of review.capabilities) (permissions[cap.kind] ??= []).push(cap.name);
        const manifest: PluginManifest = args.manifest ?? { apiVersion: 3, id: args.id, name: args.name ?? args.id, version: '0.1.0', entry: 'index.ts', permissions: { capabilities: permissions, dependencies: review.dependencies } };
        if (manifest.id !== args.id || ![2, 3].includes(manifest.apiVersion) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.permissions?.capabilities || !files[manifest.entry]
          || manifest.requires !== undefined && (!Array.isArray(manifest.requires) || manifest.requires.some(dep => !validId.test(dep)))
          || Object.values(manifest.permissions.capabilities).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string' || !name))) throw new Error('PLUGIN_MANIFEST_INVALID');
        try { validatePluginManifest(manifest); } catch (error) { throw new Error('PLUGIN_MANIFEST_INVALID: ' + String(error)); }
        this.assertGrant(manifest);
        const binding: TaskPluginBinding = { id: args.id, version: manifest.version, hash: digest(manifest, files), scope: 'run', owner: this.run.id, manifest, files, state: 'staged' };
        const existing = this.bindings.find(item => item.id === binding.id && item.hash === binding.hash);
        if (existing) return { ok: true, data: { id: existing.id, hash: existing.hash, state: existing.state, scope: existing.scope } };
        // Candidates do not replace an active version until activation succeeds.
        this.bindings = [...this.bindings.filter(item => item.id !== binding.id || item.state === 'active'), binding]; this.persist();
        this.event('plugin_staged', { id: binding.id, hash: binding.hash, checks: ['source', 'manifest'], activationRequired: true });
        return { ok: true, data: { id: binding.id, hash: binding.hash, state: binding.state, scope: binding.scope } };
      }),
      tool('enable_plugin', '验证并激活任务插件，下一次模型请求即可发现其能力。可加载已保存工作区插件。', { id, hash: { type: 'string' } }, ['id'], async args => {
        let binding = [...this.bindings].reverse().find(item => item.id === args.id && (!args.hash || item.hash === args.hash));
        if (!binding) {
          const saved = this.store.workspace(this.run.tenantId, this.run.authorization.workspace).find(item => item.id === args.id && (!args.hash || item.hash === args.hash));
          if (saved) { binding = { ...saved, owner: this.run.id, state: 'validated' }; this.bindings.push(binding); }
        }
        if (!binding) throw new Error('PLUGIN_VERSION_NOT_FOUND');
        if (this.active.get(binding.id)?.binding.hash === binding.hash) return { ok: true, data: { id: binding.id, hash: binding.hash, state: 'active' } };
        try { await this.activate(binding); } catch (error) { binding.state = 'error'; binding.error = String(error); this.persist(); this.event('plugin_error', { id: binding.id, hash: binding.hash, error: binding.error }); return { ...failure('PLUGIN_ACTIVATION_FAILED', binding.error, /PLUGIN_(TYPE_ERROR|DEPENDENCY_|PERMISSION_|VERSION_|DEVELOPMENT_|FILE_PATH)/.test(binding.error) ? 'not_started' : 'unknown'), data: { diagnostics: (error as { diagnostics?: unknown }).diagnostics ?? [{ stage: 'activation', code: /^[A-Z_]+/.exec(error instanceof Error ? error.message : String(error))?.[0] ?? 'PLUGIN_ACTIVATION_FAILED', message: binding.error }] } }; }
        this.bindings = this.bindings.filter(item => item.id !== binding!.id || item.hash === binding!.hash); this.persist();
        return { ok: true, data: { id: binding.id, hash: binding.hash, state: binding.state, revision: this.version, capabilities: this.active.get(binding.id)!.loader.list().map(item => item.manifest.permissions.capabilities), registered: this.registrations(this.active.get(binding.id)!.loader) } };
      }),
      tool('disable_plugin', '释放当前任务的插件能力；已发出的调用保留原版本。', { id }, ['id'], async args => {
        if ([...this.active.values()].some(item => item.binding.manifest.requires?.includes(args.id))) throw new Error('PLUGIN_HAS_ACTIVE_DEPENDENTS');
        const previous = this.active.get(args.id);
        if (previous) { this.active.delete(args.id); this.retired.push(previous.loader); previous.binding.state = 'stopped'; this.version++; this.persist(); this.bus.emit({ type: 'scope.services.changed', ts: Date.now() }); this.bus.emit({ type: 'scope.capabilities.changed', ts: Date.now() }); this.event('plugin_released', { id: args.id }); }
        return { ok: true, data: { id: args.id, state: 'stopped' } };
      }),
    ];
  }
  dispose(): Promise<void> { return this.disposal ??= this.close(); }
  private async close(): Promise<void> {
    this.closed = true; await this.chain;
    await Promise.allSettled([...this.calls.values()].flatMap(calls => [...calls]));
    for (const { loader } of [...this.active.values()].reverse()) await loader.dispose();
    for (const loader of this.retired) await loader.dispose();
    this.active.clear(); this.retired = []; this.onClose();
    if (['completed', 'failed', 'cancelled'].includes(this.run.status)) { for (const binding of this.bindings) if (binding.state === 'active') binding.state = 'stopped'; this.persist(); }
    this.event('plugins_disposed', { externalEffectsReverted: false });
  }
}
