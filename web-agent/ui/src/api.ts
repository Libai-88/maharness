// ui/src/api.ts —— 后端通信（REST + SSE 流式解析，自研）
import type { BridgeInfo, BusEvent, CheckpointInfo, CommandInfo, LockSkill, Message, ModelInfo, PersonaInfo, PlanState, PluginInfo, PluginNavItem, ProviderForm, ProviderInfo, PulledModel, Session, SkillProposal, SkillUsageRow, StatsInfo, TraceStep, TreeEntry, WorkspaceInfo } from './types';

export async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ---------- SSE 流式对话 ----------

export interface ChatHandlers {
  onStart(traceId: string): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  /** id = tool_call_id：同名并发调用靠它配对，不会把两次 read_file 结算成一张卡 */
  onToolStart(id: string | undefined, name: string, args: unknown): void;
  onToolResult(id: string | undefined, name: string, summary: string, ok: boolean, stored?: boolean): void;
  onApprovalRequired(approvalId: string, name: string, summary: string): void;
  onDone(d: { content: string; reasoning?: string; usage: { input: number; output: number }; cost: number; cached?: boolean }): void;
  /** 角色移交（handoff）：会话控制权交给目标角色 */
  onHandoff?(role: string, objective: string): void;
  /** 成本熔断（budget_hit）：harness 硬边界触发 */
  onBudgetHit?(cost: number, budget: number): void;
  /** provider 重试（retry）：当前流式作废重新开始——调用方应清空流式内容重新累积。
   *  reason 让"作废"不再无声：换线路 / 刚才没接上 / 重新用真方式调用。 */
  onRetry?(reason: 'attempt' | 'failover' | 'narration', detail?: string): void;
  /** 前置重活播报（如历史压缩）：让"开口前的十几秒"有话说 */
  onStatus?(text: string): void;
  /** kind=aborted：是用户自己按的停止，不是故障，调用方不得画成红色报错 */
  onError(e: string, kind?: ErrorKind): void;
  onEnd(): void;
}

export type ErrorKind = 'aborted' | 'budget' | 'max-turns' | 'policy' | 'upstream' | 'network' | 'busy';

/** retry 事件由 App 侧 onRetry handler 处理：App 持有 rAF 合帧缓冲，
 *  能在 retry 时刻算出含未冲刷增量的精确截断边界（retryMarks 状态传给展示层） */

/** POST 流式聊天：fetch + ReadableStream 逐块解析 SSE（EventSource 不支持 POST，故自研）
 *  body.resume=true 时从断点历史继续（checkpoint 断点续跑，不需要 message） */
export async function streamChat(
  sessionId: string,
  body: { message?: string; model?: string; provider?: string; resume?: boolean },
  h: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  /** 用户主动停止（abort）→ 温和收尾，不报"连接中断" */
  const stopped = () => signal?.aborted === true;
  const fail = (msg: string, kind: ErrorKind = 'upstream') => h.onError(msg, stopped() ? 'aborted' : kind);

  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (stopped() || isAbortLike(err)) { h.onError('已停止', 'aborted'); return; }
    fail('网络没接上', 'network');
    return;
  }
  if (res.status === 409) { h.onError('该会话有任务进行中', 'busy'); return; }
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* 忽略 */ }
    fail(msg);
    return;
  }
  if (!res.body) { fail('响应无内容'); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // 服务端结束标记（'end' 事件）；流中途断开时据此兜底触发 onError——
  // 否则全局 streaming 状态永远不复位（输入区卡死）
  let endSeen = false;
  let transportBroke = false;
  let errSeen = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let data: unknown;
        try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
        const d = data as Record<string, unknown>;
        switch (event) {
          case 'start': h.onStart(String(d.traceId ?? '')); break;
          case 'status': h.onStatus?.(String(d.text ?? '')); break;
          case 'delta': h.onDelta(String(d.text ?? '')); break;
          case 'reasoning': h.onReasoning(String(d.text ?? '')); break;
          case 'tool_start': h.onToolStart(d.id ? String(d.id) : undefined, String(d.name ?? ''), d.args); break;
          case 'approval_required': h.onApprovalRequired(String(d.approvalId ?? ''), String(d.name ?? ''), String(d.summary ?? '')); break;
          case 'tool_result': h.onToolResult(d.id ? String(d.id) : undefined, String(d.name ?? ''), String(d.summary ?? ''), Boolean(d.ok), Boolean(d.stored)); break;
          case 'done': h.onDone(d as { content: string; usage: { input: number; output: number }; cost: number; cached?: boolean }); break;
          case 'handoff': h.onHandoff?.(String(d.role ?? ''), String(d.objective ?? '')); break;
          case 'budget_hit': h.onBudgetHit?.(Number(d.cost ?? 0), Number(d.budget ?? 0)); break;
          case 'retry':
            // provider 重试：透传给 handler（App 记录截断边界，展示层从该边界重新累积）
            h.onRetry?.((d.reason as 'attempt' | 'failover' | 'narration') ?? 'attempt', d.detail ? String(d.detail) : undefined);
            break;
          case 'error':
            errSeen = true;
            h.onError(String(d.error ?? '未知错误'), (d.kind as ErrorKind | undefined) ?? 'upstream');
            break;
          case 'end': endSeen = true; h.onEnd(); break;
        }
      }
    }
  } catch (err) {
    // 传输层中断：区分「用户按了停止」与「真的断线」——两者都该复位 streaming，
    // 但只有后者才是错误（旧版一律报"连接中断"，等于把用户的取消说成系统故障）
    transportBroke = true;
    if (stopped() || isAbortLike(err)) h.onError('已停止', 'aborted');
    else h.onError('连接中断', 'network');
  } finally {
    reader.releaseLock();
  }
  // 流读完但服务端未发 end（进程崩溃/连接被掐断）：同样兜底，streaming 不复位会锁死输入区
  if (!endSeen && !transportBroke && !errSeen) fail('话说到一半断了', 'network');
}

