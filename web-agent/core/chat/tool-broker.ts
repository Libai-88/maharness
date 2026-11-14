import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, AgentHookCtx, RunOptions } from '../../kernel/loop';
import type { ToolContext, ToolDef, ToolResult } from '../../kernel/types';
import { shouldJournalToolEffect } from '../../kernel/tool-contract';
import { ToolExecutor } from './tool-executor';
import type { ApprovalBoard } from './approvals';

interface BrokerOptions {
  tools: ToolDef[];
  caller: ToolDef;
  context: ToolContext;
  options: RunOptions;
  key: string;
  board: ApprovalBoard;
  timeoutMs: number;
  assess(tool: ToolDef, args: unknown, context: ToolContext): { needsApproval: boolean; reason: string };
  before(tool: ToolDef, args: unknown): Promise<AgentHookCtx>;
  after(tool: ToolDef, args: unknown, result: ToolResult): Promise<ToolResult>;
  redact(value: unknown): unknown;
  emit(event: AgentEvent): void;
}
const denied = (code: string, error: string): ToolResult => ({ ok: false, error, failure: { code, retryable: false, outcome: 'not_started' } });

/** Nested calls retain the caller's permission ceiling and the host's approval/journal path. */
export function createToolBroker(input: BrokerOptions, depth = 0): NonNullable<ToolContext['invoke']> {
  let sequence = 0;
  return async (name, args, signal) => {
    const tool = input.tools.find(candidate => candidate.name === name);
    if (!input.caller.invokesTools) return denied('TOOL_BROKER_NOT_DECLARED', '调用方必须声明 invokesTools');
    if (!tool || tool.permissions.some(permission => !input.caller.permissions.includes(permission))) return denied('TOOL_PERMISSION', '工具不在调用方的有效授权内');
    if (depth >= 4 || tool.name === input.caller.name) return denied('TOOL_COMPOSITION_DEPTH', '工具组合达到执行边界');
    const id = randomUUID();
    const key = `${input.key}:nested:${sequence++}:${name}:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`;
    const journal = input.options.toolJournal;
    journal?.start(id, name, JSON.stringify(input.redact(args)).slice(0, 500));
    input.emit({ type: 'tool_start', id, name, args: input.redact(args) });
    let result: ToolResult;
    try {
      const hook = await input.before(tool, args);
      const actual = hook.tool?.args ?? args;
      const context: ToolContext = { ...input.context, signal: signal && input.context.signal ? AbortSignal.any([signal, input.context.signal]) : signal ?? input.context.signal, approved: false, approvalId: undefined, policyApproved: false };
      context.invoke = createToolBroker({ ...input, caller: tool, context, key }, depth + 1);
      const gate = input.assess(tool, actual, context);
      if (context.authorization?.readOnly && !tool.delegates && !['none', 'read'].includes(tool.sideEffect)) { gate.needsApproval = true; gate.reason = '当前任务的写入需要用户批准'; hook.policyApproved = false; }
      if (hook.forceApproval) { gate.needsApproval = true; gate.reason = hook.forceApprovalReason ?? '策略要求审批'; hook.policyApproved = false; }
      const effectKey = shouldJournalToolEffect(tool) ? key : undefined;
      const executor = new ToolExecutor({ tool, args: actual, context, runId: input.options.runId, parentRunId: input.options.parentRunId,
        acquireExecution: input.options.acquireExecution, effectJournal: input.options.effectJournal, effectKey, effectStarted: false, timeoutMs: input.timeoutMs, policyApproved: hook.policyApproved === true });
      if (hook.blocked) result = denied('TOOL_PERMISSION', hook.blockReason ?? '调用已被策略阻止');
      else if (gate.needsApproval && !hook.policyApproved) result = { ok: false, needsApproval: true, approvalSummary: gate.reason };
      else result = await executor.invoke(false);
      if (result.needsApproval) {
        const approvalId = randomUUID();
        const summary = result.approvalSummary ?? `审批 ${name}`;
        const approved = await new Promise<boolean>(resolve => {
          const signal = context.signal;
          const settle = (value: boolean) => { signal?.removeEventListener('abort', abort); resolve(value); };
          const abort = () => { input.board.withdraw(approvalId); settle(false); };
          if (signal?.aborted) { settle(false); return; }
          signal?.addEventListener('abort', abort, { once: true });
          input.board.register(approvalId, { name, summary, args: input.redact(actual), sessionId: context.sessionId }, settle);
          input.emit({ type: 'approval_required', approvalId, name, summary, args: input.redact(actual) });
        });
        result = approved ? await executor.invoke(true, approvalId) : { ...denied('TOOL_APPROVAL_DENIED', '用户拒绝或取消了该操作'), governed: true };
      }
      const observed = await input.after(tool, actual, result);
      if (result.failure?.outcome !== 'unknown') result = observed;
      if (effectKey && executor.effectStarted && result.failure?.outcome !== 'unknown') input.options.effectJournal?.complete(effectKey, result);
    } catch (error) {
      result = { ok: false, error: String(error), failure: { code: 'TOOL_COMPOSITION_FAILED', retryable: false, outcome: 'unknown' } };
    }
    journal?.finish(id, result);
    input.emit({ type: 'tool_result', id, name, ok: result.ok, summary: JSON.stringify(input.redact(result)).slice(0, 1000), evidence: result.evidence });
    return result;
  };
}

/** Forward events while a composite Promise is waiting for a nested tool or approval. */
export async function* forwardToolEvents<T>(execute: (emit: (event: AgentEvent) => void) => Promise<T>): AsyncGenerator<AgentEvent, T> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const promise = Promise.resolve().then(() => execute(event => { queue.push(event); wake?.(); })).finally(() => { done = true; wake?.(); });
  promise.catch(() => undefined);
  while (!done || queue.length) {
    if (queue.length) yield queue.shift()!;
    else await new Promise<void>(resolve => { wake = resolve; });
  }
  return await promise;
}
