import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../../kernel';
import { TaskPlugins } from '../runtime';
import type { TaskPluginBinding } from '../../../kernel/task-plugins';
import type { RunRecord } from '../../../kernel/run';
import type { ToolContext, PluginManifest } from '../../../kernel/types';

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
