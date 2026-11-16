import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../index';
import type { PluginManifest, ToolContext } from '../types';

function setup(plugins: Record<string, {
  manifest: Partial<PluginManifest>;
  entry: string;
}>): { kernel: Kernel; rootDir: string; cleanup: () => Promise<void> } {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-process-plugin-'));
  const dataDir = join(rootDir, 'data');
  const userPluginsDir = join(rootDir, 'plugins');
  mkdirSync(userPluginsDir, { recursive: true });
  for (const [id, plugin] of Object.entries(plugins)) {
    const dir = join(userPluginsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ apiVersion: 2, permissions: { capabilities: { tool: ['*'], service: ['*'], context: ['*'], provider: ['*'], persona: ['*'], listener: ['*'], command: ['*'], role: ['*'], api: ['*'] } },
      id, name: id, version: '0.1.0', entry: 'index.ts', ...plugin.manifest,
    }));
    writeFileSync(join(dir, 'index.ts'), plugin.entry);
  }
  const kernel = new Kernel(rootDir, {}, { dataDir, userPluginsDir });
  return {
    kernel,
    rootDir,
    cleanup: async () => {
      try { await kernel.stop(); } catch { /* 已停止 */ }
      try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* Windows 句柄迟释放 */ }
    },
  };
}

function toolOf(kernel: Kernel, name: string) {
  return kernel.plugins.capabilities('tool').find((cap) => cap.tool.name === name)?.tool;
}

const execution = {
  execution: { mode: 'process' as const, timeoutMs: 5_000, memoryMb: 128 },
  permissions: { capabilities: { tool: ['proc_pid'] } },
};

