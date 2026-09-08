/**
 * core/chat/anthropic.ts —— Anthropic Messages API 适配（纯函数，零网络，可单测）
 * 与 OpenAI 兼容接口的四处实质差异，全部收在这个文件里：
 *  1. system 不是消息，是顶层参数；
 *  2. 消息只有 user/assistant 两 role，且 content 是块数组（text / image / tool_use / tool_result）；
 *  3. max_tokens 必填；工具声明字段名是 input_schema；
 *  4. 流没有 [DONE] 哨兵，靠 message_stop 收尾；token 用量分两处报（message_start 输入、
 *     message_delta 输出），且 cache_read_input_tokens 不计入 input_tokens。
 * 说明：maharness 的执行器会把工具轮文本化（agent.textualizeHistory），因此常态下这里
 * 只会收到 system/user/assistant 的纯文本 + images；tool/tool_result 映射按防御性保留。
 */
import type { LLMChunk, LLMMessage, ToolCall, ToolDef } from '../../kernel/types';

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type: string; media_type?: string; data?: string; url?: string };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/** data URL / http URL → Anthropic image source */
export function imageSource(dataUrl: string): AnthropicContentBlock['source'] | null {
  const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(dataUrl);
  if (m) return { type: 'base64', media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(dataUrl)) return { type: 'url', url: dataUrl };
  return null;
}

/** maharness 消息序列 → Anthropic system + messages（合并同角色、丢弃空块） */
export function mapMessages(messages: LLMMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const blocksFor = (m: LLMMessage): AnthropicContentBlock[] => {
    const blocks: AnthropicContentBlock[] = [];
    const text = String(m.content ?? '');
    if (text) blocks.push({ type: 'text', text });
    for (const img of m.images ?? []) {
      const source = imageSource(img);
      if (source) blocks.push({ type: 'image', source });
    }
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments }; }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name ?? '', input });
    }
    return blocks;
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(String(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content ?? '',
      };
      const last = out[out.length - 1];
      // tool_result 必须挂在 user 消息里；连续多个工具结果合并进同一条，避免 user/assistant 交替被破坏
      if (last && last.role === 'user' && last.content.some(b => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksFor(m);
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  // Anthropic 要求以 user 结尾的提问语义完整：末条若是 assistant（极少见）补一个继续提示
  if (out.length && out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: [{ type: 'text', text: '请继续。' }] });
  }
  return { system: systemParts.join('\n\n') || undefined, messages: out };
}

/** 工具声明：OpenAI function schema → Anthropic input_schema */
export function mapTools(tools: ToolDef[]): { name: string; description?: string; input_schema: Record<string, unknown> }[] {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters ?? { type: 'object', properties: {} } }));
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stream: true;
  temperature?: number;
  tools?: ReturnType<typeof mapTools>;
}

export function buildBody(model: string, messages: LLMMessage[], opts: { maxTokens?: number; temperature?: number; tools?: ToolDef[] }): AnthropicRequestBody {
  const mapped = mapMessages(messages);
  const body: AnthropicRequestBody = {
    model,
    messages: mapped.messages,
    max_tokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 4096,
    stream: true,
  };
  if (mapped.system) body.system = mapped.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.tools?.length) body.tools = mapTools(opts.tools);
  return body;
}

/** 流解析累加器（每个请求一份） */
export interface AnthropicStreamState {
  tools: Map<number, { id: string; name: string; json: string }>;
  usage: { input: number; output: number; cachedInput: number; creation: number };
  finished: boolean;
  errored: string | null;
}

export function createStreamState(): AnthropicStreamState {
  return { tools: new Map(), usage: { input: 0, output: 0, cachedInput: 0, creation: 0 }, finished: false, errored: null };
}

/** Anthropic SSE 事件 → maharness LLMChunk（纯归约，不产生副作用） */
export function reduceEvent(json: Record<string, unknown>, st: AnthropicStreamState): LLMChunk[] {
  const out: LLMChunk[] = [];
  const type = String(json.type ?? '');
  if (type === 'message_start') {
    const msg = json.message as Record<string, unknown> | undefined;
    const u = (msg?.usage ?? {}) as Record<string, unknown>;
    st.usage.input = Number(u.input_tokens ?? 0) || 0;
    st.usage.cachedInput = Number(u.cache_read_input_tokens ?? 0) || 0;
    st.usage.creation = Number(u.cache_creation_input_tokens ?? 0) || 0;
    return out;
  }
  if (type === 'content_block_start') {
    const cb = json.content_block as Record<string, unknown> | undefined;
    if (cb?.type === 'tool_use') {
      st.tools.set(Number(json.index ?? 0), { id: String(cb.id ?? ''), name: String(cb.name ?? ''), json: '' });
    }
    return out;
  }
  if (type === 'content_block_delta') {
    const d = (json.delta ?? {}) as Record<string, unknown>;
    if (d.type === 'text_delta' && typeof d.text === 'string') out.push({ type: 'delta', text: d.text });
    else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') out.push({ type: 'reasoning', text: d.thinking });
    else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      const acc = st.tools.get(Number(json.index ?? 0));
      if (acc) acc.json += d.partial_json;
    }
    return out;
  }
  if (type === 'content_block_stop') {
    const acc = st.tools.get(Number(json.index ?? 0));
    if (acc?.name) {
      const toolCall: ToolCall = {
        id: acc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: acc.name, arguments: acc.json || '{}' },
      };
      out.push({ type: 'tool_call', toolCall });
    }
    st.tools.delete(Number(json.index ?? 0));
    return out;
  }
  if (type === 'message_delta') {
    const u = (json.usage ?? {}) as Record<string, unknown>;
    if (typeof u.output_tokens === 'number') st.usage.output = u.output_tokens;
    return out;
  }
  if (type === 'message_stop') { st.finished = true; return out; }
  if (type === 'error') {
    const e = (json.error ?? {}) as Record<string, unknown>;
    st.errored = `${String(e.type ?? 'error')}: ${String(e.message ?? '')}`;
    return out;
  }
  return out;
}

/** 用量归一：Anthropic 的 input_tokens 不含缓存读写，总输入须三者相加 */
export function usageChunks(st: AnthropicStreamState): Extract<LLMChunk, { type: 'usage' }> {
  const total = st.usage.input + st.usage.cachedInput + st.usage.creation;
  const miss = st.usage.input + st.usage.creation;
  return {
    type: 'usage',
    input: total,
    output: st.usage.output,
    cachedInput: st.usage.cachedInput || undefined,
    missInput: miss || undefined,
  };
}
