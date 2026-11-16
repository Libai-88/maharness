import type { CapabilityDescriptor, ToolDef } from './types';
import { estimateTokens } from './tokens';

const DEFAULT_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'command_start', 'command_output', 'command_wait', 'command_cancel', 'powershell_execute', 'web_search', 'web_fetch', 'recall_tool_result', 'search_history', 'read_history', 'run_subagent', 'run_parallel', 'run_review']);
const REQUIRED_TOOLS = new Set(['recall_tool_result']);
export const CATALOG_MANAGER_TOOLS = new Set(['discover_tools', 'enable_tools', 'release_tools', 'discover_capabilities', 'enable_capabilities']);
const MANAGERS = CATALOG_MANAGER_TOOLS;
interface CatalogState {
  released: Set<string>;
  selectedCapabilities: Set<string>;
  conflicts: { capabilityId: string; shadowedBy: string }[];
}
const states = new WeakMap<ToolDef[], CatalogState>();
export const toolCatalogBudget = (contextWindow: number) => Math.min(4096, Math.max(0, Math.floor(contextWindow * 0.85 * 0.1)));
export const releasedToolNames = (active: ToolDef[]) => [...(states.get(active)?.released ?? [])].sort();
export const selectedCapabilityNames = (active: ToolDef[]) => [...(states.get(active)?.selectedCapabilities ?? [])].sort();
export const capabilityConflicts = (active: ToolDef[]) => [...(states.get(active)?.conflicts ?? [])];
const schemaTokens = (tool: ToolDef) => estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));

