// ui/src/replay.ts —— 「演出重建」：把 DB 里的发送序列重放成界面上那场对话
//
// 背景（为什么必须有这一层）：
//   一次对话在后端是多轮：assistant(带 tool_calls) → tool(回填) → assistant(带 tool_calls)
//   → tool → … → assistant(最终正文)。这些轮**全部逐行入库**（DB 是发送序列的忠实镜像，
//   为的是 L3 前缀缓存跨 run 逐字节延续）。而实时视图里，用户看到的是**一条气泡**：
//   正文 + 若干工具卡 + 若干群成员发言。
//   旧前端只做 `role in (user, assistant)` 过滤，于是刷新后：
//     · 带 tool_calls 的"过程轮"content 为 null → 渲染成一条**只有头像的空气泡**；
//     · tool 行被丢弃 → 工具卡/群成员发言全部消失；
//     · 「XX 加入了群聊」是前端即时造的，也消失 → 顶栏从「群聊 · 3 个成员」退回「在线 · 私聊」。
//   同一段对话刷一次就换副面孔，这就是最大的违和感。
//
// 这里用一个纯函数把行序列折叠回"一场演出"，并让实时路径（App 的 SSE handler）
// 产出**完全相同的形状**——两路同源，刷新前后一致。零 DB 变更：数据本来就在行里。
import type { ChatMessage, Message } from './types';
import { isSubagentTool, subagentLabel } from './types';

/** tool_calls 的 arguments 是 JSON 字符串（模型生成，可能残缺）：解不出就原样带着走 */
export function parseToolArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

/** 过程轮 vs 最终轮：带 tool_calls 的就是"还在办事的那几轮"，它的文本是说给自己听的旁白 */
function isWorkingTurn(m: Message): boolean {
  return !!m.toolCalls && m.toolCalls.length > 0;
}

/** tool 行回填 → 卡片状态：{"ok":false,...} 判失败，其余按完成 */
function outcomeOf(content: string | null): { ok: boolean; summary: string } {
  const raw = (content ?? '').trim();
  if (!raw) return { ok: true, summary: '' };
  if (raw.startsWith('{')) {
    const m = raw.match(/"ok"\s*:\s*(true|false)/);
    if (m) return { ok: m[1] === 'true', summary: raw };
  }
  if (/^(工具不存在|用户拒绝了)/.test(raw) || /已取消|操作失败|请求失败/.test(raw)) return { ok: false, summary: raw };
  return { ok: true, summary: raw };
}

/**
 * 主入口：DB 行 → 界面消息序列。
 * 规则：一条 user 之后的所有"办事轮 + 工具回填"折叠成一条 assistant 气泡，
 * 正文取最后一个不带 tool_calls 的 assistant 行；没有任何正文也没有工具卡的行直接丢弃
 * （空气泡的源头就是这么被掐掉的）。
 */
