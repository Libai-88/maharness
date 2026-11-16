import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityConflicts, createToolCatalog, refreshToolCatalog, releasedToolNames, selectedCapabilityNames, toolCatalogBudget } from '../tool-discovery';
import type { ToolContext, ToolDef } from '../types';

test('discovery exposes only run-authorized tools and activation stays scoped to that run', async () => {
  const tool: ToolDef = {version: '2.0.0', permissions: [], outputSchema: {},  name: 'custom_lookup', description: 'Look up custom facts', parameters: { type: 'object' }, sideEffect: 'read', handler: async () => ({ ok: true }) };
  const authorized = [tool, ...Array.from({ length: 16 }, (_, index) => ({ ...tool, name: `extension_${index}`, description: 'Extra capability' }))];
  const active = createToolCatalog(authorized, [], 1);
  assert.equal(active.some(item => item.name === tool.name), false);
  const discover = active.find(item => item.name === 'discover_tools')!;
  const context = {} as ToolContext;
  const found = await discover.handler({ query: 'facts' }, context);
  assert.equal((found.data as { tools: ToolDef[] }).tools[0].name, tool.name);
  const enable = active.find(item => item.name === 'enable_tools')!;
  assert.equal((await enable.handler({ names: ['unauthorized'] }, context)).ok, false);
  assert.equal((await enable.handler({ names: [tool.name] }, context)).ok, true);
  assert.equal(active.some(item => item.name === tool.name), true);
  assert.equal(createToolCatalog(authorized, [], 1).some(item => item.name === tool.name), false);
});

test('small authorized tool sets are directly usable without discovery round trips', () => {
  const tool: ToolDef = { name: 'append_record', version: '2.0.0', permissions: ['workspace.write'], parameters: { type: 'object' }, outputSchema: {}, description: 'Record an order', sideEffect: 'write', handler: async () => ({ ok: true }) };
  assert.deepEqual(createToolCatalog([tool]).map(item => item.name), [tool.name]);
  assert.ok(createToolCatalog([tool]).some(item => item.name === tool.name));
  assert.equal(createToolCatalog([]).some(item => item.name === tool.name), false);
});

test('restoring a catalog retains enabled tools only inside the current authorization ceiling', () => {
  const allowed: ToolDef = { name: 'custom_lookup', version: '2.0.0', permissions: [], parameters: { type: 'object' }, outputSchema: {}, description: 'lookup', sideEffect: 'read', handler: async () => ({ ok: true }) };
  assert.equal(createToolCatalog([allowed], [allowed.name]).some(tool => tool.name === allowed.name), true);
  assert.equal(createToolCatalog([], [allowed.name, 'unauthorized']).some(tool => tool.name === allowed.name || tool.name === 'unauthorized'), false);
});

test('schema volume controls discovery; restored and observation readers remain available', () => {
  const make = (name: string, description = name): ToolDef => ({ name, description, version: '2.0.0', permissions: [], sideEffect: 'read', parameters: {}, outputSchema: {}, handler: async () => ({ ok: true }) });
  const tools = [make('z_custom', '细胞分析 ' + 'x'.repeat(10000)), make('recall_tool_result'), make('a_custom')];
  const first = createToolCatalog(tools, [], 600);
  assert.ok(first.some(tool => tool.name === 'recall_tool_result'));
  assert.equal(first.some(tool => tool.name === 'z_custom'), false);
  assert.ok(createToolCatalog(tools, ['z_custom'], 600).some(tool => tool.name === 'z_custom'));
  assert.deepEqual(createToolCatalog([make('b'), make('a')]).filter(tool => !['discover_tools', 'enable_tools', 'release_tools'].includes(tool.name)).map(tool => tool.name), ['a', 'b']);
  assert.throws(() => createToolCatalog([make('a'), make('a')]), /TOOL_DEFINITION_CONFLICT/);
  const same = make('a'); assert.equal(createToolCatalog([same, same]).filter(tool => tool.name === 'a').length, 1);
});

test('refresh discovers new capabilities, retains explicit release and removes withdrawn tools', async () => {
  const tool: ToolDef = { name: 'initial', description: 'initial', version: '2.0.0', permissions: [], parameters: {}, outputSchema: {}, sideEffect: 'none', handler: async () => ({ ok: true }) };
  const fresh = { ...tool, name: 'new_plugin_tool' };
  const active = createToolCatalog([tool], [tool.name], 1);
  const issued = [...active];
  await active.find(tool => tool.name === 'release_tools')!.handler({ names: ['initial'] }, {} as ToolContext);
  refreshToolCatalog(active, [tool, fresh], 2048);
  assert.equal(active.some(tool => tool.name === 'initial'), false);
  const result = await active.find(tool => tool.name === 'discover_tools')!.handler({ query: 'new_plugin_tool' }, {} as ToolContext);
  assert.equal((result.data as { tools: ToolDef[] }).tools[0].name, fresh.name);
  await active.find(tool => tool.name === 'enable_tools')!.handler({ names: [fresh.name] }, {} as ToolContext);
  assert.ok(active.some(tool => tool.name === fresh.name));
  assert.equal(issued.some(tool => tool.name === fresh.name), false);
  refreshToolCatalog(active, [tool], 2048);
  assert.equal(active.some(tool => tool.name === fresh.name), false);
});

