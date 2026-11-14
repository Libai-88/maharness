import type { ToolDef } from './types';
import { estimateTokens } from './tokens';

const DEFAULT_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'command_start', 'command_output', 'command_wait', 'command_cancel', 'powershell_execute', 'web_search', 'web_fetch', 'recall_tool_result', 'search_history', 'read_history', 'run_subagent', 'run_parallel', 'run_review']);
const REQUIRED_TOOLS = new Set(['recall_tool_result']);
const schemaTokens = (tool: ToolDef) => estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));

/** The catalog only contains capabilities already authorized for this run. */
export function createToolCatalog(authorized: ToolDef[], restoredEnabled: string[] = [], tokenBudget = 4096): ToolDef[] {
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
  const active = authorized.filter(tool => small || REQUIRED_TOOLS.has(tool.name) || restored.has(tool.name));
  // Reserve space for discovery schemas; required/restored tools are never silently dropped.
  let used = active.reduce((sum, tool) => sum + schemaTokens(tool), 0) + 512;
  for (const name of DEFAULT_TOOLS) {
    const tool = byName.get(name);
    if (!tool) continue;
    if (active.includes(tool)) continue;
    const tokens = schemaTokens(tool);
    if (used + tokens <= tokenBudget) { active.push(tool); used += tokens; }
  }
  active.sort((a, b) => a.name.localeCompare(b.name));
  active.push({
    version: '2.0.0', permissions: [],
    name: 'discover_tools', description: '查找已授权工具。默认返回简短索引；details=true 返回完整契约，用 enable_tools 加载。', sideEffect: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, details: { type: 'boolean' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { tools: { type: 'array' } }, required: ['tools'] },
    async handler(args: { query?: string; limit?: number; offset?: number; details?: boolean }) {
      const query = String(args.query ?? '').toLowerCase().trim();
      const words = query.split(/[\s，、,]+/).filter(Boolean);
      const normalized = (text: string) => text.toLowerCase().replace(/[_\-\s]/g, '');
      const matches = authorized.map(tool => ({ tool, score: (tool.name.toLowerCase() === query ? 100 : 0) + (query && normalized(tool.name).includes(normalized(query)) ? 10 : 0) + words.reduce((sum, word) => sum + (tool.name.toLowerCase().includes(word) ? 3 : tool.description.toLowerCase().includes(word) ? 1 : 0), 0) }))
        .filter(entry => !words.length || entry.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const offset = args.offset ?? 0, limit = Math.min(20, Math.max(1, args.limit ?? 10));
      return { ok: true, data: { total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null, tools: matches.slice(offset, offset + limit).map(({ tool }) => ({ name: tool.name, description: tool.description, ...(args.details ? { parameters: tool.parameters, outputSchema: tool.outputSchema, permissions: tool.permissions } : {}), sideEffect: tool.sideEffect, enabled: active.some(item => item.name === tool.name) })) } };
    },
  }, {
    version: '2.0.0', permissions: [],
    name: 'enable_tools', description: '把已发现的工具加载到本任务的模型输入；不能扩大当前任务权限。', sideEffect: 'none',
    parameters: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'] },
    outputSchema: { type: 'object', properties: { enabled: { type: 'array', items: { type: 'string' } } }, required: ['enabled'] },
    async handler(args: { names?: string[] }) {
      const names = [...new Set(args.names ?? [])];
      if (names.some(name => !byName.has(name))) return { ok: false, error: '包含不存在或未授权的工具', failure: { code: 'TOOL_NOT_AUTHORIZED', retryable: false, outcome: 'not_started' } };
      for (const name of names) if (!active.some(tool => tool.name === name)) active.push(byName.get(name)!);
      active.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, data: { enabled: names } };
    },
  }, {
    version: '2.0.0', permissions: [], name: 'release_tools', description: '从后续模型输入释放工具 schema，不卸载插件或取消已发出的调用。', sideEffect: 'none',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] }, outputSchema: { type: 'object' },
    async handler(args: { names: string[] }) {
      const names = args.names.filter(name => !REQUIRED_TOOLS.has(name) && !['discover_tools', 'enable_tools', 'release_tools'].includes(name));
      for (let i = active.length - 1; i >= 0; i--) if (names.includes(active[i].name)) active.splice(i, 1);
      return { ok: true, data: { released: names } };
    },
  });
  return active;
}

/** Rebuild only at model-call boundaries; an issued batch retains its original definitions. */
export function refreshToolCatalog(active: ToolDef[], authorized: ToolDef[], budget: number): void {
  const enabled = active.map(tool => tool.name);
  const next = createToolCatalog(authorized, enabled, budget);
  // A refresh must not undo an explicit release by reapplying the initial defaults.
  const previous = new Set(enabled);
  for (let i = next.length - 1; i >= 0; i--) if (!previous.has(next[i].name) && !['discover_tools', 'enable_tools', 'release_tools', 'recall_tool_result'].includes(next[i].name)) next.splice(i, 1);
  for (const tool of next.filter(tool => ['enable_tools', 'release_tools'].includes(tool.name))) {
    const handler = tool.handler;
    tool.handler = async (args, ctx) => { const result = await handler(args, ctx); active.splice(0, active.length, ...next); return result; };
  }
  active.splice(0, active.length, ...next);
}