export function replayMessages(rows: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 当前正在折叠的"办事中"气泡。用 holder 承载（而不是裸 let）：
  // 赋值发生在闭包里，TS 的控制流分析看不到，裸 let 会被误判成恒 null。
  const run: { cur: ChatMessage | null } = { cur: null };

  const openBubble = (ts: number): ChatMessage => {
    const b: ChatMessage = { id: `rb-${ts}-${out.length}`, role: 'assistant', content: '', streaming: false, tools: [], narration: [], ts };
    run.cur = b;
    return b;
  };
  const flush = () => {
    const b = run.cur;
    run.cur = null;
    if (!b) return;
    const hasBody = b.content.trim().length > 0;
    const hasCards = (b.tools?.length ?? 0) > 0;
    const hasNarration = (b.narration?.length ?? 0) > 0;
    const hasThink = !!b.reasoning?.trim();
    // 什么都没有的空壳 → 丢掉（这就是那条"空气泡"）
    if (!hasBody && !hasCards && !hasNarration && !hasThink) return;
    out.push(b);
  };

  for (const m of rows) {
    if (m.role === 'system') continue;                 // 内部注入（记忆/摘要/预警）不进对话
    if (m.role === 'tool') {
      // 回填配对：按 tool_call_id 找那张卡（找不到 = 别的 run 的孤儿回填，忽略即可）
      const target = run.cur?.tools?.find((t) => t.id && t.id === m.toolCallId);
      if (target) {
        const { ok, summary } = outcomeOf(m.content);
        target.summary = summary;
        target.ok = ok;
        target.status = ok ? 'done' : 'error';
      }
      continue;
    }
    if (m.role === 'user') {
      flush();
      out.push({ id: m.id, role: 'user', content: m.content ?? '', ts: m.createdAt });
      continue;
    }
    // assistant
    if (isWorkingTurn(m)) {
      const b = run.cur ?? openBubble(m.createdAt);
      const text = (m.content ?? '').trim();
      if (text) b.narration = [...(b.narration ?? []), text];
      for (const tc of m.toolCalls ?? []) {
        b.tools = [...(b.tools ?? []), {
          id: tc.id,
          name: tc.function?.name ?? '',
          args: parseToolArgs(tc.function?.arguments),
          // 未回填（工具没跑完就被打断 / 进程被杀）：画成"没成"，比悄悄消失诚实
          status: 'error' as const,
          ok: false,
          summary: '',
          startedAt: m.createdAt,
        }];
      }
      continue;
    }
    // 最终轮：正文归属当前气泡（没有气泡就自己立一条）
    const b = run.cur ?? openBubble(m.createdAt);
    b.content = m.content ?? '';
    b.reasoning = m.reasoning || undefined;
    if (m.tokensIn || m.tokensOut) b.usage = { input: m.tokensIn ?? 0, output: m.tokensOut ?? 0 };
    b.cost = m.cost ?? 0;
    b.ts = m.createdAt;
    flush();
  }
  flush();
  return out;
}

/** 群成员名单（顶栏「群聊 · N 个成员」与入群条的共同数据源） */
export function collectMembers(messages: ChatMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    for (const t of m.tools ?? []) {
      const l = subagentLabel(t.name, t.args);
      if (l) set.add(l);
    }
  }
  return [...set];
}

export type RenderNode =
  | { kind: 'msg'; key: string; msg: ChatMessage }
  /** 入群条：从消息里的工具卡**派生**（不再存进 messages），所以实时与刷新必然一致 */
  | { kind: 'join'; key: string; member: string; ts?: number };

/** 把消息序列展开成渲染节点：首次出现的群成员前面插一条「加入了群聊」 */
export function withJoins(messages: ChatMessage[]): RenderNode[] {
  const nodes: RenderNode[] = [];
  const seen = new Set<string>();
  const pushJoin = (member: string, ts?: number) => {
    if (seen.has(member)) return;
    seen.add(member);
    nodes.push({ kind: 'join', key: `join-${member}`, member, ts });
  };
  for (const m of messages) {
    if (m.role === 'system' && m.sysKind === 'join' && m.member) {
      // 历史遗留：老版本曾把入群条塞进 messages（不落库，仅当次会话内可能存在）
      pushJoin(m.member, m.ts);
      continue;
    }
    if (m.role === 'assistant') {
      for (const t of m.tools ?? []) {
        if (isSubagentTool(t.name)) {
          const label = subagentLabel(t.name, t.args);
          if (label) pushJoin(label, m.ts);
        }
      }
    }
    nodes.push({ kind: 'msg', key: m.id, msg: m });
  }
  return nodes;
}

/** 时间分隔线可见性：与上一个"可见节点"间隔 > 5 分钟 */
export function shouldShowDivider(prevTs: number | undefined, ts: number | undefined): boolean {
  const FIVE_MIN = 5 * 60_000;
  if (!ts) return false;
  return prevTs === undefined || ts - prevTs > FIVE_MIN;
}
