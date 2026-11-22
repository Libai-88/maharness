import { callModel } from '../../kernel/plugin-sdk';
/**
 * core/chat/compact.ts —— 上下文压缩（Context Compaction）
 *
 * 对标 Anthropic Claude 的 context compaction：超预算时优先「总结」而非「丢弃」——
 * 旧对话被压缩成【历史摘要】注入（LLM 不丢事实），而非简单截断（LLM 只剩"丢了 N 条"的告知）。
 * 这是上下文工程的最后一道防线：截断是物理删除，压缩是信息保鲜。
 *
 * 降级策略（预算不够时的优先级）：
 *   1. compact：LLM 总结最早的完整对话轮 → 摘要替换（一次 LLM 调用，入 Trace）；
 *   2. truncate：兜底截断（保留最新消息，丢弃较早并注入说明）。
 *
 * 防重复压缩（M1 二次摘要锚定）：以既有【历史摘要】的位置为锚——摘要之后的
 * 新增段允许再次 LLM 摘要（与旧摘要合并成一条，事实不丢），压缩路径不会因
 * "已压缩过"而永久关闭；只有无可压缩段时才退化为截断兜底——
 * 避免"每轮重复花钱总结"与"丢最近信息"两个陷阱。
 *
 * L3 前缀缓存影响：压缩 = 一次性重写历史前缀（失效一次），之后新消息继续追加、前缀重新稳定——
 * 与工作区切换同级的一次性代价，换来的是长会话不丢事实。
 */
import { randomUUID } from 'node:crypto';
import type { LLMMessage, ProviderDef, TraceLike } from '../../kernel/plugin-sdk';
import { allocateTokenBudget, countMessageTokens, estimateTokens } from '../../kernel/plugin-sdk';
import { sanitizeToolHistory } from './policy';
import { ContextCapacityError } from '../../kernel/plugin-sdk';
import { estimateCost } from './provider';

/** 压缩摘要的前缀标记：检测到它即认为历史已压缩（跳过，不重复总结） */
export const SUMMARY_MARK = '【历史摘要】';
/** 压缩 LLM 调用的超时（毫秒）：压缩是降级路径，不能阻塞主流程过久 */
const COMPACT_TIMEOUT_MS = 30_000;
/** 压缩段的总预算：目标保留量 = 预算 × 该比例（余量给新摘要与最新消息） */
const KEEP_RATIO = 0.8;

export interface CompactOptions {
  onUsage?: (usage: { input: number; output: number; cost: number }) => void;
  provider?: ProviderDef;
  model?: string;
  signal?: AbortSignal;
  traceId?: string;
  turn?: number;
  trace?: TraceLike;
}

export interface CompactResult {
  messages: LLMMessage[];
  /** none=无需处理 / compact=LLM 摘要压缩 / truncate=兜底截断 */
  mode: 'none' | 'compact' | 'truncate';
  droppedMessages: number; // 截断丢弃的消息数
  compactedMessages: number; // 被压缩进摘要的消息数
  estimatedTokens: number;
}

/** 切分上下文时不得把 assistant tool_call 与 tool 回执拆到两侧。 */
export function contextBoundaryPreservesTools(history: LLMMessage[], cut: number): boolean {
  const beforeAssistantCalls = new Set<string>();
  const afterAssistantCalls = new Set<string>();
  const beforeToolResults = new Set<string>();
  const afterToolResults = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const message = history[i]!;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const id = (call as { id?: unknown }).id;
      if (typeof id === 'string') (i < cut ? beforeAssistantCalls : afterAssistantCalls).add(id);
    }
    if (message.role === 'tool' && message.tool_call_id) {
      if (i < cut) beforeToolResults.add(message.tool_call_id);
      else afterToolResults.add(message.tool_call_id);
    }
  }
  return (
    ![...beforeAssistantCalls].some((id) => afterToolResults.has(id)) && ![...afterAssistantCalls].some((id) => beforeToolResults.has(id))
  );
}

