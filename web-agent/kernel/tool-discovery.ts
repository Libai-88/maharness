import type { ToolDef } from './types';
import { estimateTokens } from './tokens';

const DEFAULT_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'command_start', 'command_output', 'command_wait', 'command_cancel', 'powershell_execute', 'web_search', 'web_fetch', 'recall_tool_result', 'search_history', 'read_history', 'run_subagent', 'run_parallel', 'run_review']);
const REQUIRED_TOOLS = new Set(['recall_tool_result']);
const MANAGERS = new Set(['discover_tools', 'enable_tools', 'release_tools']);
const states = new WeakMap<ToolDef[], Set<string>>();
export const toolCatalogBudget = (contextWindow: number) => Math.min(4096, Math.max(0, Math.floor(contextWindow * 0.85 * 0.1)));
export const releasedToolNames = (active: ToolDef[]) => [...(states.get(active) ?? [])].sort();
const schemaTokens = (tool: ToolDef) => estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));

/** The catalog only contains capabilities already authorized for this run. */
export function createToolCatalog(authorized: ToolDef[], restoredEnabled: string[] = [], tokenBudget = 4096, restoredReleased: string[] = []): ToolDef[] {
  const byName = new Map<string, ToolDef>();
  for (const tool of authorized) {
    if (['discover_tools', 'enable_tools', 'release_tools'].includes(tool.name)) throw new Error('TOOL_DEFINITION_CONFLICT: ' + tool.name);
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
  states.set(active, released);
  if (small && active.length === authorized.length) return active;
  // Reserve space for discovery schemas; required/restored tools are never silently dropped.
  // Manager schema cost is measured below before choosing initial tools.
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
  }, {
    version: '2.0.0', permissions: [],
    name: 'enable_tools', description: '把已发现的工具加载到本任务的模型输入；不能扩大当前任务权限。', sideEffect: 'none',
    parameters: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'] },
    outputSchema: { type: 'object', properties: { enabled: { type: 'array', items: { type: 'string' } } }, required: ['enabled'] },
    async handler(args: { names?: string[] }) {
      const names = [...new Set(args.names ?? [])];
      if (names.some(name => !byName.has(name))) return { ok: false, error: '包含不存在或未授权的工具', failure: { code: 'TOOL_NOT_AUTHORIZED', retryable: false, outcome: 'not_started' } };
      for (const name of names) { released.delete(name); if (!active.some(tool => tool.name === name)) active.push(byName.get(name)!); }
      active.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, data: { enabled: names } };
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
  const next = createToolCatalog(authorized, enabled, budget, releasedToolNames(active));
  for (const tool of next.filter(tool => ['enable_tools', 'release_tools'].includes(tool.name))) {
    const handler = tool.handler;
    tool.handler = async (args, ctx) => { const result = await handler(args, ctx); active.splice(0, active.length, ...next); return result; };
  }
  states.set(active, states.get(next)!);
  active.splice(0, active.length, ...next);
}
