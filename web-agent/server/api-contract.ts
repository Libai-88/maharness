/** API-01：公开 HTTP 契约的单一登记入口。响应体保持既有形状，版本通过响应头发布。 */
export const API_SCHEMA_VERSION = 1 as const;
export const API_SCHEMA_HEADER = 'X-API-Schema-Version' as const;

export type ApiResponseKind = 'object' | 'array' | 'sse' | 'empty';
export type ApiJsonSchema = Record<string, unknown>;
export interface ApiContractEntry {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  response: ApiResponseKind;
  description: string;
  schema: ApiJsonSchema;
}

const API_CONTRACT_ENTRIES: readonly Omit<ApiContractEntry, 'schema'>[] = [
  { method: 'GET', path: '/api/health', response: 'object', description: '进程存活与版本' },
  { method: 'GET', path: '/api/ready', response: 'object', description: '就绪检查' },
  { method: 'GET', path: '/api/storage', response: 'object', description: '存储容量状态' },
  { method: 'GET', path: '/api/sessions', response: 'array', description: '会话列表' },
  { method: 'POST', path: '/api/sessions', response: 'object', description: '创建会话' },
  { method: 'GET', path: '/api/sessions/:id/messages', response: 'array', description: '会话消息' },
  { method: 'PATCH', path: '/api/sessions/:id', response: 'object', description: '更新会话' },
  { method: 'DELETE', path: '/api/sessions/:id', response: 'object', description: '删除会话' },
  { method: 'POST', path: '/api/sessions/batch-delete', response: 'object', description: '批量删除会话' },
  { method: 'GET', path: '/api/sessions/:id/checkpoint', response: 'object', description: '断点信息' },
  { method: 'GET', path: '/api/providers', response: 'array', description: 'Provider 列表' },
  { method: 'POST', path: '/api/providers', response: 'object', description: '创建 Provider' },
  { method: 'PATCH', path: '/api/providers/:id', response: 'object', description: '更新 Provider' },
  { method: 'DELETE', path: '/api/providers/:id', response: 'object', description: '删除 Provider' },
  { method: 'POST', path: '/api/providers/test', response: 'object', description: '测试 Provider 连接' },
  { method: 'POST', path: '/api/providers/models', response: 'object', description: '拉取 Provider 模型' },
  { method: 'GET', path: '/api/providers/:id/models', response: 'array', description: '可选模型' },
  { method: 'PATCH', path: '/api/providers/:id/models', response: 'object', description: '更新模型画像' },
  { method: 'GET', path: '/api/models', response: 'array', description: '全局可选模型' },
  { method: 'GET', path: '/api/plugins', response: 'array', description: '插件状态' },
  { method: 'GET', path: '/api/plugins/diagnostics', response: 'array', description: '插件诊断' },
  { method: 'POST', path: '/api/plugins/:id/actions', response: 'object', description: '执行插件生命周期操作' },
  { method: 'POST', path: '/api/plugins/:id/open', response: 'object', description: '打开插件位置' },
  { method: 'GET', path: '/api/plugins/:id/config', response: 'object', description: '读取插件配置' },
  { method: 'GET', path: '/api/capabilities', response: 'object', description: '能力注册表' },
  { method: 'GET', path: '/api/nav', response: 'object', description: '插件导航贡献' },
  { method: 'GET', path: '/api/trace', response: 'object', description: 'Trace 分页结果' },
  { method: 'GET', path: '/api/stats', response: 'object', description: '运行统计' },
  { method: 'GET', path: '/api/approvals', response: 'object', description: '待审批清单' },
  { method: 'POST', path: '/api/approvals/:id', response: 'object', description: '回答审批' },
  { method: 'GET', path: '/api/security', response: 'object', description: '安全姿态' },
  { method: 'GET', path: '/api/security/audit', response: 'object', description: '授权审计' },
  { method: 'GET', path: '/api/config', response: 'object', description: '运行配置' },
  { method: 'PATCH', path: '/api/config', response: 'object', description: '更新运行配置' },
  { method: 'GET', path: '/api/meta/paths', response: 'object', description: '路径元数据' },
  { method: 'POST', path: '/api/meta/open', response: 'object', description: '打开路径' },
  { method: 'GET', path: '/api/commands/list', response: 'object', description: '斜杠命令列表' },
  { method: 'POST', path: '/api/commands', response: 'object', description: '执行斜杠命令' },
  { method: 'GET', path: '/api/commands', response: 'object', description: '命令兼容入口' },
  { method: 'GET', path: '/api/files/tree', response: 'object', description: '文件树' },
  { method: 'GET', path: '/api/files', response: 'object', description: '文件元数据' },
  { method: 'GET', path: '/api/files/read', response: 'object', description: '读取文件' },
  { method: 'POST', path: '/api/files/write', response: 'object', description: '写入文件' },
  { method: 'GET', path: '/api/files/search', response: 'object', description: '搜索文件' },
  { method: 'POST', path: '/api/files/open', response: 'object', description: '打开文件' },
  { method: 'GET', path: '/api/git/status', response: 'object', description: 'Git 状态' },
  { method: 'POST', path: '/api/git/commit', response: 'object', description: 'Git 提交' },
  { method: 'POST', path: '/api/git/push', response: 'object', description: 'Git 推送' },
  { method: 'GET', path: '/api/workspaces', response: 'array', description: '工作区列表' },
  { method: 'POST', path: '/api/workspaces', response: 'object', description: '登记工作区' },
  { method: 'DELETE', path: '/api/workspaces/:id', response: 'object', description: '删除工作区' },
  { method: 'POST', path: '/api/workspaces/switch', response: 'object', description: '切换工作区' },
  { method: 'GET', path: '/api/rules', response: 'object', description: '规则集合' },
  { method: 'PUT', path: '/api/rules/global/:name', response: 'object', description: '更新全局规则' },
  { method: 'PUT', path: '/api/rules/project', response: 'object', description: '更新项目规则' },
  { method: 'PUT', path: '/api/rules/policy', response: 'object', description: '更新策略规则' },
  { method: 'GET', path: '/api/personas', response: 'array', description: '人设列表' },
  { method: 'GET', path: '/api/personas/preview', response: 'object', description: '人设预览' },
  { method: 'POST', path: '/api/personas', response: 'object', description: '创建人设' },
  { method: 'PATCH', path: '/api/personas/:id', response: 'object', description: '更新人设' },
  { method: 'DELETE', path: '/api/personas/:id', response: 'object', description: '删除人设' },
  { method: 'GET', path: '/api/skills', response: 'object', description: '技能列表（installed + market）' },
  { method: 'GET', path: '/api/skills/lock', response: 'object', description: '技能锁定状态' },
  { method: 'GET', path: '/api/skills/usage', response: 'object', description: '技能使用统计' },
  { method: 'POST', path: '/api/skills/sync', response: 'object', description: '同步技能' },
  { method: 'POST', path: '/api/skills/install', response: 'object', description: '安装技能' },
  { method: 'POST', path: '/api/skills/:name/uninstall', response: 'object', description: '卸载技能' },
  { method: 'GET', path: '/api/skills/:source/:name/read', response: 'object', description: '读取技能' },
  { method: 'GET', path: '/api/evolve/proposals', response: 'array', description: '技能提案' },
  { method: 'POST', path: '/api/evolve/:id/accept', response: 'object', description: '接受技能提案' },
  { method: 'POST', path: '/api/evolve/:id/reject', response: 'object', description: '拒绝技能提案' },
  { method: 'POST', path: '/api/evolve/:id/delete', response: 'object', description: '删除技能提案' },
  { method: 'GET', path: '/api/trace/stats', response: 'object', description: 'Trace 统计' },
  { method: 'GET', path: '/api/providers/:id/diagnose', response: 'object', description: 'Provider 诊断' },
  { method: 'GET', path: '/api/events', response: 'sse', description: '全局事件流' },
  { method: 'POST', path: '/api/sessions/:id/chat', response: 'sse', description: '会话事件流' },
];