/** AbortError 判定：不同浏览器/实现下 name 与 message 都可能是取消信号 */
function isAbortLike(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return name === 'AbortError' || /abort(ed)?/i.test(msg);
}

// ---------- 全局事件订阅（Trace 实时面板） ----------

/** 全局事件订阅（Trace 实时面板 / plan / todo / 审批 / provider 健康）。
 *  onState 把"这条常驻连接到底通不通"告诉调用方——断线时界面该有反应，
 *  而不是"实时"灯常亮、数据其实早就不动了。浏览器会自动重连，这里只报状态。 */
export function subscribeEvents(onEvent: (e: BusEvent) => void, onState?: (s: 'open' | 'down') => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => onState?.('open'));
  es.addEventListener('error', () => onState?.('down'));
  es.addEventListener('event', (ev) => {
    try { onEvent(JSON.parse((ev as MessageEvent).data) as BusEvent); } catch { /* 忽略 */ }
  });
  return () => es.close();
}

// ---------- 会话 ----------

export const sessionApi = {
  list: () => api<Session[]>('/api/sessions'),
  create: (model: string) => api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ model }) }),
  rename: (id: string, title: string) => api<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  update: (id: string, patch: Partial<{ title: string; model: string; provider: string; mode: string; role: string; archived: boolean | number; pinned: boolean | number }>) =>
    api<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  batchRemove: (ids: string[]) => api<{ ok: boolean; removed: number }>('/api/sessions/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  messages: (id: string) => api<Message[]>(`/api/sessions/${id}/messages`),
  /** 断点状态（checkpoint：任务中断后「继续任务」入口的数据源） */
  checkpoint: (id: string) => api<CheckpointInfo>(`/api/sessions/${id}/checkpoint`),
};

/** 斜杠命令执行结果 */
export interface CommandResult {
  ok: boolean;
  type?: 'action' | 'message';
  data?: { action?: string; mode?: string; provider?: string; model?: string; text?: string };
  error?: string;
}

export const commandsApi = {
  exec: (input: string, sessionId: string) =>
    api<CommandResult>('/api/commands', { method: 'POST', body: JSON.stringify({ input, sessionId }) }),
  list: () => api<{ commands: CommandInfo[] }>('/api/commands/list'),
};

export const statsApi = {
  get: () => api<StatsInfo>('/api/stats'),
};

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user';
}