export function contextIntegrityPreservesConstraints(before: LLMMessage[], after: LLMMessage[]): boolean {
  return before
    .filter(isProtectedContextMessage)
    .every((message) =>
      after.some(
        (candidate) =>
          candidate.role === message.role && candidate.content === message.content && candidate.context?.id === message.context?.id,
      ),
    );
}
function isProtectedContextMessage(message: LLMMessage): boolean {
  return message.context?.retention === 'required';
}

/** 摘要提示词：只保留任务相关事实，丢弃寒暄与过程（输出必须以标记开头，否则视为失败降级） */
const SUMMARIZE_PROMPT = [
  `你是会话历史摘要器。把以下早期对话压缩为一段「${SUMMARY_MARK}」：`,
  '- 保留：用户的需求与目标、已确定的结论与决策、关键约束（路径/名称/偏好）、任务上下文；',
  '- 丢弃：寒暄、过程性细节、工具输出复述、与任务无关的内容；',
  '- 输出：以「【历史摘要】」开头，保留引用和来源；语言跟随用户。摘要允许丢失细节，不得声称无损。',
].join('\n');

/** 压缩产物统一过一遍工具协议净化，避免旧孤儿回执进入 provider 请求。 */
function sanitizeCompactResult(result: CompactResult): CompactResult {
  const messages = sanitizeToolHistory(result.messages);
  if (messages === result.messages) return result;
  return {
    ...result,
    messages,
    droppedMessages: result.droppedMessages + (result.mode === 'none' ? result.messages.length - messages.length : 0),
    compactedMessages:
      result.mode === 'compact' ? result.compactedMessages + (result.messages.length - messages.length) : result.compactedMessages,
  };
}

/**
 * 压缩/截断历史（system 消息不参与压缩——它由 AgentRunner 组装，此处只处理对话轮）。
 * 返回处理后的消息序列；mode 标识走了哪条路径（可观测：Trace 记录）。
 */
