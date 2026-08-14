/**
 * core/chat/agent.ts —— Agent 执行器（自研）
 * 循环模型：决策(LLM 流式) → 动作(工具执行) → 观测(结果回填)，直到无工具调用。
 * 每一步发 Trace 事件（llm_call / tool_call），全程可观测；支持预算与中断。
 */
import { randomUUID } from 'node:crypto';
import type {
  KernelLike, LLMMessage, ProviderDef, ToolCall, TraceStep,
} from '../../kernel/types';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; summary: string; ok: boolean }
  | { type: 'approval_required'; approvalId: string; name: string; summary: string; args: unknown }
  | { type: 'assistant_done'; content: string; reasoning: string; usage: { input: number; output: number }; cost: number }
  | { type: 'error'; error: string };

export interface RunOptions {
  provider: ProviderDef;
  model: string;
  messages: LLMMessage[];    // 会话历史（含最新用户消息）
  systemPrompt?: string;
  traceId: string;
  signal?: AbortSignal;
  maxTurns?: number;
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是运行在 Windows 上的自研 Web Agent，具备工具调用能力（文件读写、联网搜索等）。',
  '行为准则：',
  '1. 回答简洁、准确，默认使用中文；',
  '2. 需要文件或外部信息时，先调用工具获取事实，再基于事实回答；',
  '3. 文件操作前简要说明意图；涉及写入时内容要完整准确；',
  '4. 工具失败时说明原因并给出可行的替代方案；',
  '5. 不要编造工具结果。',
].join('\n');

/** 审批等待超时（毫秒）：10 分钟未响应自动拒绝 */
const APPROVAL_TIMEOUT = 10 * 60 * 1000;

export class AgentRunner {
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private kernel: KernelLike) {}

  /** 外部（REST 接口）响应审批：批准或拒绝 */
  approveApproval(approvalId: string, approved: boolean): boolean {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) return false;
    this.pendingApprovals.delete(approvalId);
    resolve(approved);
    return true;
  }

  /** 运行一轮完整对话（直到模型不再调用工具） */
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent> {
    const { provider, model, messages, traceId, signal } = opts;
    const maxTurns = opts.maxTurns ?? 8;
    const history: LLMMessage[] = [
      { role: 'system', content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      ...messages,
    ];
    const tools = this.kernel.plugins.capabilities('tool');
    const toolDefs = tools.map((c) => c.tool);
    const sandboxRoot = this.kernel.config.get<string>('sandboxRoot', this.kernel.rootDir);

    let totalIn = 0, totalOut = 0, totalCost = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        yield { type: 'error', error: '已中断' };
        return;
      }

      // ---- 决策：LLM 调用（流式） ----
      const step = this.kernel.trace.startStep({
        traceId, turn, type: 'llm_call', name: `${provider.id}/${model}`,
      });
      let text = '';
      let reasoning = '';
      let usage: { input: number; output: number } | undefined;
      let collected: ToolCall[] = [];
      try {
        for await (const chunk of provider.chat(history, { model, tools: toolDefs, signal })) {
          if (chunk.type === 'delta') {
            text += chunk.text;
            yield { type: 'delta', text: chunk.text };
          } else if (chunk.type === 'reasoning') {
            reasoning += chunk.text;
            yield { type: 'reasoning', text: chunk.text };
          } else if (chunk.type === 'tool_call') {
            collected.push(chunk.toolCall);
          } else if (chunk.type === 'usage') {
            usage = { input: chunk.input, output: chunk.output };
          }
        }
      } catch (err) {
        step.fail(err instanceof Error ? err.message : String(err));
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
        return;
      }
      const tIn = usage?.input ?? 0;
      const tOut = usage?.output ?? 0;
      totalIn += tIn;
      totalOut += tOut;
      const cost = estimateCost(provider, tIn, tOut);
      totalCost += cost;
      step.finish({
        outputSummary: text.slice(0, 200),
        tokensIn: tIn, tokensOut: tOut, cost,
      });

      history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: collected.length ? collected : undefined,
      });

      // ---- 无工具调用：本轮结束 ----
      if (!collected.length) {
        yield {
          type: 'assistant_done',
          content: text,
          reasoning,
          usage: { input: totalIn, output: totalOut },
          cost: totalCost,
        };
        return;
      }

      // ---- 动作：逐个执行工具，结果回填 ----
      for (const tc of collected) {
        const tool = toolDefs.find((t) => t.name === tc.function.name);
        let args: unknown = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
        if (!tool) {
          history.push({ role: 'tool', tool_call_id: tc.id, content: `工具不存在: ${tc.function.name}` });
          yield { type: 'tool_result', name: tc.function.name, summary: '工具不存在', ok: false };
          continue;
        }
        yield { type: 'tool_start', name: tool.name, args };
        const tStep = this.kernel.trace.startStep({
          traceId, turn, type: 'tool_call', name: tool.name, inputSummary: summarize(args),
        });
        let result;
        try {
          result = await tool.handler(args, {
            traceId, turn,
            sandboxRoot,
            signal,
            cache: this.kernel.cache,
            trace: this.kernel.trace,
          });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        // ---- 审批挂起：工具请求用户审批时，执行器暂停等待（安全机制，不可绕过） ----
        if (!result.ok && result.needsApproval) {
          const approvalId = randomUUID().slice(0, 8);
          yield {
            type: 'approval_required',
            approvalId,
            name: tool.name,
            summary: result.approvalSummary ?? result.error ?? '',
            args,
          };
          const approved = await new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(approvalId, resolve);
            setTimeout(() => { if (this.pendingApprovals.delete(approvalId)) resolve(false); }, APPROVAL_TIMEOUT);
          });
          if (!approved) {
            tStep.cancel();
            result = { ok: false, error: '用户拒绝了该操作（审批未通过）' };
          } else {
            // 已批准：带 approved 标记重试执行
            try {
              result = await tool.handler(args, {
                traceId, turn, sandboxRoot, signal,
                cache: this.kernel.cache, trace: this.kernel.trace,
                approved: true, approvalId,
              });
            } catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          }
        }
        if (result.ok) {
          tStep.finish({ outputSummary: summarize(result.data) });
        } else {
          tStep.fail(result.error ?? '工具执行失败', { outputSummary: summarize(result) });
        }
        const content = JSON.stringify(result).slice(0, 4000);
        history.push({ role: 'tool', tool_call_id: tc.id, content });
        yield { type: 'tool_result', name: tool.name, summary: summarize(result), ok: !!result.ok };
      }
    }

    yield { type: 'error', error: `超过最大轮数 ${maxTurns}，已停止` };
  }
}

function estimateCost(provider: ProviderDef, input: number, output: number): number {
  const p = provider.prices;
  if (!p) return 0;
  return (input / 1_000_000) * p.in + (output / 1_000_000) * p.out;
}

/** 摘要化（Trace 用，防大对象撑爆记录） */
function summarize(v: unknown, max = 300): string {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Trace 查询辅助（供 server 使用） */
export function queryTraceSteps(steps: TraceStep[], traceId: string): TraceStep[] {
  return steps.filter((s) => s.traceId === traceId);
}
