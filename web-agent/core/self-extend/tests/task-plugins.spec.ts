import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../../kernel';
import { TaskPlugins } from '../runtime';
import { ToolExecutor } from '../../chat/tool-executor';
import type { TaskPluginBinding } from '../../../kernel/task-plugins';
import type { RunRecord } from '../../../kernel/run';
import type { ToolContext, PluginManifest } from '../../../kernel/types';
import { taskPluginExamples } from '../examples';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'maharness-composition-'));
  const kernel = new Kernel(ROOT, {}, { dataDir: data });
  const service = new TaskPlugins(kernel);
  const records = new Map<string, TaskPluginBinding[]>(), saved: TaskPluginBinding[] = [], events: string[] = [];
  service.attach({ get: id => structuredClone(records.get(id) ?? []), put: (id, bindings) => records.set(id, structuredClone(bindings)), workspace: () => structuredClone(saved), save: (_t, _w, binding) => saved.push(structuredClone(binding)), event: (_id, type) => events.push(type) });
  const run = (id: string, enabled = true): RunRecord => ({ id, sessionId: 'session', tenantId: 'default', rootId: id, depth: 0, objective: 'test', providerId: 'test', model: 'test', status: 'running', authorization: { workspace: data, profile: 'standard', revision: 0, readOnly: false, pluginDevelopment: { enabled, permissions: ['workspace.read', 'workspace.write'], dependencies: [] } }, cost: 0, tokensIn: 0, tokensOut: 0, createdAt: 0, updatedAt: 0 });
  return { service, records, saved, events, run, close: async () => { await kernel.stop(); rmSync(data, { recursive: true, force: true }); } };
}
const context = {} as ToolContext;
const source = (id: string, value: number) => `export default { id: '${id}', name: 'Counter', version: '1.0.0', onLoad(ctx: import('../../kernel/types').PluginContext) { ctx.register({kind: 'tool', tool: {name: 'count_words', version:'2.0.0', permissions: [], description:'Count words', parameters: {type:'object'}, outputSchema: {type:'object'}, sideEffect:'none', async handler() {return {ok:true,data:{count:${value}}};} }}); } };`;
const manifest = (id: string): PluginManifest => ({ apiVersion: 2, id, name: id, version: '1.0.0', entry: 'index.ts', permissions: { capabilities: { tool: ['count_words'] } } });

test('every on-demand SDK example compiles, registers its actual identifier and releases', async () => {
  const f = fixture(); const session = await f.service.open(f.run('sdk-examples'));
  const call = (name: string, args: unknown, ctx = context) => session.tools().find(tool => tool.name === name)!.handler(args, ctx);
  try {
    for (const example of taskPluginExamples) {
      const reference = await call('plugin_status', { example: example.id });
      assert.deepEqual(reference.data, example);
      const staged = await call('create_plugin', { id: example.manifest.id, source: example.source });
      assert.equal(staged.ok, true, `${example.id}: ${staged.error}`);
      const enabled = await call('enable_plugin', { id: example.manifest.id });
      assert.equal(enabled.ok, true, `${example.id}: ${enabled.error}`);
      assert.deepEqual((enabled.data as { registered: unknown }).registered, [{kind:example.kind,name:example.name}]);
      if (example.id === 'tool') assert.equal((await call('sum_values', { numbers: [12,13,17] })).ok, true);
      if (example.id === 'command') assert.deepEqual((await call('invoke_plugin', {kind:'command',name:'upper',args:['ready']})).data, {output:'READY'});
      if (example.id === 'composition') {
        let calls = 0;
        assert.equal((await call('read_note', {}, { ...context, invoke: async name => { calls++; assert.equal(name,'read_file'); return {ok:true,data:{text:'note'}}; } })).ok, true);
        assert.equal(calls,1);
      }
      assert.equal((await call('disable_plugin', { id: example.manifest.id })).ok, true);
      await session.boundary();
      assert.equal(session.capabilities(example.kind).length, 0);
    }
  } finally { await session.dispose(); await f.close(); }
});

