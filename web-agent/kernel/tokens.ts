/**
 * kernel/tokens.ts —— token 估算工具（core 与 server 共用）
 * 粗略估算：中文字符 ≈ 1 token，其他字符按符号密度 ≈ 3~4 字符 1 token。
 * 用于上下文预算管理、L3 前缀缓存统计等场景（非精确计费，仅近似） */

/** 估算一段文本的 token 数。
 *  代码/JSON 特征（{}[]<>; 等符号密度高）按 ~3 字符/token 估算：分词器对符号密集
 *  文本切分更碎，固定 4 字符/token 会系统性低估——低估 = 预算虚标 = 该截断时不截断。 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - cjk;
  if (rest <= 0) return cjk;
  const symbols = (text.match(/[{}[\]()<>;:,&|=!+\-*/\\'"`@#$%^~?]/g) ?? []).length;
  const perToken = symbols / text.length > 0.1 ? 3 : 4;
  return Math.ceil(cjk + rest / perToken);
}

export interface TokenizerAdapter {
  id: string;
  countText(text: string): number;
  countMessages?: (messages: PrefixMessage[]) => number;
}

export function countMessageTokens(messages: PrefixMessage[], tokenizer?: TokenizerAdapter): number {
  if (tokenizer?.countMessages) return Math.max(0, Math.floor(tokenizer.countMessages(messages)));
  return messages.reduce((sum, message) => {
    let tokens = estimateTokens(message.content ?? '');
    if (message.tool_calls !== undefined && message.tool_calls !== null) tokens += estimateTokens(JSON.stringify(message.tool_calls));
    return sum + tokens;
  }, 0);
}

export interface TokenBudgetAllocation {
  total: number;
  system: number;
  task: number;
  history: number;
  tools: number;
  memory: number;
  output: number;
}

/**
 * 将上下文总预算拆成可审计的固定分项。百分比只定义保留区，剩余额度归历史，
 * 因而所有分项之和始终等于 total，调用方可以直接复算超限原因。
 */
export function allocateTokenBudget(total: number, reserves: Partial<Pick<TokenBudgetAllocation, 'system' | 'task' | 'tools' | 'memory' | 'output'>> = {}): TokenBudgetAllocation {
  const normalized = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  let remaining = normalized;
  const reserve = (key: keyof typeof reserves, ratio: number): number => {
    const explicit = reserves[key];
    const value = explicit === undefined ? Math.floor(normalized * ratio) : Math.max(0, Math.floor(explicit));
    const allocated = Math.min(remaining, value);
    remaining -= allocated;
    return allocated;
  };
  const system = reserve('system', 0.08);
  const task = reserve('task', 0.08);
  const tools = reserve('tools', 0.12);
  const memory = reserve('memory', 0.05);
  const output = reserve('output', 0.15);
  const history = remaining;
  return { total: normalized, system, task, history, tools, memory, output };
}

/** 前缀比较用的消息形状（role/content 之外，tool_calls 与 tool_call_id 也参与相等判断） */
interface PrefixMessage {
  role?: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** 估算两组消息的公共前缀 token 数（provider 的 prompt 前缀缓存/KV cache 可复用的部分）。
 *  前缀逐消息严格相等才可复用：role、content、tool_calls、tool_call_id 任一不同即断裂——
 *  旧实现漏比 tool_calls/tool_call_id（assistant 的函数调用与 tool 回执不同但 content 同为
 *  null 时被当作相同），统计虚高、缓存命中率失真。 */
export function sharedPrefixTokens(
  a: PrefixMessage[],
  b: PrefixMessage[],
): number {
  let tokens = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ma = a[i];
    const mb = b[i];
    if (ma.role !== mb.role || ma.content !== mb.content) break;
    if (JSON.stringify(ma.tool_calls) !== JSON.stringify(mb.tool_calls)) break;
    if ((ma.tool_call_id ?? '') !== (mb.tool_call_id ?? '')) break;
    tokens += estimateTokens(ma.content ?? '');
    // assistant 的 tool_calls（函数名+参数串）同样是 prefill 输入的一部分
    if (ma.tool_calls !== undefined && ma.tool_calls !== null) {
      tokens += estimateTokens(JSON.stringify(ma.tool_calls));
    }
  }
  return tokens;
}