test('discovery supports exact names and Chinese descriptions', async () => {
  const tool: ToolDef = { name: 'cell_lookup', description: '细胞分析', version: '2.0.0', permissions: [], sideEffect: 'read', parameters: {}, outputSchema: {}, handler: async () => ({ ok: true }) };
  const discover = createToolCatalog([tool], [], 0).find(tool => tool.name === 'discover_tools')!;
  for (const query of ['CELL_LOOKUP', '细胞', 'cell lookup']) {
    const result = await discover.handler({ query }, {} as ToolContext);
    assert.equal((result.data as { tools: ToolDef[] }).tools[0].name, tool.name);
  }
});

test('small catalogs expose new capabilities directly and retain explicit releases through restore', async () => {
  const make = (name: string): ToolDef => ({ name, description: name, version: '2.0.0', permissions: [], sideEffect: 'read', parameters: {}, outputSchema: {}, handler: async () => ({ ok: true }) });
  const tools = [make('a'), make('b')];
  const active = createToolCatalog([tools[0]]);
  refreshToolCatalog(active, tools, 4096);
  assert.deepEqual(active.map(tool => tool.name), ['a', 'b']);
  const large = createToolCatalog(tools, ['a'], 1);
  await large.find(tool => tool.name === 'release_tools')!.handler({ names: ['a'] }, {} as ToolContext);
  const restored = createToolCatalog(tools, [], 4096, releasedToolNames(large));
  assert.equal(restored.some(tool => tool.name === 'a'), false);
  assert.equal(restored.some(tool => tool.name === 'b'), true);
  await restored.find(tool => tool.name === 'enable_tools')!.handler({ names: ['a'] }, {} as ToolContext);
  refreshToolCatalog(restored, tools, 4096);
  assert.deepEqual(restored.map(tool => tool.name), ['a', 'b']);
  assert.deepEqual(createToolCatalog([]), []);
  assert.equal(toolCatalogBudget(1000), 85);
});

test('plugin discovery metadata is searchable without changing authorization or schema order', async () => {
  const tool: ToolDef = { name: 'lookup', description: 'lookup', version: '2.0.0', permissions: [], sideEffect: 'read', parameters: {}, outputSchema: {}, discovery: { initial: true, pluginId: 'cells', pluginVersion: '1.0.0', keywords: ['细胞'] }, handler: async () => ({ ok: true }) };
  const active = createToolCatalog([tool], [], 0);
  const result = await active.find(tool => tool.name === 'discover_tools')!.handler({ query: '细胞' }, {} as ToolContext);
  assert.equal((result.data as { tools: ToolDef[] }).tools[0].discovery?.pluginId, 'cells');
  const snapshot = () => JSON.stringify(createToolCatalog([tool], [], 0).map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.equal(snapshot(), snapshot());
});

test('任务能力索引按意图发现、稳定去重并只加载胜出插件工具', async () => {
  const capability = (tools: string[]) => ({
    id: 'document.read', name: '阅读文件', description: '阅读 PDF 并定位来源', tools,
    aliases: ['PDF', '来源'], inputs: ['pdf'], outputs: ['source-anchor'], risk: 'low' as const, sideEffect: 'read' as const,
  });
  const tool = (name: string, pluginId: string): ToolDef => ({
    name, description: '读取 PDF', version: '3.0.0', permissions: ['workspace.read'], sideEffect: 'read',
    parameters: { type: 'object' }, outputSchema: { type: 'object' }, handler: async () => ({ ok: true }),
    discovery: { initial: false, pluginId, pluginVersion: '1.0.0', capabilities: [capability([name])] },
  });
  const a = tool('read_pdf_a', 'alpha'); const z = tool('read_pdf_z', 'zeta');
  const filler = Array.from({ length: 14 }, (_, index) => ({ ...tool(`filler_${index}`, `p${index}`), discovery: {} }));
  const catalog = createToolCatalog([a, z, ...filler], [], 1);
  const discover = catalog.find(item => item.name === 'discover_capabilities')!;
  const found = await discover.handler({ query: 'PDF 来源' }, {} as ToolContext);
  const entries = (found.data as { capabilities: { id: string; availableTools: string[] }[] }).capabilities;
  assert.equal(entries.length, 1); assert.equal(entries[0]?.id, 'document.read');
  assert.deepEqual(entries[0]?.availableTools, ['read_pdf_a']);
  assert.deepEqual(capabilityConflicts(catalog), [{ capabilityId: 'document.read', shadowedBy: 'alpha' }]);
  await catalog.find(item => item.name === 'enable_capabilities')!.handler({ ids: ['document.read'] }, {} as ToolContext);
  assert.deepEqual(selectedCapabilityNames(catalog), ['document.read']);
  assert.equal(catalog.some(item => item.name === 'read_pdf_a'), true);
  assert.equal(catalog.some(item => item.name === 'read_pdf_z'), false);
  const second = createToolCatalog([z, ...filler, a], [], 1);
  assert.equal(second.some(item => item.name === 'read_pdf_a'), false);
});