test('plugin branch validation, child failures and throwing handlers preserve execution outcomes', async () => {
  const f = fixture(); const run = f.run('branch-errors'); run.authorization.pluginDevelopment!.permissions.push('delegate','network');
  const session = await f.service.open(run);
  const call = (name: string, args: unknown, ctx = context) => session.tools().find(tool => tool.name === name)!.handler(args, ctx);
  try {
    for (const kind of ['role','provider']) {
      const example = taskPluginExamples.find(item => item.id === kind)!;
      assert.equal((await call('create_plugin',{id:example.manifest.id,source:example.source})).ok,true);
      assert.equal((await call('enable_plugin',{id:example.manifest.id})).ok,true);
      const invalid = await call('invoke_plugin',{kind,name:example.name});
      assert.equal(invalid.failure?.code,'PLUGIN_ARGS_INVALID');
      assert.equal(invalid.failure?.outcome,'not_started');
    }
    const failed = await call('invoke_plugin',{kind:'role',name:'review',objective:'check'}, {...context,delegate:async()=>({runId:'child',traceId:'child',answer:'',cost:0,tokensIn:0,tokensOut:0,toolCalls:0,error:'failed',cancelled:false})});
    assert.equal(failed.ok,false); assert.equal(failed.failure?.code,'PLUGIN_CHILD_FAILED');
    const dynamic = await call('create_plugin',{id:'dynamic',source:"const id='review';export default {id:'dynamic',name:'dynamic',version:'1.0.0',onLoad(ctx:import('../../kernel/plugin-sdk').PluginContext){ctx.register({kind:'role',role:{id,name:'Review',description:'r',systemPrompt:'r'}})}}"});
    assert.equal(dynamic.failure?.code,'PLUGIN_MANIFEST_REQUIRED');
    const broken = taskPluginExamples[0];
    assert.equal((await call('create_plugin',{id:broken.manifest.id,source:broken.source.replace('numbers.reduce((a,b)=>a+b,0)','numbers.noSuchMethod()')})).ok,true);
    const activation = await call('enable_plugin',{id:broken.manifest.id});
    assert.equal(activation.ok,false);
    assert.equal((activation.data as { diagnostics: { stage: string; line: number }[] }).diagnostics[0].stage,'types');
    assert.equal((activation.data as { diagnostics: { line: number }[] }).diagnostics[0].line,1);
  } finally { await session.dispose(); await f.close(); }
});

