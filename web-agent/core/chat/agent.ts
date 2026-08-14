/**
 * core/chat/agent.ts —— Agent 执行器（自研）
 * 循环模型：决策(LLM 流式) → 动作(工具执行) → 观测(结果回填)，直到无工具调用。
 * 每一步发 Trace 事件（llm_call / tool_call），全程可观测；支持预算与中断。
 */
import { randomUUID } from 'node:crypto';
import { sharedPrefixTokens } from '../../kernel/tokens';
import type {
  EventBusLike, KernelLike, LLMMessage, ProviderDef, ToolCall, ToolDef, ToolResult, TraceStep,
} from '../../kernel/types';

/**
 * 钩子管线运行上下文（agent.* 事件负载）
 * 监听器通过改写字段影响流程：history（注入上下文/记忆）、tools、scratchpad（跨轮共享）、
 * blocked（拦截）、tool.args（改写参数）、result（改写结果）。约定俗成，不触碰内核。
 */
export interface AgentHookCtx {
  traceId: string;
  turn: number;
  model: string;
  history: LLMMessage[];
  systemPrompt: string;                 // 信息展示；改 history[0].content 才真正生效
  tools: ToolDef[];
  scratchpad: Record<string, unknown>;
  blocked?: boolean;                    // 置 true 拦截（agent.input.received / agent.before_tool）
  blockReason?: string;
  tool?: { name: string; args: unknown };
  content?: string;                     // after_llm：模型输出（观测）
  reasoning?: string;
  toolCalls?: ToolCall[];
  result?: ToolResult;                  // after_tool：结果（可改写）
  error?: string;                       // on_error
}

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
  tools?: ToolDef[];         // 覆盖可用工具（如 plan 模式出计划阶段传 []，强制只输出计划）
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

/** 工具执行默认超时（毫秒；config agent.toolTimeoutMs 可调） */
const TOOL_TIMEOUT_DEFAULT = 30_000;

/** 包裹工具执行：超时保护，防止工具挂起卡死整轮对话（超时后 handler 仍可能在后台运行，由工具自行响应 signal 取消） */
async function withToolTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具执行超时（${ms / 1000}s）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class AgentRunner {
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private kernel: KernelLike, private bus: EventBusLike) {}

  /** 发布钩子事件（await 所有监听器；总线已隔离监听器错误） */
  private emitHook(type: string, data: AgentHookCtx): Promise<void> {
    return this.bus.emitAsync({ type, data, traceId: data.traceId, ts: Date.now() });
  }

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
    const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const history: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    const tools = this.kernel.plugins.capabilities('tool');
    const toolDefs = opts.tools ?? tools.map((c) => c.tool);
    const sandboxRoot = this.kernel.config.get<string>('sandboxRoot', this.kernel.rootDir);
    const toolTimeout = this.kernel.config.get<number>('agent.toolTimeoutMs', TOOL_TIMEOUT_DEFAULT);
    const scratchpad: Record<string, unknown> = {};

    // ---- 钩子：输入到达（安全/预处理插件可拦截或改写上下文） ----
    const inputCtx: AgentHookCtx = { traceId, turn: 0, model, history, systemPrompt, tools: toolDefs, scratchpad };
    await this.emitHook('agent.input.received', inputCtx);
    if (inputCtx.blocked) {
      yield { type: 'error', error: inputCtx.blockReason ?? '已被策略拦截' };
      return;
    }

    let totalIn = 0, totalOut = 0, totalCost = 0;
    // L3 前缀缓存统计：记录上一轮实际发给 LLM 的 history 快照（钩子可能改写）
    let lastHistory: { role?: string; content?: string | null }[] | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        yield { type: 'error', error: '已中断' };
        return;
      }

      // ---- 钩子：调用 LLM 前（记忆注入 / 上下文拼装 / 工具调整） ----
      const llmCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad };
      await this.emitHook('agent.before_llm', llmCtx);

      // ---- 决策：LLM 调用（流式） ----
      const step = this.kernel.trace.startStep({
        traceId, turn, type: 'llm_call', name: `${provider.id}/${model}`,
      });
      let text = '';
      let reasoning = '';
      let usage: { input: number; output: number } | undefined;
      let collected: ToolCall[] = [];
      try {
        // L3 前缀复用统计：与上一轮调用共享的公共前缀 token（provider KV cache 直接命中）
        if (lastHistory) {
          const shared = sharedPrefixTokens(lastHistory, llmCtx.history);
          if (shared > 0) this.kernel.cache.recordPrefixRepeat(shared);
        }
        lastHistory = llmCtx.history.map((m) => ({ role: m.role, content: m.content }));
        for await (const chunk of provider.chat(llmCtx.history, { model, tools: llmCtx.tools, signal })) {
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
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.emitHook('agent.on_error', { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, error: errMsg });
        step.fail(errMsg);
        yield { type: 'error', error: errMsg };
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

      // ---- 钩子：LLM 输出后（校验/观测；流出的输出暂不可改写） ----
      await this.emitHook('agent.after_llm', {
        traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad,
        content: text, reasoning, toolCalls: collected,
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
        // ---- 钩子：工具执行前（权限策略 / 参数改写 / 拦截） ----
        const toolCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, tool: { name: tool.name, args } };
        await this.emitHook('agent.before_tool', toolCtx);
        if (toolCtx.blocked) {
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: toolCtx.blockReason ?? '已被策略拦截' }) });
          yield { type: 'tool_result', name: tool.name, summary: toolCtx.blockReason ?? '已被策略拦截', ok: false };
          continue;
        }
        const toolArgs = toolCtx.tool?.args ?? args;
        const tStep = this.kernel.trace.startStep({
          traceId, turn, type: 'tool_call', name: tool.name, inputSummary: summarize(toolArgs),
        });
        let result;
        try {
          result = await withToolTimeout(tool.handler(toolArgs, {
            traceId, turn,
            sandboxRoot,
            signal,
            cache: this.kernel.cache,
            trace: this.kernel.trace,
          }), toolTimeout);
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
              result = await withToolTimeout(tool.handler(args, {
                traceId, turn, sandboxRoot, signal,
                cache: this.kernel.cache, trace: this.kernel.trace,
                approved: true, approvalId,
              }), toolTimeout);
            } catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          }
        }
        // ---- 钩子：工具执行后（结果过滤/改写） ----
        const afterTCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, tool: { name: tool.name, args: toolArgs }, result };
        await this.emitHook('agent.after_tool', afterTCtx);
        const finalResult = afterTCtx.result ?? result;
        if (finalResult.ok) {
          tStep.finish({ outputSummary: summarize(finalResult.data) });
        } else {
          tStep.fail(finalResult.error ?? '工具执行失败', { outputSummary: summarize(finalResult) });
        }
        const content = JSON.stringify(finalResult).slice(0, 4000);
        history.push({ role: 'tool', tool_call_id: tc.id, content });
        yield { type: 'tool_result', name: tool.name, summary: summarize(finalResult), ok: !!finalResult.ok };
      }
    }

    await this.emitHook('agent.on_error', { traceId, turn: maxTurns, model, history, systemPrompt, tools: toolDefs, scratchpad, error: `超过最大轮数 ${maxTurns}，已停止` });
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
