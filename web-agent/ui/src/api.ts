// ui/src/api.ts —— 后端通信（REST + SSE 流式解析，自研）
import type { BusEvent, CommandInfo, Message, ModelInfo, PersonaInfo, PluginInfo, ProviderForm, ProviderInfo, Session, StatsInfo, TraceStep, TreeEntry, WorkspaceInfo } from './types';

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
  onToolStart(name: string, args: unknown): void;
  onToolResult(name: string, summary: string, ok: boolean): void;
  onApprovalRequired(approvalId: string, name: string, summary: string): void;
  onDone(d: { content: string; reasoning?: string; usage: { input: number; output: number }; cost: number; cached?: boolean }): void;
  onError(e: string): void;
  onEnd(): void;
}

/** POST 流式聊天：fetch + ReadableStream 逐块解析 SSE（EventSource 不支持 POST，故自研） */
export async function streamChat(
  sessionId: string,
  body: { message: string; model?: string; provider?: string },
  h: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    h.onError('网络错误或已中断');
    return;
  }
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* 忽略 */ }
    h.onError(msg);
    return;
  }
  if (!res.body) { h.onError('响应无内容'); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
          case 'delta': h.onDelta(String(d.text ?? '')); break;
          case 'reasoning': h.onReasoning(String(d.text ?? '')); break;
          case 'tool_start': h.onToolStart(String(d.name ?? ''), d.args); break;
          case 'approval_required': h.onApprovalRequired(String(d.approvalId ?? ''), String(d.name ?? ''), String(d.summary ?? '')); break;
          case 'tool_result': h.onToolResult(String(d.name ?? ''), String(d.summary ?? ''), Boolean(d.ok)); break;
          case 'done': h.onDone(d as { content: string; usage: { input: number; output: number }; cost: number; cached?: boolean }); break;
          case 'error': h.onError(String(d.error ?? '未知错误')); break;
          case 'end': h.onEnd(); break;
        }
      }
    }
  } catch {
    // 中断或网络异常
  } finally {
    reader.releaseLock();
  }
}

// ---------- 全局事件订阅（Trace 实时面板） ----------

export function subscribeEvents(onEvent: (e: BusEvent) => void): () => void {
  const es = new EventSource('/api/events');
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
  update: (id: string, patch: Partial<{ title: string; model: string; mode: string; archived: boolean | number; pinned: boolean | number }>) =>
    api<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  batchRemove: (ids: string[]) => api<{ ok: boolean; removed: number }>('/api/sessions/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  messages: (id: string) => api<Message[]>(`/api/sessions/${id}/messages`),
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
  push: () => api<{ ok: boolean }>('/api/git/push', { method: 'POST' }),
};

/** 运行时配置（上下文管理 / 缓存参数） */
export interface RuntimeConfig {
  context: { maxTokens: number; truncateInject: boolean };
  cache: { l1Threshold: number; l2TtlMin: number; l3Enabled: boolean };
}

export const configApi = {
  get: () => api<RuntimeConfig>('/api/config'),
  patch: (patch: { context?: Partial<RuntimeConfig['context']>; cache?: Partial<RuntimeConfig['cache']> }) =>
    api<{ ok: boolean }>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }),
};

/** 元信息（数据/审计目录路径） */
export const metaApi = {
  paths: () => api<{ sandboxRoot: string; dbFile: string; tracesDir: string; configFile: string }>('/api/meta/paths'),
  open: (kind: string) => api<{ ok: boolean; kind: string; path: string }>('/api/meta/open', { method: 'POST', body: JSON.stringify({ kind }) }),
};

export const approvalsApi = {
  respond: (id: string, approved: boolean) => api<{ ok: boolean }>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approved }) }),
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
  test: (body: { baseUrl: string; apiKey: string; model: string; providerId?: string }) =>
    api<{ ok: boolean; message?: string; error?: string }>('/api/providers/test', { method: 'POST', body: JSON.stringify(body) }),
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
  action: (id: string, action: 'enable' | 'disable' | 'reload') =>
    api<{ ok: boolean; state: string }>(`/api/plugins/${id}/actions`, { method: 'POST', body: JSON.stringify({ action }) }),
  open: (id: string) => api<{ ok: boolean; path: string }>(`/api/plugins/${id}/open`, { method: 'POST' }),
};

export const traceApi = {
  stats: () => api<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean }>('/api/trace/stats'),
  byTraceId: (traceId: string) => api<{ steps: TraceStep[] }>(`/api/trace?trace_id=${encodeURIComponent(traceId)}`),
};
