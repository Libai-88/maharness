import { createHash, randomUUID } from 'node:crypto';
import { ApprovalBoard } from '../core/chat/approvals';
import { sanitizeToolHistory } from '../core/chat/policy';
import { ToolExecutor } from '../core/chat/tool-executor';
import { estimateTokens } from '../kernel/tokens';
import type { AgentEvent, AgentLoop, RunOptions } from '../kernel/loop';
import type { KernelLike, LLMMessage, ToolCall, ToolContext, ToolResult } from '../kernel/types';

export class ReferenceLoop implements AgentLoop {
  constructor(private readonly kernel: KernelLike, private readonly approvals = new ApprovalBoard()) {}
  approveApproval(id: string, approved: boolean): boolean { return this.approvals.approve(id, approved); }

  async *run(opts: RunOptions): AsyncGenerator<AgentEvent> {
    const tools = opts.tools ?? this.kernel.plugins.capabilities('tool').map(capability => capability.tool);
    const history: LLMMessage[] = sanitizeToolHistory([
      { role: 'system', content: opts.systemPrompt ?? '你是具备工具能力的 maharness Agent。基于工具返回回答事实问题，不编造结果。', context: { id: 'runtime', source: 'runtime', scope: 'runtime', trust: 'core', retention: 'required' } },
      ...(opts.contextMessages ?? []), ...opts.messages,
    ]);
    const evidence = [...(opts.restoredToolResults ?? [])];
    let cost = 0; let tokensIn = 0; let tokensOut = 0; let reasoning = '';
    const modelPrice = opts.provider.models?.find(model => model.modelId === opts.model);
    const priceIn = modelPrice?.priceIn ?? opts.provider.prices?.in;
    const priceOut = modelPrice?.priceOut ?? opts.provider.prices?.out;
    try {
      for (let localTurn = 0; (opts.maxTurns ?? 30) > localTurn; localTurn++) {
        opts.signal?.throwIfAborted();
        const turn = (opts.turnOffset ?? 0) + localTurn;
        if (opts.task?.deadlineAt !== undefined && Date.now() >= opts.task.deadlineAt) { yield { type: 'error', kind: 'deadline', error: 'Task deadline reached' }; return; }
        if (opts.costBudget !== undefined && cost >= opts.costBudget) { yield { type: 'budget_hit', cost, budget: opts.costBudget }; return; }
        history.push(...(opts.takeMessages?.(history, localTurn) ?? []));
        opts.historyArchive?.save?.(history);
        opts.onModelInput?.({ turn, providerId: opts.provider.id, model: opts.model, messages: history, tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) });
        let answer = ''; let callReasoning = ''; let input = 0; let output = 0; let usage = false; let estimated = false; let finished = false;
        const calls: ToolCall[] = [];
        const release = await opts.acquireExecution?.(opts.signal);
        try {
          for await (const chunk of opts.provider.chat(history, { model: opts.model, tools, signal: opts.signal, responseFormat: opts.responseFormat })) {
            if (chunk.type === 'delta') { answer += chunk.text; yield chunk; }
            else if (chunk.type === 'reasoning') { callReasoning += chunk.text; yield chunk; }
            else if (chunk.type === 'tool_call') calls.push(chunk.toolCall);
            else if (chunk.type === 'usage') { input = Math.max(input, chunk.input); output = Math.max(output, chunk.output); usage = true; estimated ||= !!chunk.estimated; }
            else if (chunk.type === 'done') finished = true;
          }
        } finally {
          release?.();
          if (!usage) { input = estimateTokens(JSON.stringify(history)); output = estimateTokens(answer + callReasoning + JSON.stringify(calls)); estimated = true; }
          tokensIn += input; tokensOut += output;
          if (priceIn !== undefined && priceOut !== undefined) cost += (input * priceIn + output * priceOut) / 1_000_000;
          opts.onUsageStatus?.(priceIn === undefined || priceOut === undefined ? 'unknown' : estimated ? 'estimated' : 'reported');
          opts.onUsage?.({ input: tokensIn, output: tokensOut, cost });
        }
        opts.signal?.throwIfAborted();
        if (!finished) throw new Error('Provider stream ended without completion');
        reasoning += callReasoning;
        if (!calls.length) {
          yield { type: 'assistant_done', content: answer, reasoning, usage: { input: tokensIn, output: tokensOut }, cost };
          return;
        }
        if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Duplicate native tool call IDs');
        history.push({ role: 'assistant', content: answer || null, tool_calls: calls });
        for (const [index, call] of calls.entries()) {
          opts.signal?.throwIfAborted();
          const tool = tools.find(candidate => candidate.name === call.function.name);
          let args: unknown; let result: ToolResult | undefined;
          try { args = JSON.parse(call.function.arguments); }
          catch { result = { ok: false, error: 'Invalid tool argument JSON', failure: { code: 'TOOL_ARGS_SCHEMA', retryable: false, outcome: 'not_started' } }; }
          if (!tool) result = { ok: false, error: 'Unknown tool: ' + call.function.name, failure: { code: 'TOOL_NOT_FOUND', retryable: false, outcome: 'not_started' } };
          yield { type: 'tool_start', id: call.id, name: call.function.name, args };
          opts.toolJournal?.start(call.id, call.function.name, JSON.stringify(args) ?? call.function.arguments);
          if (tool && !result) {
            const context: ToolContext = {
              turn, sandboxRoot: opts.sandboxRoot ?? this.kernel.rootDir, cache: this.kernel.cache, trace: this.kernel.trace,
              runId: opts.runId, parentRunId: opts.parentRunId, traceId: opts.traceId, sessionId: opts.sessionId, tenantId: opts.tenantId,
              authorization: opts.authorization, principal: { role: opts.principalRole ?? 'admin' }, signal: opts.signal, runSignal: opts.signal,
              remainingBudget: opts.availableBudget?.() ?? opts.costBudget, model: opts.model, providerId: opts.provider.id,
              delegate: opts.delegate, results: opts.toolJournal,
            };
            const effectKey = tool.sideEffect === 'none' || tool.sideEffect === 'read' ? undefined
              : createHash('sha256').update(JSON.stringify([opts.executionId ?? opts.traceId, turn, index, tool.name, args])).digest('hex');
            const executor = new ToolExecutor({ tool, args, context, runId: opts.runId, parentRunId: opts.parentRunId,
              acquireExecution: opts.acquireExecution, effectJournal: opts.effectJournal, effectKey, effectStarted: false, timeoutMs: 30_000, policyApproved: false });
            let needsApproval = !!opts.authorization?.readOnly && tool.sideEffect !== 'none' && tool.sideEffect !== 'read';
            let approvalSummary = 'Operation requires user approval';
            try {
              const assessment = tool.assessApproval?.(args, context);
              needsApproval ||= assessment ? assessment.needsApproval : !!tool.approval || tool.risk === 'high';
              if (assessment?.reason) approvalSummary = assessment.reason;
            } catch { needsApproval = true; }
            opts.onCheckpoint?.(turn, history, { toolResults: evidence, costUsd: (opts.restoredCostUsd ?? 0) + cost },
              { phase: 'tool_pending', pendingTool: { name: tool.name, toolCallId: call.id, sideEffect: tool.sideEffect, argsPreview: JSON.stringify(args), effectKey, resultId: call.id } });
            result = needsApproval ? { ok: false, needsApproval: true, approvalSummary } : await executor.invoke(false);
            if (result.needsApproval) {
              const approvalId = randomUUID();
              let resolveDecision!: (approved: boolean) => void;
              const decision = new Promise<boolean>(resolve => { resolveDecision = resolve; });
              const abort = () => { this.approvals.withdraw(approvalId); resolveDecision(false); };
              this.approvals.register(approvalId, { name: tool.name, summary: result.approvalSummary ?? approvalSummary, args, sessionId: opts.sessionId }, resolveDecision);
              opts.signal?.addEventListener('abort', abort, { once: true });
              if (opts.signal?.aborted) abort();
              try {
                yield { type: 'approval_required', approvalId, name: tool.name, summary: result.approvalSummary ?? approvalSummary, args };
                const approved = await decision;
                opts.signal?.throwIfAborted();
                result = approved ? await executor.invoke(true, approvalId) : { ok: false, governed: true, error: 'User rejected operation', failure: { code: 'APPROVAL_REJECTED', retryable: false, outcome: 'not_started' } };
              } finally { opts.signal?.removeEventListener('abort', abort); this.approvals.withdraw(approvalId); }
            }
            if (effectKey && executor.effectStarted && !result.needsApproval && result.failure?.outcome !== 'unknown') opts.effectJournal?.complete(effectKey, result);
          }
          result ??= { ok: false, error: 'Tool execution did not return a result', failure: { code: 'TOOL_EXECUTION', retryable: false, outcome: 'unknown' } };
          opts.toolJournal?.finish(call.id, result);
          evidence.push({ name: call.function.name, ok: result.ok, evidence: result.evidence });
          history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          yield { type: 'tool_result', id: call.id, name: call.function.name, ok: result.ok, summary: result.error ?? JSON.stringify(result.data ?? {}), evidence: result.evidence };
          if (result.failure?.outcome === 'unknown') {
            yield { type: 'error', kind: 'policy', error: result.error ?? 'Tool operation outcome is unknown' };
            return;
          }
        }
        opts.historyArchive?.save?.(history);
        opts.onCheckpoint?.(turn, history, { toolResults: evidence, costUsd: (opts.restoredCostUsd ?? 0) + cost }, { phase: 'turn_end' });
      }
      yield { type: 'error', kind: 'max-turns', error: 'Model call limit reached' };
    } catch (error) {
      yield { type: 'error', kind: opts.signal?.aborted ? 'aborted' : 'upstream', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