export const skillsApi = {
  list: () => api<{ installed: SkillInfo[]; market: { name: string; description: string }[] }>('/api/skills'),
  install: (name: string) => api<{ ok: boolean }>('/api/skills/install', { method: 'POST', body: JSON.stringify({ name }) }),
  uninstall: (name: string) => api<{ ok: boolean }>(`/api/skills/${name}/uninstall`, { method: 'POST' }),
  read: (name: string, source: string) =>
    api<{ name: string; content: string }>(`/api/skills/${source}/${name}/read`),
  /** skills-lock.json（GitHub 源 + 哈希锁）的可同步清单 */
  lock: () => api<{ file: string | null; error?: string; count: number; skills: LockSkill[] }>('/api/skills/lock'),
  /** 按锁文件安装（默认只装缺失项；force 覆盖并放行哈希不符） */
  sync: (body?: { names?: string[]; force?: boolean }) =>
    api<{ ok: boolean; results: { name: string; ok: boolean; installed?: boolean; skipped?: string; mismatch?: boolean; error?: string }[] }>(
      '/api/skills/sync', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  usage: () => api<{ usage: Record<string, SkillUsageRow> }>('/api/skills/usage'),
};

/** 自进化：技能提案的确认回路 */
export const evolveApi = {
  list: () => api<{ proposals: SkillProposal[]; pending: number; toolStats: Record<string, { calls: number; fails: number; lastFailTs: number }> }>('/api/evolve/proposals'),
  accept: (id: string) => api<{ ok: boolean; name?: string; error?: string }>(`/api/evolve/${id}/accept`, { method: 'POST' }),
  reject: (id: string) => api<{ ok: boolean; error?: string }>(`/api/evolve/${id}/reject`, { method: 'POST' }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/evolve/${id}/delete`, { method: 'POST' }),
};

/** 用户规则：全局/项目提示规则文件 + 策略规则 */
export interface RuleFileInfo { name: string; content: string }
export interface RulesView {
  paths: { globalDir: string; globalPolicy: string; projectRoot: string };
  policy: { id: string; effect: string; tool: string; argPattern?: string; pathPattern?: string; reason?: string; enabled?: boolean }[];
  policyFiles: string[];
  errors: string[];
  globalFiles: RuleFileInfo[];
  projectFiles: RuleFileInfo[];
  promptChars: number;
}

export const rulesApi = {
  get: () => api<RulesView>('/api/rules'),
  putGlobal: (name: string, content: string) =>
    api<{ ok: boolean }>(`/api/rules/global/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  putProject: (path: string, content: string) =>
    api<{ ok: boolean }>('/api/rules/project', { method: 'PUT', body: JSON.stringify({ path, content }) }),
  putPolicy: (scope: 'global' | 'project', rules: RulesView['policy']) =>
    api<{ ok: boolean; error?: string }>('/api/rules/policy', { method: 'PUT', body: JSON.stringify({ scope, rules }) }),
};

export const workspacesApi = {
  list: () => api<WorkspaceInfo[]>('/api/workspaces'),
  add: (path: string) => api<{ id: string; path: string }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  switchTo: (path: string) => api<{ ok: boolean; current: string }>('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ path }) }),
};

export const fileApi = {
  tree: (path: string) => api<{ path: string; entries: TreeEntry[] }>(`/api/files/tree?path=${encodeURIComponent(path)}`),
  read: (path: string) => api<{ path: string; text: string; encoding: string }>(`/api/files/read?path=${encodeURIComponent(path)}`),
  write: (path: string, content: string) => api<{ ok: boolean; path: string }>('/api/files/write', { method: 'POST', body: JSON.stringify({ path, content }) }),
  search: (q: string) => api<{ query: string; results: { path: string; size: number }[] }>(`/api/files/search?q=${encodeURIComponent(q)}`),
  open: (path: string) => api<{ ok: boolean; path: string }>('/api/files/open', { method: 'POST', body: JSON.stringify({ path }) }),
};

/** 沙箱 git（状态 / 提交 / 推送） */
export interface GitStatus {
  repo: boolean;
  branch: string;
  ahead: number;
  staged: { path: string; status: string }[];
  changes: { path: string; status: string }[];
}

export const gitApi = {
  status: () => api<GitStatus>('/api/git/status'),
  commit: (message: string) => api<{ ok: boolean }>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) }),
  // 服务端契约：push 改变远端共享状态，要求显式 confirm:true 确认（不传必 400）
  push: () => api<{ ok: boolean }>('/api/git/push', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
};

/** 运行时配置（上下文管理 / 缓存参数 / 思维链预算与语言 / 模型路由） */
export interface RoutingTarget {
  value: string;
  label: string;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  contextWindow: number;
}

export interface RuntimeConfig {
  context: { maxTokens: number; truncateInject: boolean };
  cache: { l1Threshold: number; l2TtlMin: number; l3Enabled: boolean };
  agent: { reasoningBudget: number; reasoningTotalBudget: number; thinkInEnglish: boolean; modelRouting: Record<string, string> };
  routingTargets?: RoutingTarget[];
  taskTypes?: string[];
}

export const configApi = {
  get: () => api<RuntimeConfig>('/api/config'),
  patch: (patch: { context?: Partial<RuntimeConfig['context']>; cache?: Partial<RuntimeConfig['cache']>; agent?: Partial<RuntimeConfig['agent']> }) =>
    api<{ ok: boolean }>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }),
};