const SCHEMA_BY_ROUTE: Record<string, ApiJsonSchema> = {
  'GET /api/health': { type: 'object', required: ['ok', 'version'], properties: { ok: { type: 'boolean' }, version: { type: 'string' } } },
  'GET /api/ready': {
    type: 'object',
    required: ['schemaVersion', 'ok', 'checks'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      ok: { type: 'boolean' },
      checks: {
        type: 'object',
        required: ['kernel', 'database', 'providers', 'plugins', 'storage'],
        properties: {
          kernel: { type: 'boolean' }, database: { type: 'boolean' }, providers: { type: 'boolean' },
          plugins: { type: 'boolean' }, storage: { type: 'boolean' },
        },
      },
      resources: {
        type: 'object',
        required: ['activeRuns', 'sseConnections', 'pageConnections', 'pendingApprovals', 'activeWarmups', 'activeSubagentSlots'],
        properties: {
          activeRuns: { type: 'integer', minimum: 0 },
          sseConnections: { type: 'integer', minimum: 0 },
          pageConnections: { type: 'integer', minimum: 0 },
          pendingApprovals: { type: 'integer', minimum: 0 },
          activeWarmups: { type: 'integer', minimum: 0 },
          activeSubagentSlots: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
  'GET /api/storage': {
    type: 'object',
    required: ['schemaVersion', 'ok', 'status', 'totalBytes', 'freeBytes', 'freePercent', 'thresholds'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      ok: { type: 'boolean' },
      status: { type: 'string', enum: ['ok', 'warning', 'critical', 'unknown'] },
      totalBytes: { type: ['integer', 'null'], minimum: 0 },
      freeBytes: { type: ['integer', 'null'], minimum: 0 },
      freePercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
      thresholds: {
        type: 'object',
        required: ['warningFreePercent', 'criticalFreePercent'],
        properties: { warningFreePercent: { type: 'number' }, criticalFreePercent: { type: 'number' } },
      },
    },
  },
  'GET /api/trace': { type: 'object', required: ['steps', 'source'], properties: { steps: { type: 'array' }, source: { type: 'string' } } },
  'GET /api/nav': { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
  'GET /api/capabilities': { type: 'object', required: ['tools', 'contexts', 'personas', 'byRisk'], properties: { tools: { type: 'array' }, contexts: { type: 'array' }, personas: { type: 'array' }, byRisk: { type: 'object' } } },
  'GET /api/plugins/:id/config': { type: 'object', required: ['id', 'config', 'schema'], properties: { id: { type: 'string' }, config: { type: 'object' }, schema: { type: ['object', 'null'] } } },
  'POST /api/plugins/:id/actions': { type: 'object', required: ['ok', 'state'], properties: { ok: { type: 'boolean' }, state: { type: 'string' } } },
  'POST /api/plugins/:id/open': { type: 'object', required: ['ok', 'path'], properties: { ok: { type: 'boolean' }, path: { type: 'string' } } },
};

export const API_CONTRACT_V1: readonly ApiContractEntry[] = API_CONTRACT_ENTRIES.map((entry) => ({
  ...entry,
  schema: SCHEMA_BY_ROUTE[`${entry.method} ${entry.path}`] ?? { type: entry.response === 'array' ? 'array' : entry.response === 'object' ? 'object' : entry.response === 'empty' ? 'null' : 'object' },
}));

export function apiContractFor(method: string, path: string): ApiContractEntry | undefined {
  const normalized = path.replace(/^\/api\/plugins\/[^/]+/, '/api/plugins/:id');
  return API_CONTRACT_V1.find((entry) => entry.method === method.toUpperCase() && entry.path === normalized);
}

export function setApiSchemaHeaders(res: { setHeader(name: string, value: string): void }): void {
  res.setHeader(API_SCHEMA_HEADER, String(API_SCHEMA_VERSION));
}