export async function compactHistory(history: LLMMessage[], maxTokens: number, opts: CompactOptions = {}): Promise<CompactResult> {
  const budget = allocateTokenBudget(maxTokens);
  const contextBudget = Math.max(0, maxTokens - budget.output);
  const count = (messages: LLMMessage[]) => countMessageTokens(messages, opts.provider?.tokenizer);
  const total = count(history);
  const required = history.filter((message, index) => isProtectedContextMessage(message) || (index === 0 && message.role === 'system'));
  const requiredTokens = count(required);
  if (requiredTokens > contextBudget) throw new ContextCapacityError(requiredTokens, contextBudget);
  if (total <= contextBudget || history.length <= 1) {
    return sanitizeCompactResult({ messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total });
  }

  // M1 二次摘要锚定：定位既有摘要消息的位置（不局限于 history[0]）。已有摘要时
  // 允许对摘要之后新增的段再次 LLM 摘要——旧摘要与新段一起送入合并成一条新摘要
  // （旧摘要中的事实不丢），不再"永久关闭压缩路径"（旧实现：新摘要直接顶掉旧摘要、
  // 丢掉旧事实；且摘要一旦存在就只能截断，长会话越截越碎）。
  const summaryIdx = history.findIndex((m) => m.context?.source === 'history-summary');
  // 头部 system 消息（运行时提示词）不参与压缩，且必须原样保留：
  // 循环内压缩（agent.ts 每轮 compactFn）传入的 history 首元素就是 AgentRunner 组装的
  // system prompt —— 旧实现 compressibleFrom=0 会把它送进摘要器、并因 prefix 为空而
  // 直接丢弃，导致本轮剩余轮次的请求不再带运行时提示词（且 L3 前缀从此断裂）。
  const headIsSystem = history[0]?.role === 'system' && history[0].context?.source !== 'history-summary';
  let compressibleFrom = summaryIdx >= 0 ? summaryIdx + 1 : headIsSystem ? 1 : 0;
  while (compressibleFrom < history.length && isProtectedContextMessage(history[compressibleFrom]!)) compressibleFrom++;

  // 切点：从前往后找「压缩段结束」位置——使保留段（切点之后）估算 ≤ 预算 × KEEP_RATIO
  const keepBudget = Math.max(contextBudget * KEEP_RATIO, 512);
  let cut = history.length;
  let acc = 0;
  for (let i = history.length - 1; i >= compressibleFrom; i--) {
    acc += count([history[i]!]);
    if (acc > keepBudget) {
      cut = i + 1;
      break;
    }
  }
  while (cut > compressibleFrom && !contextBoundaryPreservesTools(history, cut)) cut--;
  while (cut > compressibleFrom && history.slice(compressibleFrom, cut).some(isProtectedContextMessage)) cut--;
  const compressible = history.slice(compressibleFrom, cut);
  const kept = history.slice(cut);
  if (compressible.length === 0) {
    // 无可压缩段（全是最近轮）→ 截断兜底（切掉最早的一部分，保留最新）
    return truncate(history, contextBudget, total, opts.provider?.tokenizer);
  }

  // ---- compact：LLM 总结压缩段（二次摘要：旧摘要 + 新段 → 合并成一条新摘要） ----
  if (opts.provider && compressible.length >= 2) {
    const summaryInput = summaryIdx >= 0 ? [history[summaryIdx], ...compressible] : compressible;
    const summary = await summarizeSegment(summaryInput, opts);
    if (summary) {
      // 摘要锚点/头部 system 之前的内容原样保留（不能丢运行时提示词）。
      // 注意：prefixEnd 不能写成「summaryIdx > 0 ? summaryIdx : 0」——无锚点时那样会让
      // 头部 system 落在 prefix 之外被压掉，必须取 compressibleFrom 作为下界。
      const prefixEnd = summaryIdx >= 0 ? summaryIdx : compressibleFrom;
      const prefix = history.slice(0, prefixEnd);
      const messages: LLMMessage[] = [
        ...prefix,
        {
          role: 'user',
          content: summary,
          context: {
            id: `summary:${randomUUID()}`,
            source: 'history-summary',
            scope: 'history',
            trust: 'reference',
            retention: 'summarize',
            sourceRange: { from: compressibleFrom, to: cut - 1 },
            sourceIds: summaryInput.flatMap((message) => message.context?.sourceIds ?? (message.context?.id ? [message.context.id] : [])),
          },
        },
        ...kept,
      ];
      if (!contextIntegrityPreservesConstraints(history, messages)) {
        return truncate(history, contextBudget, total, opts.provider?.tokenizer);
      }
      if (count(messages) > contextBudget) return truncate(history, contextBudget, total, opts.provider?.tokenizer);
      const compactedTokens = count(compressible);
      const summaryTokens = estimateTokens(summary);
      opts.trace?.startStep({ traceId: opts.traceId ?? '', turn: opts.turn ?? 0, type: 'system', name: '上下文压缩' }).finish({
        inputSummary: `history[${compressibleFrom}..${cut - 1}] · ${compressible.length} 条早期消息`,
        outputSummary: `来源 history[${compressibleFrom}..${cut - 1}]；LLM 摘要压缩 ${compressible.length} 条早期消息（${compactedTokens} → ${summaryTokens} tokens，省 ${compactedTokens - summaryTokens}）`,
        tokensIn: compactedTokens,
        tokensOut: summaryTokens,
      });
      return {
        messages: sanitizeToolHistory(messages),
        mode: 'compact',
        droppedMessages: 0,
        compactedMessages: compressible.length,
        estimatedTokens: count(messages),
      };
    }
    // 摘要失败（调用异常/输出不符）→ 降级截断
  }

  return sanitizeCompactResult(truncate(history, contextBudget, total, opts.provider?.tokenizer));
}

