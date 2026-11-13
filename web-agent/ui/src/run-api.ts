import { api, authHeaders, type ChatHandlers, type ErrorKind } from './api';

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'stopping' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export interface RunInfo {
  id: string; sessionId: string; parentId?: string; objective: string; status: RunStatus;
  providerId: string; model: string; cost: number; tokensIn: number; tokensOut: number;
  usageStatus?: 'reported' | 'estimated' | 'unknown';
  eventCursor?: number;
  budgetUsd?: number; deadlineAt?: number;
  answer?: string; error?: string; verification?: unknown; createdAt: number; updatedAt: number;
  authorization: { workspace: string; profile: 'standard' | 'developer'; readOnly: boolean; revision: number };
}
export interface RunArtifact { id: string; runId: string; callId: string; kind: string; label: string; ref: string; createdAt: number }
export interface ModelInput { diagnostics?: { messageTokens: number; toolTokens: number; sources: { source: string; tokens: number }[]; fingerprint: string; attemptId?: string; resumedFromTurn?: number }; id: string; turn: number; providerId: string; model: string; createdAt: number; usage?: { inputTokens: number; window: number; outputReserve: number }; messages: { role: string; content: string | null; context?: { source: string; trust: string; retention: string } }[]; tools: { name: string }[] }
export interface RunTool { id: string; name: string; status: string; argsSummary: string }
export interface WorkspacePermission { workspace: string; profile: 'standard' | 'developer'; revision: number }
export const activeRun = (run: RunInfo) => ['queued', 'running', 'waiting_approval', 'stopping'].includes(run.status);
export const runLabels: Record<RunStatus, string> = { queued: '排队中', running: '执行中', waiting_approval: '等待审批', stopping: '停止中', interrupted: '可恢复', completed: '已结束', failed: '失败', cancelled: '已取消' };
export const runsApi = {
  list: (sessionId?: string) => api<RunInfo[]>(`/api/v2/runs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  get: (id: string) => api<RunInfo>(`/api/v2/runs/${id}`),
  create: (session: string, message: string, model?: string, provider?: string, frameworkChangeId?: string) => api<{ runId: string; run: RunInfo }>(`/api/v2/sessions/${session}/runs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ message, model: model || undefined, provider: provider || undefined, frameworkChangeId }) }),
  supplement: (id: string, message: string) => api(`/api/v2/runs/${id}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ message }) }),
  cancel: (id: string) => api<RunInfo>(`/api/v2/runs/${id}/cancel`, { method: 'POST' }),
  resume: (id: string) => api<RunInfo>(`/api/v2/runs/${id}/resume`, { method: 'POST' }),
  children: (id: string) => api<RunInfo[]>(`/api/v2/runs/${id}/children`),
  artifacts: (id: string) => api<RunArtifact[]>(`/api/v2/runs/${id}/artifacts`),
  tools: (id: string) => api<RunTool[]>(`/api/v2/runs/${id}/tools`),
  inputs: (id: string, before?: string) => api<ModelInput[]>(`/api/v2/runs/${id}/inputs${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  result: (id: string, callId: string, offset = 0) => api<{ content: string; nextOffset?: number }>(`/api/v2/runs/${id}/results/${callId}?offset=${offset}&limit=8000`),
  permission: () => api<WorkspacePermission>('/api/v2/workspace/permissions'),
  setPermission: (profile: WorkspacePermission['profile'], revision: number) => api<WorkspacePermission>('/api/v2/workspace/permissions', { method: 'PUT', body: JSON.stringify({ profile, revision }) }),
};

function dispatch(event: string, d: Record<string, unknown>, h: ChatHandlers) {
  const checks = (d.checks ?? []) as { ok: boolean; reason?: string }[];
  switch (event) {
    case 'start': h.onStart(String(d.traceId ?? '')); break;
    case 'status': h.onStatus?.(String(d.text ?? '')); break;
    case 'delta': h.onDelta(String(d.text ?? '')); break;
    case 'reasoning': h.onReasoning(String(d.text ?? '')); break;
    case 'tool_start': h.onToolStart(d.id as string | undefined, String(d.name), d.args); break;
    case 'tool_result': h.onToolResult(d.id as string | undefined, String(d.name), String(d.summary ?? ''), Boolean(d.ok), Boolean(d.stored), d.evidence as never, d.warnings as never); break;
    case 'approval_required': if (d.active !== false) h.onApprovalRequired(String(d.approvalId), String(d.name), String(d.summary), d.approvalToken as string | undefined); break;
    case 'done': h.onDone(d as Parameters<ChatHandlers['onDone']>[0]); break;
    case 'retry': h.onRetry?.(d.reason as 'attempt' | 'failover', d.detail as string); break;
    case 'budget_hit': h.onBudgetHit?.(Number(d.cost), Number(d.budget)); break;
    case 'task_verified': h.onTaskVerified?.(String(d.objective), checks, d.evidence as never); break;
    case 'task_partial': h.onTaskPartial?.(String(d.objective), checks, d.evidence as never); break;
    case 'task_failed': h.onTaskFailed?.(String(d.objective), checks, d.evidence as never); break;
    case 'error': h.onError(String(d.error), d.kind as ErrorKind); break;
  }
}

/** Each connection resumes from its last delivered sequence, without creating an execution. */
export async function subscribeRun(id: string, h: ChatHandlers, signal?: AbortSignal, after = 0): Promise<void> {
  let cursor = after;
  let errors = 0;
  let doneSeen = false;
  while (!signal?.aborted) {
    try {
      const response = await fetch(`/api/v2/runs/${id}/events`, { headers: { ...authHeaders(), 'Last-Event-ID': String(cursor) }, signal });
      if (!response.ok || !response.body) throw new Error(`任务事件订阅失败（${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const lines = block.split('\n');
            const seq = Number(lines.find(line => line.startsWith('id:'))?.slice(3));
            if (!Number.isSafeInteger(seq) || seq <= cursor) continue;
            const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
            const json = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            const data = JSON.parse(json) as Record<string, unknown>;
            dispatch(event, data, h);
            cursor = seq; errors = 0;
            if (event === 'done') doneSeen = true;
            if (event === 'state' || event === 'usage' || event === 'usage_status') h.onRun?.(await runsApi.get(id));
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const run = await runsApi.get(id); h.onRun?.(run);
      if (!activeRun(run)) {
        if (!doneSeen && run.status === 'completed') h.onDone({ content: run.answer ?? '', usage: { input: run.tokensIn, output: run.tokensOut }, cost: run.cost });
        else if (run.status !== 'completed') h.onError(run.error ?? runLabels[run.status], run.status === 'cancelled' ? 'aborted' : run.status === 'interrupted' ? 'max-turns' : 'upstream');
        h.onEnd?.(); return;
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (++errors >= 8) { h.onError(`订阅已断开，任务仍保存在任务列表：${error instanceof Error ? error.message : String(error)}`, 'network'); return; }
    }
    h.onStatus?.('正在重新连接任务…');
    await new Promise<void>(resolve => {
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); };
      const timer = setTimeout(stop, Math.min(10000, 1000 * 2 ** Math.min(errors, 3)));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }
}

export async function streamChat(session: string, body: { message?: string; model?: string; provider?: string; resume?: boolean; frameworkChangeId?: string }, h: ChatHandlers, signal?: AbortSignal) {
  try {
    const record = body.resume
      ? await runsApi.resume((await runsApi.list(session)).find(run => !run.parentId && run.status === 'interrupted')?.id ?? '')
      : (await runsApi.create(session, body.message ?? '', body.model, body.provider, body.frameworkChangeId)).run;
    h.onRun?.(record);
    await subscribeRun(record.id, h, signal, record.eventCursor ?? 0);
  } catch (error) { if (!signal?.aborted) h.onError(error instanceof Error ? error.message : String(error)); }
}
