/**
 * server/routes/warmup.ts —— L3 前缀缓存预热/保活（server 运维策略）
 * 第一性原理：provider KV 缓存命中的充要条件是「请求前缀逐字节一致且缓存条目存活」。
 * harness 已保证前缀一致（发送序列快照同步）；但网关对含 tool_calls 请求的缓存建立
 * 存在延迟/条件限制，且前缀缓存有 TTL——跨 run 首轮因此可能全价 prefill。
 * 预热机制：run 结束后延迟发送与最后请求同前缀的极小请求（max_tokens=1，成本≈0），
 * 主动建立/刷新缓存条目；随后周期保活（默认 90s）维持缓存活性，直到会话长时间空闲。
 */
import type { Kernel } from '../../kernel';
import type { LLMMessage, ProviderDef } from '../../kernel/types';
import { annotateToolDef, textualizeHistory } from '../../core/chat/agent';

interface WarmupEntry {
  timer: NodeJS.Timeout | null;
  systemPrompt: string;
  seq: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[];
  provider: ProviderDef;
  model: string;
  rounds: number;
  lastRunAt: number;
}

const warmups = new Map<string, WarmupEntry>();
const CONTINUE_HINT = '【继续】请根据工具结果继续处理任务；如任务已完成，直接给出最终回答。';
const WARMUP_DELAY_MS = 12_000;       // 首次预热延迟（网关缓存写入窗口）
const WARMUP_INTERVAL_MS = 90_000;  // 保活间隔（缓存 TTL 刷新）
const WARMUP_MAX_ROUNDS = 20;       // 最长保活 30 分钟（会话无新活动则停止）

/** 会话 run 结束后调度预热（新 run 到达时重置保活轮次） */
export function scheduleWarmup(
  sessionId: string,
  systemPrompt: string,
  seq: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[],
  provider: ProviderDef,
  model: string,
  kernel: Kernel,
): void {
  const existing = warmups.get(sessionId);
  if (existing) {
    // 会话有新活动：重置保活轮次与计时
    existing.systemPrompt = systemPrompt;
    existing.seq = seq;
    existing.provider = provider;
    existing.model = model;
    existing.rounds = 0;
    existing.lastRunAt = Date.now();
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_DELAY_MS);
    return;
  }
  warmups.set(sessionId, {
    timer: setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_DELAY_MS),
    systemPrompt, seq, provider, model, rounds: 0, lastRunAt: Date.now(),
  });
}

/** 执行一次预热 + 调度下一次保活 */
async function warmupOnce(sessionId: string, kernel: Kernel): Promise<void> {
  const entry = warmups.get(sessionId);
  if (!entry) return;
  entry.timer = null;
  // 保活上限：会话长时间无新活动则停止（避免无限消耗）
  if (entry.rounds >= WARMUP_MAX_ROUNDS) {
    warmups.delete(sessionId);
    return;
  }
  entry.rounds++;
  // 预热序列 = 与真实发送完全同形态：原始 sync 消息 → 共享文本化（与 run 内/跨 run 一致）
  // → 恒以 user（CONTINUE_HINT）结尾。网关只对纯文本 + user 结尾的请求稳定缓存。
  const rawSeq: LLMMessage[] = [
    { role: 'system', content: entry.systemPrompt },
    ...entry.seq.map((m) => ({
      role: m.role as LLMMessage['role'],
      content: m.content,
      ...(m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls as never } : {}),
      ...(m.role === 'tool' && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
  ];
  const msgs = textualizeHistory(rawSeq);
  if (msgs[msgs.length - 1]?.role !== 'user') {
    msgs.push({ role: 'user', content: CONTINUE_HINT });
  }
  try {
    // 预热请求：与最后发送序列同前缀 + 相同 tools（网关缓存键含 tools 参数，
    // 不带 tools 的预热建立的缓存对真实请求无效）；max_tokens=1 成本≈0
    const tools = kernel.plugins.capabilities('tool').map((c) => c.tool).map(annotateToolDef);
    let hit = 0, miss = 0;
    for await (const chunk of entry.provider.chat(msgs, { model: entry.model, maxTokens: 64, tools })) {
      if (chunk.type === 'usage') { hit = chunk.cachedInput ?? 0; miss = chunk.missInput ?? 0; }
    }
    console.log(`[warmup] ${sessionId.slice(0, 8)} 完成（round ${entry.rounds}，${msgs.length} 条，hit=${hit} miss=${miss}）`);
  } catch (err) {
    console.warn(`[warmup] ${sessionId.slice(0, 8)} 预热失败:`, err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
  // 调度下一次保活（会话有新 run 时 scheduleWarmup 会重置）
  const cur = warmups.get(sessionId);
  if (cur) {
    cur.timer = setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_INTERVAL_MS);
  }
}
