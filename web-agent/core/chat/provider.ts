/**
 * core/chat/provider.ts —— 多 Provider LLM 客户端（全部自研）
 * 统一走 OpenAI 兼容接口（/chat/completions），原生 fetch + SSE 流式解析，零 SDK 依赖。
 * 环境变量约定：<NAME>_BASE_URL + <NAME>_API_KEY + <NAME>_MODEL（NAME 大写），自动发现。
 * 价格：内置常见模型价格表（每百万 token USD），可用 <NAME>_PRICE_IN/OUT 覆盖。
 */
import type {
  ChatOptions, LLMChunk, LLMMessage, PluginContext, ProviderDef, ToolDef,
} from '../../kernel/types';

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  inputPrice?: number;
  outputPrice?: number;
}

/** 常见模型价格表（USD / 百万 token；如有出入以 .env 覆盖为准） */
const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'qwen-plus': { in: 0.4, out: 1.2 },
};

/** 扫描 .env / 环境变量，自动发现 OpenAI 兼容 Provider */
export function discoverProviders(): ProviderConfig[] {
  const map = new Map<string, ProviderConfig>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const m = key.match(/^([A-Z0-9]+)_(BASE_URL|API_KEY|MODEL|PRICE_IN|PRICE_OUT)$/);
    if (!m || m[1] === 'EMBEDDING') continue;
    const id = m[1].toLowerCase();
    const cfg = map.get(id) ?? { id, baseUrl: '', apiKey: '', model: '' };
    if (m[2] === 'BASE_URL') cfg.baseUrl = value;
    else if (m[2] === 'API_KEY') cfg.apiKey = value;
    else if (m[2] === 'MODEL') cfg.model = value;
    else if (m[2] === 'PRICE_IN') cfg.inputPrice = Number(value);
    else if (m[2] === 'PRICE_OUT') cfg.outputPrice = Number(value);
    map.set(id, cfg);
  }
  return [...map.values()].filter((c) => c.baseUrl && c.apiKey && c.model);
}

/** 估算成本（USD） */
export function estimateCost(provider: ProviderDef, input: number, output: number): number {
  const p = (provider as ProviderDef & { prices?: { in: number; out: number } }).prices;
  if (!p) return 0;
  return (input / 1_000_000) * p.in + (output / 1_000_000) * p.out;
}

/** 由配置创建 ProviderDef（含流式 chat 实现） */
export function createProvider(cfg: ProviderConfig): ProviderDef {
  const prices = PRICE_TABLE[cfg.model] ?? { in: cfg.inputPrice ?? 0.3, out: cfg.outputPrice ?? 1.2 };
  const resolvedPrices = {
    in: cfg.inputPrice ?? prices.in,
    out: cfg.outputPrice ?? prices.out,
  };
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return {
    id: cfg.id,
    label: cfg.id.toUpperCase(),
    defaultModel: cfg.model,
    prices: resolvedPrices,
    async *chat(messages: LLMMessage[], opts: ChatOptions): AsyncIterable<LLMChunk> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.7,
        stream_options: { include_usage: true },
      };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t: ToolDef) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM 请求失败 [${cfg.id}] ${res.status}: ${text.slice(0, 400)}`);
      }
      if (!res.body) throw new Error('LLM 响应无 body');

      // ---- SSE 流式解析（自研，逐行） ----
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let finished = false;

      const flushToolCalls = function* (): Generator<LLMChunk> {
        for (const tc of toolAcc.values()) {
          if (!tc.name) continue;
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            },
          };
        }
        toolAcc.clear();
      };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') { finished = true; break; }
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) yield { type: 'delta', text: delta.content };
              // 推理模型思考过程：DeepSeek 系 reasoning_content / OpenAI o1 系 reasoning
              const reasoning = delta?.reasoning_content ?? delta?.reasoning;
              if (reasoning) yield { type: 'reasoning', text: reasoning };
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name += tc.function.name;
                  if (tc.function?.arguments) acc.args += tc.function.arguments;
                  toolAcc.set(idx, acc);
                }
              }
              if (json.usage) {
                yield { type: 'usage', input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 };
              }
            } catch { /* 非 JSON 行（keep-alive 等）跳过 */ }
          }
        }
      } finally {
        reader.releaseLock();
      }
      yield* flushToolCalls();
      yield { type: 'done' };
    },
  };
}

/** 若配置了 EMBEDDING_* 环境变量，激活 L1 语义缓存 */
export function setupEmbedding(ctx: PluginContext): void {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  if (!baseUrl || !apiKey || !model) return;
  ctx.cache.setEmbeddingFn(async (text: string) => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) throw new Error(`Embedding 请求失败 ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data[0]?.embedding ?? [];
  });
  ctx.logger.info(`L1 语义缓存已激活（${model}）`);
}
