/**
 * server/context.ts —— 上下文管理
 * 会话历史超出预算时的优雅降级：保留 system 提示与最新消息，丢弃较早消息并注入说明。
 * 策略要点：只截断"尾巴之前"的历史，保证最新对话与工具回填完整；
 *           丢弃后注入说明消息，LLM 对截断有感知（不产生"缺失记忆"的错觉）。
 */
import type { LLMMessage } from '../kernel/types';

/** 粗略估算 token 数：中文字符 ≈ 1 token，其他字符 ≈ 4 字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export interface ContextTruncateResult {
  messages: LLMMessage[];
  truncated: boolean;
  droppedMessages: number;
  estimatedTokens: number;
}

/** 按预算截断历史（system 保底保留；至少保留最后一条消息） */
export function truncateHistory(history: LLMMessage[], maxTokens: number): ContextTruncateResult {
  const total = history.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0);
  if (total <= maxTokens || history.length <= 1) {
    return { messages: history, truncated: false, droppedMessages: 0, estimatedTokens: total };
  }

  const system = history[0];
  const rest = history.slice(1);
  const systemTokens = estimateTokens(system.content ?? '');
  // system 再大也至少留 256 token 给对话
  let budget = Math.max(maxTokens - systemTokens, 256);

  const kept: LLMMessage[] = [];
  let acc = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateTokens(rest[i].content ?? '');
    if (kept.length > 0 && acc + t > budget) break;
    kept.unshift(rest[i]);
    acc += t;
  }

  const dropped = rest.length - kept.length;
  if (dropped === 0) return { messages: history, truncated: false, droppedMessages: 0, estimatedTokens: total };

  const messages: LLMMessage[] = [
    system,
    {
      role: 'system',
      content: `【上下文管理】较早的 ${dropped} 条历史消息因超出上下文预算（${maxTokens} tokens）已被截断；如需更早内容请明确告知。`,
    },
    ...kept,
  ];
  return { messages, truncated: true, droppedMessages: dropped, estimatedTokens: systemTokens + acc };
}
