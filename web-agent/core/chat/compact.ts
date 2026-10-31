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
import type { LLMMessage, ProviderDef, TraceLike } from '../../kernel/types';
import { allocateTokenBudget, countMessageTokens, estimateTokens } from '../../kernel/tokens';

/** 压缩摘要的前缀标记：检测到它即认为历史已压缩（跳过，不重复总结） */
export const SUMMARY_MARK = '【历史摘要】';
/** 压缩 LLM 调用的超时（毫秒）：压缩是降级路径，不能阻塞主流程过久 */
const COMPACT_TIMEOUT_MS = 30_000;
/** 压缩段的总预算：目标保留量 = 预算 × 该比例（余量给新摘要与最新消息） */
const KEEP_RATIO = 0.8;

export interface CompactOptions {
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
  droppedMessages: number;    // 截断丢弃的消息数
  compactedMessages: number;  // 被压缩进摘要的消息数
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
  return ![...beforeAssistantCalls].some((id) => afterToolResults.has(id))
    && ![...afterAssistantCalls].some((id) => beforeToolResults.has(id));
}

const PROTECTED_CONTEXT_PREFIXES = [
  '【任务约束】', '【验收条件】', '【核心记忆块】', '【长期记忆】', '【失败教训】',
];

/** 任务、验收和记忆约束属于上下文契约，压缩后必须逐字保留。 */
export function contextIntegrityPreservesConstraints(before: LLMMessage[], after: LLMMessage[]): boolean {
  const protectedMessages = before.filter((message) => {
    const content = String(message.content ?? '');
    return PROTECTED_CONTEXT_PREFIXES.some((prefix) => content.startsWith(prefix));
  });
  return protectedMessages.every((message) => after.some((candidate) =>
    candidate.role === message.role && candidate.content === message.content));
}

function isProtectedContextMessage(message: LLMMessage): boolean {
  const content = String(message.content ?? '');
  return PROTECTED_CONTEXT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** 摘要提示词：只保留任务相关事实，丢弃寒暄与过程（输出必须以标记开头，否则视为失败降级） */
const SUMMARIZE_PROMPT = [
  `你是会话历史摘要器。把以下早期对话压缩为一段「${SUMMARY_MARK}」：`,
  '- 保留：用户的需求与目标、已确定的结论与决策、关键约束（路径/名称/偏好）、任务上下文；',
  '- 丢弃：寒暄、过程性细节、工具输出复述、与任务无关的内容；',
  '- 输出：以「【历史摘要】」开头的一段中文（≤300 字），不要输出其他任何内容。',
].join('\n');

/**
 * 压缩/截断历史（system 消息不参与压缩——它由 AgentRunner 组装，此处只处理对话轮）。
 * 返回处理后的消息序列；mode 标识走了哪条路径（可观测：Trace 记录）。
 */
export async function compactHistory(history: LLMMessage[], maxTokens: number, opts: CompactOptions = {}): Promise<CompactResult> {
  const budget = allocateTokenBudget(maxTokens);
  const contextBudget = Math.max(0, maxTokens - budget.output);
  const count = (messages: LLMMessage[]) => countMessageTokens(messages, opts.provider?.tokenizer);
  const total = count(history);
  if (total <= contextBudget || history.length <= 1) {
    return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };
  }

  // M1 二次摘要锚定：定位既有摘要消息的位置（不局限于 history[0]）。已有摘要时
  // 允许对摘要之后新增的段再次 LLM 摘要——旧摘要与新段一起送入合并成一条新摘要
  // （旧摘要中的事实不丢），不再"永久关闭压缩路径"（旧实现：新摘要直接顶掉旧摘要、
  // 丢掉旧事实；且摘要一旦存在就只能截断，长会话越截越碎）。
  const summaryIdx = history.findIndex((m) => m.role === 'system' && String(m.content ?? '').startsWith(SUMMARY_MARK));
  // 头部 system 消息（L0 系统提示词）不参与压缩，且必须原样保留：
  // 循环内压缩（agent.ts 每轮 compactFn）传入的 history 首元素就是 AgentRunner 组装的
  // system prompt —— 旧实现 compressibleFrom=0 会把它送进摘要器、并因 prefix 为空而
  // 直接丢弃，导致本轮剩余轮次的请求不再带任何系统级纪律（且 L3 前缀从此断裂）。
  const headIsSystem = history[0]?.role === 'system'
    && !String(history[0].content ?? '').startsWith(SUMMARY_MARK);
  let compressibleFrom = summaryIdx >= 0 ? summaryIdx + 1 : (headIsSystem ? 1 : 0);
  while (compressibleFrom < history.length && isProtectedContextMessage(history[compressibleFrom]!)) compressibleFrom++;

  // 切点：从前往后找「压缩段结束」位置——使保留段（切点之后）估算 ≤ 预算 × KEEP_RATIO
  const keepBudget = Math.max(contextBudget * KEEP_RATIO, 512);
  let cut = history.length;
  let acc = 0;
  for (let i = history.length - 1; i >= compressibleFrom; i--) {
    acc += count([history[i]!]);
    if (acc > keepBudget) { cut = i + 1; break; }
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
      // 摘要锚点/头部 system 之前的内容原样保留（不能丢 L0 系统提示词）。
      // 注意：prefixEnd 不能写成「summaryIdx > 0 ? summaryIdx : 0」——无锚点时那样会让
      // 头部 system 落在 prefix 之外被压掉，必须取 compressibleFrom 作为下界。
      const prefixEnd = summaryIdx >= 0 ? summaryIdx : compressibleFrom;
      const prefix = history.slice(0, prefixEnd);
      const messages: LLMMessage[] = [
        ...prefix,
        { role: 'system', content: summary },
        ...kept,
      ];
      if (!contextIntegrityPreservesConstraints(history, messages)) {
        return truncate(history, contextBudget, total, opts.provider?.tokenizer);
      }
      const compactedTokens = count(compressible);
      const summaryTokens = estimateTokens(summary);
      opts.trace?.startStep({ traceId: opts.traceId ?? '', turn: opts.turn ?? 0, type: 'system', name: '上下文压缩' })
        .finish({
          inputSummary: `history[${compressibleFrom}..${cut - 1}] · ${compressible.length} 条早期消息`,
          outputSummary: `来源 history[${compressibleFrom}..${cut - 1}]；LLM 摘要压缩 ${compressible.length} 条早期消息（${compactedTokens} → ${summaryTokens} tokens，省 ${compactedTokens - summaryTokens}）`,
          tokensIn: compactedTokens, tokensOut: summaryTokens,
        });
      return {
        messages, mode: 'compact',
        droppedMessages: 0, compactedMessages: compressible.length,
        estimatedTokens: summaryTokens + count(kept),
      };
    }
    // 摘要失败（调用异常/输出不符）→ 降级截断
  }

  return truncate(history, contextBudget, total, opts.provider?.tokenizer);
}