test('a long command does not lock status or unload its in-flight version', async () => {
  const f = fixture(); const session = await f.service.open(f.run('command-pin'));
  const call = (name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  let release!: () => void;
  (globalThis as any).__mhCommandWait = new Promise<void>(resolve => { release=resolve; });
  try {
    const source = `export default {id:'waiting',name:'waiting',version:'1.0.0',onLoad(ctx:import('../../kernel/plugin-sdk').PluginContext){ctx.register({kind:'command',command:{name:'wait',description:'wait',async handler(){await (globalThis as any).__mhCommandWait;return ctx.storage.read('value')??'alive'}}});ctx.resources!.defer(()=>{(globalThis as any).__mhCommandDisposed=true})}}`;
    assert.equal((await call('create_plugin',{id:'waiting',source})).ok,true);
    const activation=await call('enable_plugin',{id:'waiting'});assert.equal(activation.ok,true,activation.error);
    (globalThis as any).__mhCommandDisposed=false;
    const pending=call('invoke_plugin',{kind:'command',name:'wait'});
    assert.equal((await call('plugin_status',{})).ok,true);
    assert.equal((await call('disable_plugin',{id:'waiting'})).ok,true);
    await session.boundary(); assert.equal((globalThis as any).__mhCommandDisposed,false);
    release(); assert.equal((await pending).ok,true);
    await session.boundary(); assert.equal((globalThis as any).__mhCommandDisposed,true);
  } finally { release(); delete (globalThis as any).__mhCommandWait; delete (globalThis as any).__mhCommandDisposed; await session.dispose(); await f.close(); }
});

test('plugin role delegation uses the child-run deadline and executes once', async () => {
  const f = fixture(); const run = f.run('role-deadline');
  run.authorization.pluginDevelopment!.permissions.push('delegate');
  const session = await f.service.open(run);
  const call = (name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  let delegated = 0;
  try {
    const staged = await call('create_plugin', {
      id: 'math-role',
      source: `export default {id:'math-role',name:'Math Role',version:'1.0.0',onLoad(ctx:import('../../kernel/types').PluginContext){ctx.register({kind:'role',role:{id:'math-check',name:'Math Check',description:'Arithmetic',systemPrompt:'Calculate the expression.',tools:'readonly'}});}};`,
      manifest: { apiVersion: 2, id: 'math-role', name: 'Math Role', version: '1.0.0', entry: 'index.ts', permissions: { capabilities: { role: ['math-check'] } } },
    });
    assert.equal(staged.ok, true, staged.error);
    const activated = await call('enable_plugin', { id: 'math-role' });
    assert.equal(activated.ok, true, activated.error);
    const result = await new ToolExecutor({
      tool: session.tools().find(tool => tool.name === 'invoke_plugin')!,
      args: { kind: 'role', name: 'math-check', objective: '3*4' },
      context: { ...context, sandboxRoot: run.authorization.workspace, authorization: run.authorization, delegate: async request => {
        delegated++;
        assert.equal(request.objective, '3*4');
        assert.equal(request.tools, 'read');
        await new Promise(resolve => setTimeout(resolve, 40));
        return { runId: 'child', traceId: 'child-trace', answer: '12', toolCalls: 0, cost: 0, tokensIn: 1, tokensOut: 1, cancelled: false };
      } },
      effectStarted: false, timeoutMs: 5, policyApproved: false,
    }).invoke(false);
    assert.equal(result.ok, true, result.error);
    assert.equal((result.data as { answer: string }).answer, '12');
    assert.equal(delegated, 1);
  } finally { await session.dispose(); await f.close(); }
});

test('plugin SDK is discoverable reference material with bounded reads', async () => {
  const f = fixture(); const session = await f.service.open(f.run('sdk'));
  try {
    const tool = session.tools().find(tool => tool.name === 'plugin_status')!;
    const status = await tool.handler({}, context);
    assert.deepEqual((status.data as { sdk: unknown }).sdk, { tool: 'plugin_status', args: { sdk: true } });
    const first = await tool.handler({ sdk: true, limit: 100 }, context);
    const next = await tool.handler({ sdk: true, offset: 100, limit: 100 }, context);
    assert.equal(first.ok, true); assert.equal(next.ok, true);
    assert.equal((first.data as { content: string }).content.length, 100);
    assert.notEqual((first.data as { content: string }).content, (next.data as { content: string }).content);
  } finally { await session.dispose(); await f.close(); }
});

test('task plugins activate within the run, isolate versions, preserve active version on failure and save explicitly', async () => {
  const f = fixture(); const a = await f.service.open(f.run('a')), b = await f.service.open(f.run('b'));
  const call = (session: typeof a, name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  try {
    for (const [session, value] of [[a, 3], [b, 7]] as const) {
      assert.equal((await call(session, 'create_plugin', { id: 'counter', source: source('counter', value), manifest: manifest('counter') })).ok, true);
      const result = await call(session, 'enable_plugin', { id: 'counter' }); assert.equal(result.ok, true, result.error);
    }
    assert.deepEqual((await call(a, 'count_words', {})).data, { count: 3 });
    assert.deepEqual((await call(b, 'count_words', {})).data, { count: 7 });
    const original = a.tools().find(tool => tool.name === 'count_words')!;
    await call(a, 'create_plugin', { id: 'counter', source: source('counter', 3).replace('count:3', 'count:missingVariable'), manifest: manifest('counter') });
    assert.equal((await call(a, 'enable_plugin', { id: 'counter' })).ok, false);
    assert.deepEqual((await original.handler({}, context)).data, { count: 3 });
    const active = f.service.list(f.run('a')).find(item => item.state === 'active')!;
    assert.throws(() => f.service.save(f.run('a'), active.id, 'stale'), /CONFLICT/);
    f.service.save(f.run('a'), active.id, active.hash); assert.equal(f.saved.length, 1);
    await call(a, 'disable_plugin', { id: 'counter' }); await a.boundary();
    assert.equal(a.tools().some(tool => tool.name === 'count_words'), false);
    assert.equal(b.tools().some(tool => tool.name === 'count_words'), true);
    assert.ok(f.events.includes('plugin_activated'));
  } finally { await a.dispose(); await b.dispose(); await f.close(); }
});

test('development authorization is explicit and manifest permissions cannot expand it', async () => {
  const f = fixture(); const session = await f.service.open(f.run('denied', false));
  try { assert.equal((await session.tools().find(tool => tool.name === 'create_plugin')!.handler({ id: 'counter', source: source('counter', 1) }, context)).ok, false); }
  finally { await session.dispose(); await f.close(); }
});

test('original versions restore from durable binding and altered source is rejected', async () => {
  const f = fixture(); const run = f.run('restore'); let session = await f.service.open(run);
  const call = (name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  try {
    await call('create_plugin', { id: 'counter', source: source('counter', 2), manifest: manifest('counter') });
    const result = await call('enable_plugin', { id: 'counter' }); assert.equal(result.ok, true, result.error);
    await session.dispose(); session = await f.service.open(run);
    assert.deepEqual((await call('count_words', {})).data, { count: 2 });
    await session.dispose();
    f.records.get(run.id)![0].files['index.ts'] += '\n// changed';
    await assert.rejects(f.service.open(run), /PLUGIN_VERSION_CONFLICT/);
  } finally { await session.dispose(); await f.close(); }
});

test('full capability types are scoped, lifecycle resources clear and system services reject takeover', async () => {
  const f = fixture(); const session = await f.service.open(f.run('types'));
  const call = (name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  const caps: PluginManifest['permissions']['capabilities'] = { service: ['sample'], context: ['sample'], listener: ['sample.ping'], command: ['sample'], role: ['sample'], provider: ['sample'], api: ['panel'], persona: ['sample'] };
  const full = `export default { id:'full',name:'Full',version:'1.0.0',onLoad(ctx: import('../../kernel/types').PluginContext) {
    ctx.register({kind:'service',service:{id:'sample',instance:{count:1}}});
    ctx.register({kind:'context',context:{id:'sample',description:'sample',contentFn:()=> 'reference'}});
    ctx.register({kind:'listener',event:'sample.ping',listener:()=>ctx.storage.write('ping','yes')});
    ctx.register({kind:'command',command:{name:'sample',description:'sample',handler:()=> 'done'}});
    ctx.register({kind:'role',role:{id:'sample',name:'sample',description:'sample',systemPrompt:'sample'}});
    ctx.register({kind:'provider',provider:{id:'sample',label:'sample',defaultModel:'sample',chat:async function*(){yield {type:'done' as const};}}});
    ctx.register({kind:'api',api:{mount:'panel',router:(_q:unknown,r:{json:(x:unknown)=>void})=>r.json({title:'sample',html:'sample'})}});
    ctx.register({kind:'persona',persona:{id:'sample',name:'sample',description:'sample',content:'sample'}});
    ctx.resources!.interval(()=>ctx.storage.write('tick','yes'),1000);
  }};`;
  try {
    assert.equal((await call('create_plugin', { id: 'full', source: full, manifest: { apiVersion: 2, id: 'full', name: 'Full', version: '1.0.0', entry: 'index.ts', permissions: { capabilities: caps } } })).ok, true);
    const result = await call('enable_plugin', { id: 'full' }); assert.equal(result.ok, true, result.error);
    for (const kind of ['service', 'context', 'listener', 'command', 'role', 'provider', 'api', 'persona'] as const) assert.equal(session.capabilities(kind).length, 1, kind);
    assert.equal(f.service.routes('types').length, 1);
    assert.deepEqual((await call('invoke_plugin', { kind: 'command', name: 'sample', args: [] })).data, { output: 'done' });
    await call('disable_plugin', { id: 'full' }); await session.boundary();
    assert.equal(session.capabilities('context').length, 0);
    const bad = full.replace("id:'sample',instance", "id:'runner',instance");
    await call('create_plugin', { id: 'full', source: bad, manifest: { apiVersion: 2, id: 'full', name: 'Full', version: '1.0.0', entry: 'index.ts', permissions: { capabilities: { ...caps, service: ['runner'] } } } });
    assert.equal((await call('enable_plugin', { id: 'full' })).ok, false);
  } finally { await session.dispose(); await f.close(); }
});

test('plugin files and imports cannot traverse into host code or grant undeclared dependencies', async () => {
  const f = fixture(); const session = await f.service.open(f.run('paths'));
  const create = (args: unknown) => session.tools().find(tool => tool.name === 'create_plugin')!.handler(args, context);
  try {
    for (const path of ['../outside.ts', '/absolute.ts', 'C:/outside.ts', 'folder/../../outside.ts', 'plugin.json']) {
      assert.equal((await create({ id: 'counter', files: { [path]: source('counter', 1), 'index.ts': source('counter', 1) }, manifest: manifest('counter') })).ok, false, path);
    }
    for (const prefix of ["import '../../kernel/index';", "import '/host.ts';", "const name='./other'; import(name);", "import 'unapproved-package';"]) assert.equal((await create({ id: 'counter', source: prefix + source('counter', 1), manifest: manifest('counter') })).ok, false, prefix);
    assert.equal((await create({ id: 'counter', source: source('counter', 1), manifest: { ...manifest('counter'), permissions: { ...manifest('counter').permissions, dependencies: ['unapproved'] } } })).ok, false);
    const malformed = await create({ id: 'counter', source: source('counter', 1), manifest: { ...manifest('counter'), permissions: { capabilities: [] } } });
    assert.equal(malformed.failure?.code, 'PLUGIN_MANIFEST_INVALID'); assert.equal(malformed.failure?.outcome, 'not_started');
    assert.equal(f.records.get('paths')?.length ?? 0, 0);
  } finally { await session.dispose(); await f.close(); }
});

test('transitive services compose, dependents prevent release and resources dispose on terminal completion', async () => {
  const f = fixture(); const run = f.run('dependency'); const session = await f.service.open(run);
  const call = (name: string, args: unknown) => session.tools().find(tool => tool.name === name)!.handler(args, context);
  try {
    for (const [id, requires, body, caps] of [
      ['base', [], "ctx.provide('sample', { value: 11 });", {}],
      ['middle', ['base'], "ctx.provide('middle', ctx.inject('sample').value);", {}],
      ['consumer', ['middle'], "const sample = ctx.inject('middle').value as {value:number}; ctx.register({kind:'command',command:{name:'value',description:'value',handler:()=>String(sample.value)}}); ctx.resources!.defer(()=>{ctx.storage.write('disposed','yes');});", { command: ['value'] }],
    ] as const) {
      const staged = await call('create_plugin', { id, files: { 'index.ts': `export default {id:'${id}',name:'${id}',version:'1.0.0',onLoad(ctx:import('../../kernel/types').PluginContext){${body}}};` }, manifest: { apiVersion: 2, id, name: id, version: '1.0.0', entry: 'index.ts', requires, permissions: { capabilities: caps } } });
      assert.equal(staged.ok, true, staged.error);
      const active = await call('enable_plugin', { id }); assert.equal(active.ok, true, active.error);
    }
    assert.deepEqual((await call('invoke_plugin', { kind: 'command', name: 'value' })).data, { output: '11' });
    assert.equal((await call('disable_plugin', { id: 'base' })).ok, false);
    run.status = 'completed'; await session.dispose();
    assert.equal(f.service.routes(run.id).length, 0);
    assert.ok(f.records.get(run.id)!.every(binding => binding.state === 'stopped'));
  } finally { await session.dispose(); await f.close(); }
});