/** 元信息（数据/审计目录路径） */
export const metaApi = {
  paths: () => api<{ sandboxRoot: string; dbFile: string; tracesDir: string; configFile: string }>('/api/meta/paths'),
  open: (kind: string) => api<{ ok: boolean; kind: string; path: string }>('/api/meta/open', { method: 'POST', body: JSON.stringify({ kind }) }),
};

export const approvalsApi = {
  respond: (id: string, approved: boolean) => api<{ ok: boolean }>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approved }) }),
  /** 挂起清单：刷新页面后审批卡原位复原（可按会话过滤）——服务端在等，用户必须看得见 */
  list: (sessionId?: string) =>
    api<{ pending: { id: string; name: string; summary: string; sessionId?: string; createdAt: number; expiresAt: number; waitedMs: number; expiresInMs: number }[] }>(
      sessionId ? `/api/approvals?sessionId=${encodeURIComponent(sessionId)}` : '/api/approvals'),
};

export const modelsApi = {
  list: () => api<ModelInfo[]>('/api/models'),
};

export const providersApi = {
  list: () => api<ProviderInfo[]>('/api/providers'),
  create: (form: ProviderForm) => api<ProviderInfo>('/api/providers', { method: 'POST', body: JSON.stringify(form) }),
  update: (id: string, form: Partial<ProviderForm> & { enabled?: boolean }) =>
    api<ProviderInfo>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(form) }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  test: (body: { baseUrl: string; apiKey: string; model: string; protocol?: string; providerId?: string }) =>
    api<{ ok: boolean; latencyMs?: number; message?: string; error?: string; authFailed?: boolean }>('/api/providers/test', { method: 'POST', body: JSON.stringify(body) }),
  /** 拉取供应商模型与能力（openai / anthropic / ollama 三协议）；编辑已保存供应商时 Key 可留空 */
  fetchModels: (body: { baseUrl: string; apiKey: string; protocol?: string; providerId?: string; persist?: boolean }) =>
    api<{ ok: boolean; protocol?: string; count?: number; models: PulledModel[] }>('/api/providers/models', { method: 'POST', body: JSON.stringify(body) }),
  /** 手改单个模型的能力位/价格（模型名走 query，可含 / 与 : ） */
  patchModel: (id: string, modelId: string, body: Record<string, unknown>) =>
    api<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}/models?model=${encodeURIComponent(modelId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

export const personasApi = {
  list: () => api<PersonaInfo[]>('/api/personas'),
  create: (body: { name: string; content: string }) => api<PersonaInfo>('/api/personas', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<{ name: string; content: string; enabled: boolean }>) =>
    api<PersonaInfo>(`/api/personas/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/personas/${id}`, { method: 'DELETE' }),
};

export const pluginsApi = {
  list: () => api<PluginInfo[]>('/api/plugins'),
  action: (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') =>
    api<{ ok: boolean; state: string }>(`/api/plugins/${id}/actions`, { method: 'POST', body: JSON.stringify({ action }) }),
  open: (id: string) => api<{ ok: boolean; path: string }>(`/api/plugins/${id}/open`, { method: 'POST' }),
};

/** 插件声明的前端标签页（声明式导航）：前端遍历它生成导航，不硬编码任何插件页面 */
export const navApi = {
  list: () => api<{ items: PluginNavItem[] }>('/api/nav'),
  /** panel 模式：取插件的 HTML 片段 */
  panel: (url: string) => api<{ title: string; html: string }>(url),
};

export const traceApi = {
  stats: () => api<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean }>('/api/trace/stats'),
  byTraceId: (traceId: string) => api<{ steps: TraceStep[] }>(`/api/trace?trace_id=${encodeURIComponent(traceId)}`),
};

/** 目标计划（goal-plan 插件）：计划只活在插件内存里，刷新后靠这个端点把卡找回来 */
export const planApi = {
  get: (sessionId: string) => api<{ plan: PlanState | null }>(`/api/plugins/goal-plan/plan?sessionId=${encodeURIComponent(sessionId)}`),
};

/** 办公工作台（workbench 插件）：桥接状态。
 *  仅插件详情用途保留；工作台标签页由插件声明的 nav.status 端点驱动（前端通用轮询）。 */
export const workbenchApi = {
  bridge: () => api<BridgeInfo>('/api/plugins/workbench/wb/bridge'),
};
