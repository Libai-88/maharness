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
import { estimateTokens } from '../../kernel/tokens';

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
  const total = history.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0);
  if (total <= maxTokens || history.length <= 1) {
    return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };
  }

  // M1 二次摘要锚定：定位既有摘要消息的位置（不局限于 history[0]）。已有摘要时
  // 允许对摘要之后新增的段再次 LLM 摘要——旧摘要与新段一起送入合并成一条新摘要
  // （旧摘要中的事实不丢），不再"永久关闭压缩路径"（旧实现：新摘要直接顶掉旧摘要、
  // 丢掉旧事实；且摘要一旦存在就只能截断，长会话越截越碎）。
  const summaryIdx = history.findIndex((m) => m.role === 'system' && String(m.content ?? '').startsWith(SUMMARY_MARK));
  const compressibleFrom = summaryIdx >= 0 ? summaryIdx + 1 : 0;

  // 切点：从前往后找「压缩段结束」位置——使保留段（切点之后）估算 ≤ 预算 × KEEP_RATIO
  const keepBudget = Math.max(maxTokens * KEEP_RATIO, 512);
  let cut = history.length;
  let acc = 0;
  for (let i = history.length - 1; i >= compressibleFrom; i--) {
    acc += estimateTokens(history[i].content ?? '');
    if (acc > keepBudget) { cut = i + 1; break; }
  }
  const compressible = history.slice(compressibleFrom, cut);
  const kept = history.slice(cut);
  if (compressible.length === 0) {
    // 无可压缩段（全是最近轮）→ 截断兜底（切掉最早的一部分，保留最新）
    return truncate(history, maxTokens, total);
  }

  // ---- compact：LLM 总结压缩段（二次摘要：旧摘要 + 新段 → 合并成一条新摘要） ----
  if (opts.provider && compressible.length >= 2) {
    const summaryInput = summaryIdx >= 0 ? [history[summaryIdx], ...compressible] : compressible;
    const summary = await summarizeSegment(summaryInput, opts);
    if (summary) {
      // 摘要之前若还有消息（非常规：如未剥离的头部 system），原样保留
      const prefix = summaryIdx > 0 ? history.slice(0, summaryIdx) : [];
      const messages: LLMMessage[] = [
        ...prefix,
        { role: 'system', content: summary },
        ...kept,
      ];
      const compactedTokens = compressible.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0);
      const summaryTokens = estimateTokens(summary);
      opts.trace?.startStep({ traceId: opts.traceId ?? '', turn: opts.turn ?? 0, type: 'system', name: '上下文压缩' })
        .finish({
          outputSummary: `LLM 摘要压缩 ${compressible.length} 条早期消息（${compactedTokens} → ${summaryTokens} tokens，省 ${compactedTokens - summaryTokens}）`,
          tokensIn: compactedTokens, tokensOut: summaryTokens,
        });
      return {
        messages, mode: 'compact',
        droppedMessages: 0, compactedMessages: compressible.length,
        estimatedTokens: summaryTokens + kept.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0),
      };
    }
    // 摘要失败（调用异常/输出不符）→ 降级截断
  }

  return truncate(history, maxTokens, total);
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
function truncate(history: LLMMessage[], maxTokens: number, total: number): CompactResult {
  if (history.length <= 1) {
    return { messages: history, mode: 'none', droppedMessages: 0, compactedMessages: 0, estimatedTokens: total };
  }
  const head = history[0].role === 'system' ? [history[0]] : [];
  const rest = history.slice(head.length);
  const headTokens = head.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0);
  let budget = Math.max(maxTokens - headTokens, 256);

  const kept: LLMMessage[] = [];
  let acc = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateTokens(rest[i].content ?? '');
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
  const r = truncate(history, maxTokens, history.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0));
  return { messages: r.messages, truncated: r.mode === 'truncate', droppedMessages: r.droppedMessages, estimatedTokens: r.estimatedTokens };
}
