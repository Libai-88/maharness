import type { ToolDef } from './types';
import { estimateTokens } from './tokens';

const DEFAULT_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'command_start', 'command_output', 'command_wait', 'command_cancel', 'powershell_execute', 'web_search', 'web_fetch', 'recall_tool_result', 'search_history', 'read_history', 'run_subagent', 'run_parallel', 'run_review']);
const REQUIRED_TOOLS = new Set(['recall_tool_result']);
const schemaTokens = (tool: ToolDef) => estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));

/** The catalog only contains capabilities already authorized for this run. */
export function createToolCatalog(authorized: ToolDef[], restoredEnabled: string[] = [], tokenBudget = 4096): ToolDef[] {
  const byName = new Map<string, ToolDef>();
  for (const tool of authorized) {
    const previous = byName.get(tool.name);
    if (previous && (previous.handler !== tool.handler || previous.assessApproval !== tool.assessApproval || JSON.stringify({ ...previous, handler: undefined }) !== JSON.stringify({ ...tool, handler: undefined })))
      throw new Error('TOOL_DEFINITION_CONFLICT: ' + tool.name);
    byName.set(tool.name, tool);
  }
  authorized = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (authorized.reduce((sum, tool) => sum + schemaTokens(tool), 0) <= tokenBudget) return authorized;
  const restored = new Set(restoredEnabled);
  const active = authorized.filter(tool => REQUIRED_TOOLS.has(tool.name) || restored.has(tool.name));
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
    name: 'discover_tools', description: '按用途或名称查找当前授权范围内的工具；返回 schema，随后可用 enable_tools 加载。', sideEffect: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { tools: { type: 'array' } }, required: ['tools'] },
    async handler(args: { query?: string; limit?: number }) {
      const query = String(args.query ?? '').toLowerCase().trim();
      const words = query.split(/[\s，、,]+/).filter(Boolean);
      const normalized = (text: string) => text.toLowerCase().replace(/[_\-\s]/g, '');
      const matches = authorized.map(tool => ({ tool, score: (tool.name.toLowerCase() === query ? 100 : 0) + (query && normalized(tool.name).includes(normalized(query)) ? 10 : 0) + words.reduce((sum, word) => sum + (tool.name.toLowerCase().includes(word) ? 3 : tool.description.toLowerCase().includes(word) ? 1 : 0), 0) }))
        .filter(entry => !words.length || entry.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, Math.min(20, Math.max(1, args.limit ?? 10)));
      return { ok: true, data: { tools: matches.map(({ tool }) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, outputSchema: tool.outputSchema, sideEffect: tool.sideEffect, enabled: active.some(item => item.name === tool.name) })) } };
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
  });
  return active;
}