/** The catalog only contains capabilities already authorized for this run. */
export function createToolCatalog(authorized: ToolDef[], restoredEnabled: string[] = [], tokenBudget = 4096, restoredReleased: string[] = []): ToolDef[] {
  const byName = new Map<string, ToolDef>();
  for (const tool of authorized) {
    if (MANAGERS.has(tool.name)) throw new Error('TOOL_DEFINITION_CONFLICT: ' + tool.name);
    const previous = byName.get(tool.name);
    if (previous && (previous.handler !== tool.handler || previous.assessApproval !== tool.assessApproval || JSON.stringify({ ...previous, handler: undefined }) !== JSON.stringify({ ...tool, handler: undefined })))
      throw new Error('TOOL_DEFINITION_CONFLICT: ' + tool.name);
    byName.set(tool.name, tool);
  }
  authorized = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const small = authorized.reduce((sum, tool) => sum + schemaTokens(tool), 0) <= tokenBudget;
  const restored = new Set(restoredEnabled);
  const released = new Set(restoredReleased.filter(name => !REQUIRED_TOOLS.has(name) && !MANAGERS.has(name)));
  const active = authorized.filter(tool => REQUIRED_TOOLS.has(tool.name) || !released.has(tool.name) && (small || restored.has(tool.name)));
  states.set(active, { released, selectedCapabilities: new Set(), conflicts: [] });
  if (small && active.length === authorized.length) return active;
  // Reserve space for discovery schemas; required/restored tools are never silently dropped.
  // Manager schema cost is measured below before choosing initial tools.
  const enableTools = {
    version: '2.0.0', permissions: [] as ToolDef['permissions'],
    name: 'enable_tools', description: '把已发现的工具加载到本任务的模型输入；不能扩大当前任务权限。', sideEffect: 'none' as const,
    parameters: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'] },
    outputSchema: { type: 'object', properties: { enabled: { type: 'array', items: { type: 'string' } } }, required: ['enabled'] },
    async handler(args: { names?: string[] }) {
      const names = [...new Set(args.names ?? [])];
      if (names.some(name => !byName.has(name))) return { ok: false, error: '包含不存在或未授权的工具', failure: { code: 'TOOL_NOT_AUTHORIZED', retryable: false, outcome: 'not_started' as const } };
      for (const name of names) { released.delete(name); if (!active.some(tool => tool.name === name)) active.push(byName.get(name)!); }
      active.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, data: { enabled: names } };
    },
  };
  const capabilityIndex = (() => {
    const all: { key: string; owner: string; descriptor: CapabilityDescriptor }[] = [];
    for (const tool of authorized) {
      for (const descriptor of tool.discovery?.capabilities ?? []) {
        all.push({ key: descriptor.id, owner: tool.discovery?.pluginId ?? tool.name, descriptor });
      }
    }
    const byKey = new Map<string, { key: string; owner: string; descriptor: CapabilityDescriptor }>();
    const conflicts: { capabilityId: string; shadowedBy: string }[] = [];
    for (const item of all.sort((a, b) => a.key.localeCompare(b.key) || a.owner.localeCompare(b.owner))) {
      const current = byKey.get(item.key);
      if (!current) byKey.set(item.key, item);
      else if (current.owner !== item.owner) conflicts.push({ capabilityId: item.key, shadowedBy: current.owner });
    }
    const state = states.get(active)!;
    state.conflicts = conflicts;
    return { entries: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), conflicts };
  })();

  active.push({
    version: '2.0.0', permissions: [],
    name: 'discover_tools', description: '查找已授权工具。query 省略或为空返回索引；details=true 返回完整契约，用 enable_tools 加载。', sideEffect: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, details: { type: 'boolean' } } },
    outputSchema: { type: 'object', properties: { tools: { type: 'array' } }, required: ['tools'] },
    async handler(args: { query?: string; limit?: number; offset?: number; details?: boolean }) {
      const query = String(args.query ?? '').toLowerCase().trim();
      const words = query.split(/[\s，、,]+/).filter(Boolean);
      const normalized = (text: string) => text.toLowerCase().replace(/[_\-\s]/g, '');
      const matches = authorized.map(tool => ({ tool, score: (tool.name.toLowerCase() === query ? 100 : 0) + (query && normalized(tool.name).includes(normalized(query)) ? 10 : 0) + words.reduce((sum, word) => sum + (tool.name.toLowerCase().includes(word) ? 3 : [tool.description, ...(tool.discovery?.keywords ?? []), tool.discovery?.pluginId ?? ''].join(' ').toLowerCase().includes(word) ? 1 : 0), 0) }))
        .filter(entry => !words.length || entry.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const offset = args.offset ?? 0, limit = Math.min(20, Math.max(1, args.limit ?? 10));
      return { ok: true, data: { total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null, tools: matches.slice(offset, offset + limit).map(({ tool }) => ({ name: tool.name, version: tool.version, description: tool.description, ...(tool.discovery ? { discovery: tool.discovery } : {}), ...(args.details ? { parameters: tool.parameters, outputSchema: tool.outputSchema, permissions: tool.permissions } : {}), sideEffect: tool.sideEffect, enabled: active.some(item => item.name === tool.name) })) } };
    },
  }, enableTools, {
    version: '3.0.0', permissions: [],
    name: 'discover_capabilities', description: '按用户意图查找任务级能力。返回能力说明和需要加载的底层工具；query 可省略以分页读取索引。', sideEffect: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    outputSchema: { type: 'object', properties: { capabilities: { type: 'array' }, conflicts: { type: 'array' } }, required: ['capabilities', 'conflicts'] },
    async handler(args: { query?: string; limit?: number; offset?: number }) {
      const query = String(args.query ?? '').toLowerCase().trim();
      const words = query.split(/[\s，、,]+/).filter(Boolean);
      const haystack = (item: { key: string; descriptor: CapabilityDescriptor }) => [
        item.key, item.descriptor.name, item.descriptor.description,
        ...(item.descriptor.aliases ?? []), ...(item.descriptor.inputs ?? []), ...(item.descriptor.outputs ?? []), ...(item.descriptor.examples ?? []),
      ].join(' ').toLowerCase();
      const matches = capabilityIndex.entries
        .map(item => ({ ...item, score: words.reduce((sum, word) => sum + (haystack(item).includes(word) ? 1 : 0), 0) }))
        .filter(item => !words.length || item.score > 0)
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.min(20, Math.max(1, args.limit ?? 10));
      return { ok: true, data: {
        total: matches.length,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
        capabilities: matches.slice(offset, offset + limit).map(item => ({ ...item.descriptor, id: item.key, availableTools: item.descriptor.tools.filter(name => byName.has(name)), enabledTools: item.descriptor.tools.filter(name => active.some(tool => tool.name === name)) })),
        conflicts: capabilityIndex.conflicts,
      } };
    },
  }, {
    version: '3.0.0', permissions: [],
    name: 'enable_capabilities', description: '加载一个或多个已发现能力所需的全部底层工具。不会扩大任务授权。', sideEffect: 'none',
    parameters: { type: 'object', properties: { ids: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } } }, required: ['ids'] },
    outputSchema: { type: 'object', properties: { enabledTools: { type: 'array' } }, required: ['enabledTools'] },
    async handler(args: { ids?: string[] }) {
      const ids = [...new Set(args.ids ?? [])];
      const selected = ids.flatMap(id => capabilityIndex.entries.filter(item => item.key === id));
      if (selected.length !== ids.length) return { ok: false, error: '包含不存在或未授权的能力', failure: { code: 'CAPABILITY_NOT_AUTHORIZED', retryable: false, outcome: 'not_started' as const } };
      const names = [...new Set(selected.flatMap(item => item.descriptor.tools).filter(name => byName.has(name)))];
      const enabled = await enableTools.handler({ names });
      if (!enabled.ok) return enabled;
      const state = states.get(active)!;
      for (const id of ids) state.selectedCapabilities.add(id);
      return { ok: true, data: { selected: ids, enabledTools: names } };
    },
  }, {
    version: '2.0.0', permissions: [], name: 'release_tools', description: '从后续模型输入释放工具 schema，不卸载插件或取消已发出的调用。', sideEffect: 'none',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] }, outputSchema: { type: 'object' },
    async handler(args: { names: string[] }) {
      const names = [...new Set(args.names)].filter(name => byName.has(name) && !REQUIRED_TOOLS.has(name));
      for (const name of names) released.add(name);
      for (let i = active.length - 1; i >= 0; i--) if (names.includes(active[i].name)) active.splice(i, 1);
      return { ok: true, data: { released: names } };
    },
  });
  let used = active.reduce((sum, tool) => sum + schemaTokens(tool), 0);
  for (const tool of authorized) {
    if (active.includes(tool) || released.has(tool.name) || !(tool.discovery?.initial ?? DEFAULT_TOOLS.has(tool.name))) continue;
    const tokens = schemaTokens(tool);
    if (used + tokens <= tokenBudget) { active.push(tool); used += tokens; }
  }
  active.sort((a, b) => a.name.localeCompare(b.name));
  return active;
}

/** Rebuild only at model-call boundaries; an issued batch retains its original definitions. */
export function refreshToolCatalog(active: ToolDef[], authorized: ToolDef[], budget: number): void {
  const enabled = active.map(tool => tool.name);
  const previous = states.get(active);
  const next = createToolCatalog(authorized, enabled, budget, releasedToolNames(active));
  for (const tool of next.filter(tool => ['enable_tools', 'release_tools', 'enable_capabilities'].includes(tool.name))) {
    const handler = tool.handler;
    tool.handler = async (args, ctx) => { const result = await handler(args, ctx); active.splice(0, active.length, ...next); return result; };
  }
  const nextState = states.get(next)!;
  for (const capability of previous?.selectedCapabilities ?? []) nextState.selectedCapabilities.add(capability);
  states.set(active, nextState);
  active.splice(0, active.length, ...next);
}