/** 调 LLM 压缩一段历史为摘要；失败或输出不符标记时返回 null（调用方降级） */
async function summarizeSegment(segment: LLMMessage[], opts: CompactOptions): Promise<string | null> {
  const { provider, model, signal } = opts;
  if (!provider || !model) return null;
  const abort = new AbortController();
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  const cancel = () => {
    abort.abort(signal?.reason);
    rejectStopped(new Error('Context compaction cancelled'));
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    abort.abort('context_timeout');
    rejectStopped(new Error('Context compaction timed out'));
  }, COMPACT_TIMEOUT_MS);
  timeout.unref?.();
  let usage: { input: number; output: number } | undefined;
  let settled = false;
  try {
    return await Promise.race([
      (async () => {
        let text = '';
        for await (const chunk of callModel(
          provider,
          [
            { role: 'system', content: SUMMARIZE_PROMPT },
            {
              role: 'user',
              content: segment
                .map((m) => `${m.role === 'user' ? '用户' : m.role === 'system' ? '既有摘要' : '助手'}: ${m.content ?? ''}`)
                .join('\n---\n'),
            },
          ],
          {
            model,
            signal: abort.signal,
            maxTokens: Math.min(4096, Math.max(256, Math.floor(countMessageTokens(segment, provider.tokenizer) / 4))),
          },
          'compaction',
        )) {
          if (settled) break;
          if (chunk.type === 'delta') text += chunk.text;
          if (chunk.type === 'usage') usage = { input: chunk.input, output: chunk.output };
        }
        const trimmed = text.trim();
        if (!trimmed.startsWith(SUMMARY_MARK)) return null; // 模型不配合：降级
        return trimmed;
      })(),
      stopped,
    ]);
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'MODEL_BUDGET_UNCERTAIN') throw error;
    return null;
  } finally {
    settled = true;
    if (usage) opts.onUsage?.({ ...usage, cost: estimateCost(provider, usage.input, usage.output, model) });
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

/** 截断兜底：保留 system 与最新消息，丢弃较早并注入说明（LLM 对截断有感知） */
function truncate(history: LLMMessage[], maxTokens: number, total: number, tokenizer?: ProviderDef['tokenizer']): CompactResult {
  if (history.length <= 1) {
    return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };
  }
  const required = new Set(
    history.flatMap((message, index) => (isProtectedContextMessage(message) || (index === 0 && message.role === 'system') ? [index] : [])),
  );
  const requiredTokens = countMessageTokens(
    history.filter((_, index) => required.has(index)),
    tokenizer,
  );
  if (requiredTokens > maxTokens) throw new ContextCapacityError(requiredTokens, maxTokens);
  const selected = new Set(required);
  let acc = requiredTokens;
  const noticeReserve = Math.min(120, Math.max(0, maxTokens - requiredTokens));
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    if (required.has(i)) {
      cut = i;
      continue;
    }
    const tokens = countMessageTokens([history[i]!], tokenizer);
    if (acc + tokens + noticeReserve > maxTokens) break;
    selected.add(i);
    acc += tokens;
    cut = i;
  }
  while (cut < history.length && !contextBoundaryPreservesTools(history, cut)) {
    if (!required.has(cut)) selected.delete(cut);
    cut++;
  }
  const kept = history.filter((_, index) => selected.has(index));
  const dropped = history.length - kept.length;
  if (dropped === 0)
    return sanitizeCompactResult({ messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total });

  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: `【上下文管理】${dropped} 条历史消息因容量限制省略；原始记录可按来源检索。`,
      context: { id: 'history-omitted', source: 'history', scope: 'history', trust: 'reference', retention: 'ephemeral' },
    },
    ...kept,
  ];
  if (history[0]?.role === 'system' && messages[1] === history[0]) [messages[0], messages[1]] = [messages[1]!, messages[0]!];
  if (countMessageTokens(messages, tokenizer) > maxTokens)
    messages.splice(
      messages.findIndex((message) => message.context?.id === 'history-omitted'),
      1,
    );
  return {
    messages,
    mode: 'truncate',
    droppedMessages: dropped,
    compactedMessages: 0,
    estimatedTokens: countMessageTokens(messages, tokenizer),
  };
}

/** 保留原截断函数导出（兼容 server/context.ts 的既有使用方） */
export function truncateHistory(
  history: LLMMessage[],
  maxTokens: number,
): { messages: LLMMessage[]; truncated: boolean; droppedMessages: number; estimatedTokens: number } {
  const contextBudget = Math.max(0, maxTokens - allocateTokenBudget(maxTokens).output);
  const r = truncate(history, contextBudget, countMessageTokens(history));
  const messages = sanitizeToolHistory(r.messages);
  return {
    messages,
    truncated: r.mode === 'truncate',
    droppedMessages: r.droppedMessages + (r.messages === messages ? 0 : r.messages.length - messages.length),
    estimatedTokens: r.estimatedTokens,
  };
}