describe('插件进程执行边界', () => {
  test('non-cooperative cancellation settles only after the child process exits', async t => {
    const f=setup({stubborn:{manifest:execution,entry:`export default {id:'stubborn',name:'stubborn',version:'0.1.0',onLoad(ctx){ctx.register({kind:'tool',tool:{name:'proc_pid',version:'2.0.0',permissions:[],sideEffect:'read',description:'test',parameters:{type:'object'},outputSchema:{},async handler(args){if(!args.wait)return {ok:true,data:{pid:process.pid}};ctx.bus.emit({type:'stubborn.entered',ts:Date.now()});await new Promise(()=>{});return {ok:true}}}})}}`}});
    t.after(f.cleanup);await f.kernel.plugins.loadAll();
    const tool=toolOf(f.kernel,'proc_pid')!;const ctx={turn:0,sandboxRoot:f.rootDir,cache:f.kernel.cache,trace:f.kernel.trace} as ToolContext;
    const pid=((await tool.handler({},ctx)).data as {pid:number}).pid;
    const ac=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
    const off=f.kernel.bus.on('stubborn.entered',()=>entered());
    const pending=tool.handler({wait:true},{...ctx,signal:ac.signal});await started;off();
    ac.abort();const result=await pending;
    assert.equal(result.ok,false);assert.equal(result.failure?.outcome,'unknown');
    assert.throws(()=>process.kill(pid,0));
  });
  test('process mode rejects composite tools whose invocation callback cannot cross IPC', async (t) => {
    const f = setup({ composite: { manifest: execution, entry: `export default {id:'composite',name:'composite',version:'0.1.0',onLoad(ctx){ctx.register({kind:'tool',tool:{name:'proc_pid',version:'2.0.0',description:'composite',parameters:{type:'object'},outputSchema:{type:'object'},permissions:[],sideEffect:'read',invokesTools:true,async handler(_args,tctx){return tctx.invoke('read_file',{});}}});}};` } });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.equal(toolOf(f.kernel, 'proc_pid'), undefined);
    assert.ok(f.kernel.plugins.diagnostics().some(item => item.message.includes('PLUGIN_PROCESS_COMPOSITION_UNSUPPORTED')));
  });

  test('process mode rejects dynamic deadlines instead of silently dropping the resolver', async t => {
    const f = setup({ dynamic: { manifest: execution, entry: `export default {id:'dynamic',name:'dynamic',version:'0.1.0',onLoad(ctx){ctx.register({kind:'tool',tool:{name:'proc_pid',version:'2.0.0',permissions:[],sideEffect:'read',description:'test',parameters:{type:'object'},outputSchema:{},executionTimeoutMs:()=>2000,async handler(){return {ok:true}}}})}}` } });
    t.after(f.cleanup); await f.kernel.plugins.loadAll();
    assert.equal(toolOf(f.kernel, 'proc_pid'), undefined);
    assert.ok(f.kernel.plugins.diagnostics().some(item => item.message.includes('executionTimeoutMs')));
  });

  test('process mode rejects call-specific side-effect classifiers instead of hiding the loss', async t => {
    const f = setup({ dynamic: { manifest: execution, entry: `export default {id:'dynamic',name:'dynamic',version:'0.1.0',onLoad(ctx){ctx.register({kind:'tool',tool:{name:'proc_pid',version:'2.0.0',permissions:[],sideEffect:'read',description:'test',parameters:{type:'object'},outputSchema:{},classifySideEffect:()=> 'read',async handler(){return {ok:true}}}})}}` } });
    t.after(f.cleanup); await f.kernel.plugins.loadAll();
    assert.equal(toolOf(f.kernel, 'proc_pid'), undefined);
    assert.ok(f.kernel.plugins.diagnostics().some(item => item.message.includes('classifySideEffect')));
  });

  test('filesystem=storage 只允许插件存储目录，越界读取被运行时拒绝', async (t) => {
    const f = setup({
      fsprobe: {
        manifest: {
          execution: { mode: 'process', timeoutMs: 5_000, memoryMb: 64 },
          permissions: { capabilities: { tool: ['proc_fs_probe'] }, runtime: { filesystem: 'storage' } },
        },
        entry: "\nexport default {\n  id: 'fsprobe', name: 'fsprobe', version: '0.1.0',\n  onLoad(ctx) {\n    ctx.register({ kind: 'tool', tool: { version: '2.0.0', permissions: [], outputSchema: {},\n      name: 'proc_fs_probe',\n      description: 'read a path under the plugin filesystem policy',\n      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },\n      sideEffect: 'read',\n      async handler(args) {\n        try {\n          const fs = await import('node:' + 'fs');\n          const handle = await fs.promises.open(args.path, 'r');\n          const buffer = Buffer.alloc(64);\n          const { bytesRead } = await handle.read(buffer, 0, 64, 0);\n          await handle.close();\n          ctx.storage.write('owned.txt', 'storage-ok');\n          return { ok: true, data: { text: buffer.subarray(0, bytesRead).toString('utf8'), storage: ctx.storage.read('owned.txt') } };\n        } catch (error) {\n          return { ok: false, error: error instanceof Error ? error.message : String(error) };\n        }\n      },\n    } });\n  },\n};\n",
      },
    });
    t.after(async () => { await f.cleanup(); });

    const outside = join(f.rootDir, 'outside.txt');
    writeFileSync(outside, 'must-not-leak');
    await f.kernel.plugins.loadAll();
    const tool = toolOf(f.kernel, 'proc_fs_probe');
    assert.ok(tool);
    const result = await tool.handler({ path: outside }, {
      turn: 0, sandboxRoot: f.rootDir, cache: f.kernel.cache, trace: f.kernel.trace,
    } as ToolContext) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /插件文件系统访问被策略拒绝/);
  });

  test('工具在独立子进程执行，环境最小透传且生命周期可回收', async (t) => {
    const previous = process.env.MAHARNESS_PROCESS_SECRET;
    process.env.MAHARNESS_PROCESS_SECRET = 'must-not-leak';
    const f = setup({
      proc: {
        manifest: execution,
        entry: "\nexport default {\n  id: 'proc', name: 'proc', version: '0.1.0',\n  onLoad(ctx) {\n    ctx.register({ kind: 'tool', tool: { version: '2.0.0', permissions: [], outputSchema: {},\n      name: 'proc_pid',\n      description: 'return process identity',\n      parameters: { type: 'object', properties: {} },\n      sideEffect: 'none',\n      async handler(_args, tctx) {\n        return {\n          ok: true,\n          data: {\n            pid: process.pid,\n            cwd: process.cwd(),\n            secret: process.env.MAHARNESS_PROCESS_SECRET ?? null,\n            sessionId: tctx.sessionId ?? null,\n          },\n        };\n      },\n    } });\n  },\n};\n",
      },
    });
    t.after(async () => {
      if (previous === undefined) delete process.env.MAHARNESS_PROCESS_SECRET;
      else process.env.MAHARNESS_PROCESS_SECRET = previous;
      await f.cleanup();
    });

    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.plugins.get('proc')?.state, 'started');
    const tool = toolOf(f.kernel, 'proc_pid');
    assert.ok(tool, 'process 插件工具应已注册');

    const result = await tool.handler({}, {
      turn: 0, sessionId: 'session-x', tenantId: 'default', sandboxRoot: f.rootDir,
      cache: f.kernel.cache, trace: f.kernel.trace,
    } as ToolContext) as { ok: boolean; data?: { pid: number; cwd: string; secret: string | null; sessionId: string | null } };
    assert.equal(result.ok, true);
    assert.notEqual(result.data?.pid, process.pid, '工具必须在独立子进程执行');
    assert.equal(result.data?.secret, null, '父进程密钥不得默认透传');
    assert.equal(result.data?.sessionId, 'session-x', '调用上下文应跨界传递');
    assert.ok(result.data?.cwd.toLowerCase().includes(join('plugins', 'proc')), `cwd 应为插件目录: ${result.data?.cwd}`);

    await f.kernel.plugins.disable('proc');
    assert.equal(toolOf(f.kernel, 'proc_pid'), undefined, '停用后工具应回收');
  });

  test('工具超时会终止子进程并返回可读错误', async (t) => {
    const f = setup({
      slow: {
        manifest: {
          execution: { mode: 'process', timeoutMs: 1_000, memoryMb: 64 },
          permissions: { capabilities: { tool: ['proc_slow'] } },
        },
        entry: "\nexport default {\n  id: 'slow', name: 'slow', version: '0.1.0',\n  onLoad(ctx) {\n    ctx.register({ kind: 'tool', tool: { version: '2.0.0', permissions: [], sideEffect: 'none', outputSchema: {},\n      name: 'proc_slow', description: 'sleep', parameters: { type: 'object', properties: {} },\n      async handler() { await new Promise((r) => setTimeout(r, 10_000)); return { ok: true }; },\n    } });\n  },\n};\n",
      },
    });
    t.after(f.cleanup);

    await f.kernel.plugins.loadAll();
    const tool = toolOf(f.kernel, 'proc_slow');
    assert.ok(tool);
    const started = Date.now();
    const result = await tool.handler({}, {
      turn: 0, sandboxRoot: f.rootDir, cache: f.kernel.cache, trace: f.kernel.trace,
    } as ToolContext) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(String(result.error), /超时|终止/);
    assert.ok(Date.now() - started < 4_000, '超时应在硬上限附近返回，而不是等满 handler');
  });

  test('network=allowlist 在子进程内按主机与端口阻断出口', async (t) => {
    const server = createServer((_req, res) => { res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const allowedPort = (server.address() as { port: number }).port;
    const blocked = createServer((_req, res) => { res.end('should-not-reach'); });
    await new Promise<void>((resolve) => blocked.listen(0, '127.0.0.1', resolve));
    const blockedPort = (blocked.address() as { port: number }).port;
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => blocked.close(() => resolve()));
    });

    const f = setup({
      net: {
        manifest: {
          execution: { mode: 'process', timeoutMs: 5_000 },
          permissions: {
            capabilities: { tool: ['net_probe'] },
            runtime: { network: 'allowlist', networkAllowlist: [`127.0.0.1:${allowedPort}`] },
          },
        },
        entry: `
export default {
  id: 'net', name: 'net', version: '0.1.0',
  onLoad(ctx) {
    ctx.register({ kind: 'tool', tool: {
      version: '2.0.0', permissions: ['network'], sideEffect: 'read', outputSchema: { type: 'object' }, name: 'net_probe', description: 'probe network', parameters: { type: 'object', properties: {} },
      async handler() {
        const allowed = await fetch('http://127.0.0.1:${allowedPort}/').then((r) => r.text());
        let blockedError = '';
        try { await fetch('http://127.0.0.1:${blockedPort}/'); }
        catch (err) { blockedError = err instanceof Error ? err.message : String(err); }
        return { ok: true, data: { allowed, blockedError } };
      },
    } });
  },
};
`,
      },
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const tool = toolOf(f.kernel, 'net_probe');
    assert.ok(tool, `process 插件应加载: ${f.kernel.plugins.diagnostics().map((item) => item.message).join('; ')}`);
    const result = await tool.handler({}, {
      turn: 0, sandboxRoot: f.rootDir, cache: f.kernel.cache, trace: f.kernel.trace,
    } as ToolContext) as { ok: boolean; data?: { allowed: string; blockedError: string } };
    assert.equal(result.ok, true);
    assert.equal(result.data?.allowed, 'ok');
    assert.match(String(result.data?.blockedError), /网络出口被策略拒绝/);
  });

  test('process 模式拒绝未声明的 tool 能力与非 tool 能力', async (t) => {
    const bad = setup({
      bad: {
        manifest: {
          execution: { mode: 'process' },
          permissions: { capabilities: { tool: ['x'] } },
          nav: { label: 'x', mode: 'iframe' },
        },
        entry: 'export default { id: "bad", name: "bad", version: "0.1.0" };',
      },
    });
    t.after(bad.cleanup);
    let error = '';
    bad.kernel.bus.on('plugin.error', (event) => {
      error = String((event.data as { error?: string } | undefined)?.error ?? '');
    });
    await bad.kernel.plugins.loadAll();
    assert.notEqual(bad.kernel.plugins.get('bad')?.state, 'started');
    assert.match(error, /process/);
  });
});