/** 调 LLM 压缩一段历史为摘要；失败或输出不符标记时返回 null（调用方降级） */
async function summarizeSegment(segment: LLMMessage[], opts: CompactOptions): Promise<string | null> {
  const { provider, model, signal } = opts;
  if (!provider || !model) return null;
  try {
    let text = '';
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('压缩超时')), COMPACT_TIMEOUT_MS).unref?.();
    });
    const call = (async () => {
      for await (const chunk of provider.chat(
        [
          { role: 'system', content: SUMMARIZE_PROMPT },
          { role: 'user', content: segment.map((m) => `${m.role === 'user' ? '用户' : m.role === 'system' ? '既有摘要' : '助手'}: ${m.content ?? ''}`).join('\n---\n') },
        ],
        { model, signal, maxTokens: 400 },
      )) {
        if (chunk.type === 'delta') text += chunk.text;
      }
    })();
    await Promise.race([call, timer]);
    const trimmed = text.trim();
    if (!trimmed.startsWith(SUMMARY_MARK)) return null; // 模型不配合：降级
    return trimmed;
  } catch {
    return null;
  }
}

/** 截断兜底：保留 system 与最新消息，丢弃较早并注入说明（LLM 对截断有感知） */
function truncate(history: LLMMessage[], maxTokens: number, total: number, tokenizer?: ProviderDef['tokenizer']): CompactResult {
  if (history.length <= 1) {
    return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };
  }
  let protectedHeadCount = history[0].role === 'system' ? 1 : 0;
  while (protectedHeadCount < history.length && isProtectedContextMessage(history[protectedHeadCount]!)) protectedHeadCount++;
  const head = history.slice(0, protectedHeadCount);
  const rest = history.slice(head.length);
  const headTokens = countMessageTokens(head, tokenizer);
  let budget = Math.max(maxTokens - headTokens, 256);

  const kept: LLMMessage[] = [];
  let acc = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = countMessageTokens([rest[i]!], tokenizer);
    if (kept.length > 0 && acc + t > budget) break;
    kept.unshift(rest[i]);
    acc += t;
  }
  const dropped = rest.length - kept.length;
  if (dropped === 0) return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };

  const messages: LLMMessage[] = [
    ...head,
    { role: 'system', content: `【上下文管理】较早的 ${dropped} 条历史消息因超出上下文预算（${maxTokens} tokens）已被截断；如需更早内容请明确告知。` },
    ...kept,
  ];
  return { messages, mode: 'truncate', droppedMessages: dropped, compactedMessages: 0, estimatedTokens: headTokens + acc };
}

/** 保留原截断函数导出（兼容 server/context.ts 的既有使用方） */
export function truncateHistory(history: LLMMessage[], maxTokens: number): { messages: LLMMessage[]; truncated: boolean; droppedMessages: number; estimatedTokens: number } {
  const contextBudget = Math.max(0, maxTokens - allocateTokenBudget(maxTokens).output);
  const r = truncate(history, contextBudget, countMessageTokens(history));
  return { messages: r.messages, truncated: r.mode === 'truncate', droppedMessages: r.droppedMessages, estimatedTokens: r.estimatedTokens };
}
