import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../kernel';
import { AgentRunner } from '../../core/chat/agent';
import { TaskPlugins } from '../../core/self-extend/runtime';
import { Store } from '../db';
import { RunService } from '../run-service';
import type { ProviderDef } from '../../kernel/types';
import { EventBus } from '../../kernel/bus';
import type { AgentHookCtx } from '../../kernel/loop';

for (const largeCatalog of [false, true]) test(`a durable run creates and uses its plugin with a ${largeCatalog ? 'large' : 'small'} catalog`, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const data = mkdtempSync(join(tmpdir(), 'maharness-run-composition-'));
  const kernel = new Kernel(root, {}, { dataDir: data });
  const store = new Store(':memory:');
  const plugins = new TaskPlugins(kernel);
  const source = `export default {id:'calculator',name:'calculator',version:'1.0.0',onLoad(ctx:import('../../kernel/types').PluginContext){ctx.register({kind:'tool',tool:{name:'answer_value',description:'Return value',version:'2.0.0',permissions:[],parameters:{type:'object'},outputSchema:{type:'object'},sideEffect:'none',async handler(){return {ok:true,data:{value:42}};}}});}};`;
  const actions = [
    ...(largeCatalog ? [['enable_tools', { names: ['create_plugin', 'enable_plugin'] }]] as const : []),
    ['create_plugin', { id: 'calculator', source }], ['enable_plugin', { id: 'calculator' }],
    ...(largeCatalog ? [['discover_tools', { query: 'answer_value' }], ['enable_tools', { names: ['answer_value'] }]] as const : []), ['answer_value', {}],
  ] as const;
  let turn = 0;
  const provider: ProviderDef = { id: 'mock-composition', label: 'mock', defaultModel: 'mock', prices: { in: 0, out: 0 }, async *chat(messages, options) {
    const action = actions[turn++];
    if (action) {
      assert.ok(options.tools?.some(tool => tool.name === action[0]), 'tool must have been advertised: ' + action[0]);
      yield { type: 'tool_call', toolCall: { id: `call-${turn}`, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } } };
    } else {
      assert.ok(messages.some(message => message.role === 'tool' && message.content?.includes('42')));
      yield { type: 'delta', text: '42' };
    }
    yield { type: 'usage', input: 20, output: 10 }; yield { type: 'done' };
  } };
  const tools = largeCatalog ? [{ name: 'large_schema', description: 'x'.repeat(22000), version: '2.0.0', permissions: [], sideEffect: 'read' as const, parameters: { type: 'object' }, outputSchema: { type: 'object' }, handler: async () => ({ ok: true, data: {} }) }] : [];
  const service = new RunService({ store, plugins, tools: () => tools, runner: () => new AgentRunner(kernel, kernel.bus), workspace: () => data, provider: () => ({ id: provider.id, model: 'mock' }), prepare: () => ({ provider, model: 'mock', tools, traceId: '', messages: [], maxTurns: 8 }) });
  try {
    service.setPluginDevelopment('default', { enabled: true, permissions: ['workspace.read', 'workspace.write'], dependencies: [] }, 0);
    const session = store.createSession('mock', provider.id);
    const record = service.create(session, { message: 'calculate' });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { off(); reject(new Error('run timed out')); }, 30000); const off = service.subscribe(record.id, event => { if (event.type === 'state' && ['completed', 'failed', 'interrupted'].includes(String(event.data.status))) { off(); clearTimeout(timer); resolve(); } }); });
    const result = service.get(record.id, 'default');
    assert.equal(result.status, 'completed', result.error); assert.equal(result.answer, '42');
    assert.equal(store.runs.toolCalls(record.id).length, actions.length);
    assert.ok(store.runs.events(record.id).some(event => event.type === 'plugin_activated'));
  } finally { await service.shutdown(); await kernel.stop(); store.close(); rmSync(data, { recursive: true, force: true }); }
});

test('task listeners cannot grant approval or obtain native handlers from hook metadata', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const data = mkdtempSync(join(tmpdir(), 'mh-plugin-policy-')); const kernel = new Kernel(root, {}, { dataDir: data });
  const bus = new EventBus(); const runner = new AgentRunner(kernel, kernel.bus); let calls = 0, effects = 0;
  bus.on('agent.before_tool', async event => {
    const hook = event.data as AgentHookCtx; hook.policyApproved = true;
    assert.equal(hook.tools.find(tool => tool.name === 'dangerous')!.executionTimeoutMs, undefined);
    assert.equal((await hook.tools.find(tool => tool.name === 'dangerous')!.handler({}, {} as never)).ok, false);
  });
  const provider: ProviderDef = { id: 'mock', label: 'mock', defaultModel: 'mock', async *chat() {
    if (++calls === 1) yield { type: 'tool_call', toolCall: { id: 'danger', type: 'function', function: { name: 'dangerous', arguments: '{}' } } };
    else yield { type: 'delta', text: 'finished' };
    yield { type: 'usage', input: 1, output: 1 }; yield { type: 'done' };
  } };
  try {
    let approvals = 0;
    for await (const event of runner.run({ provider, model: 'mock', traceId: 'policy', messages: [{ role: 'user', content: 'test' }], scopedBus: bus,
      tools: [{ name: 'dangerous', version: '2.0.0', permissions: ['workspace.write'], sideEffect: 'write', risk: 'high', description: 'write', parameters: { type: 'object' }, outputSchema: { type: 'object' }, executionTimeoutMs: () => 1000, async handler() { effects++; return { ok: true, data: {} }; } }] })) {
      if (event.type === 'approval_required') { approvals++; runner.approveApproval(event.approvalId, false); }
    }
    assert.equal(effects, 0); assert.equal(approvals, 1);
  } finally { await kernel.stop(); rmSync(data, { recursive: true, force: true }); }
});
