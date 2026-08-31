/**
 * core/chat/provider.ts —— 多 Provider LLM 客户端（全部自研）
 * 统一走 OpenAI 兼容接口（/chat/completions），原生 fetch + SSE 流式解析，零 SDK 依赖。
 * 环境变量约定：<NAME>_BASE_URL + <NAME>_API_KEY + <NAME>_MODEL（NAME 大写），自动发现。
 * 价格：内置常见模型价格表（每百万 token USD），可用 <NAME>_PRICE_IN/OUT 覆盖。
 *
 * 缓存真实命中：各厂商在 usage 中以不同字段报告前缀缓存命中 token（DeepSeek
 * prompt_cache_hit_tokens / OpenAI·智谱 prompt_tokens_details.cached_tokens /
 * Anthropic cache_read_input_tokens），此处统一归一化为 cachedInput/missInput——
 * 真实命中率只能由 provider 说了算，本地估算不可替代。
 */
import { estimateTokens } from '../../kernel/tokens';
import type {
  ChatOptions, LLMChunk, LLMMessage, PluginContext, ProviderDef, ToolDef,
} from '../../kernel/types';

/** 各厂商 usage 缓存字段归一化（OpenAI 兼容 + Anthropic 兼容双路）：
 *  - DeepSeek：prompt_cache_hit_tokens + prompt_cache_miss_tokens（和 = prompt_tokens）
 *  - OpenAI / 智谱：prompt_tokens_details.cached_tokens（命中）；miss = prompt - cached
 *  - Anthropic：cache_read_input_tokens（命中读取）；miss ≈ input_tokens - cache_read
 *  不识别任何字段（provider 不支持缓存）时返回 undefined，调用方按「无反馈」处理。 */
export function normalizeUsage(raw: Record<string, unknown>): {
  input: number; output: number; cachedInput?: number; missInput?: number;
} {
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  let cachedInput: number | undefined;
  let missInput: number | undefined;
  if (typeof raw.prompt_cache_hit_tokens === 'number') {
    // DeepSeek 风格：命中 + 未命中 = 全部输入
    cachedInput = raw.prompt_cache_hit_tokens;
    missInput = typeof raw.prompt_cache_miss_tokens === 'number'
      ? raw.prompt_cache_miss_tokens
      : Math.max(0, input - cachedInput);
  } else if (details && typeof details.cached_tokens === 'number') {
    // OpenAI / 智谱 风格：cached_tokens 单独报告，未命中 = 总输入 - 命中
    cachedInput = details.cached_tokens;
    missInput = Math.max(0, input - cachedInput);
  } else if (typeof raw.cache_read_input_tokens === 'number') {
    // Anthropic 风格：cache_read 为命中读取，其余 input 为未命中
    cachedInput = raw.cache_read_input_tokens;
    missInput = Math.max(0, input - cachedInput);
  }
  return { input, output, cachedInput, missInput };
}

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
      if (process.env.TRACE_LLM_BODY === 'on') {
        const { appendFileSync } = await import('node:fs');
        try { appendFileSync('llm-body.log', JSON.stringify(messages) + '\n'); } catch { /* ignore */ }
      }
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
      if (process.env.TRACE_LLM_BODY === 'on') {
        const { appendFileSync } = await import('node:fs');
        try { appendFileSync('llm-full.log', JSON.stringify(body) + '\n'); } catch { /* ignore */ }
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
      // M7：记录是否收到 usage / 累积输出文本（usage 缺失时估算计费用的）
      let usageSeen = false;
      let outText = '';

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
                usageSeen = true;
                const u = normalizeUsage(json.usage);
                yield {
                  type: 'usage',
                  input: u.input,
                  output: u.output,
                  cachedInput: u.cachedInput,
                  missInput: u.missInput,
                };
              }
            } catch { /* 非 JSON 行（keep-alive 等）跳过 */ }
          }
        }
      } finally {
        reader.releaseLock();
      }
      // M7 断流半包：流正常结束但未收到 [DONE] 标记 → 视为错误抛出（半截响应不可信，
      // 进入重试链——重试状态由执行器 C1 重置，前端作废残段重新累积）
      if (!finished) {
        throw new Error(`LLM 流异常中断 [${cfg.id}]：连接已关闭但未收到 [DONE] 结束标记`);
      }
      yield* flushToolCalls();
      // M7 usage 缺失：按 token 估算计费 + console.warn（成本记 0 会让成本熔断失效——
      // 免费错觉是最危险的错觉；估算仅用于成本核算口径，非精确值）
      if (!usageSeen) {
        const estIn = estimateTokens(messages.map((m) => m.content ?? '').join('\n'));
        const estOut = estimateTokens(outText);
        console.warn(`[provider:${cfg.id}] 流结束但 usage 缺失，按估算计费（in≈${estIn}, out≈${estOut} tokens）`);
        yield { type: 'usage', input: estIn, output: estOut };
      }
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
    // 本地 embedding（本机 Ollama 等）常见，不做私网限制；超时防 L1 查询被无期限网络请求拖住
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Embedding 请求失败 ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data[0]?.embedding ?? [];
  });
  ctx.logger.info(`L1 语义缓存已激活（${model}）`);
}
