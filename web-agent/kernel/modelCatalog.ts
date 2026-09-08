/**
 * kernel/modelCatalog.ts —— 模型能力与默认参数目录（纯函数，零依赖）
 * 事实源优先级：用户手填 > provider /models 返回的真实字段 > 本目录按模型名推断。
 * 只解决一件事：让「配置一个 provider」不再要求用户懂每个模型的窗口/是否支持视觉/是否支持工具。
 * 数值是**保守估计**（用于预算与选路），不是厂商承诺；provider 返回真实值时一律覆盖。
 */

export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** USD / 百万 token */
  priceIn: number;
  priceOut: number;
}

interface CatalogRule extends Partial<ModelCapabilities> {
  /** 匹配模型 id 的正则（小写后比较） */
  re: RegExp;
}

/** 顺序敏感：先具体后宽泛，命中即止 */
const CATALOG: CatalogRule[] = [
  // ---- OpenAI ----
  { re: /^gpt-4o(-mini)?/, contextWindow: 128_000, maxOutput: 16_000, vision: true, tools: true, priceIn: 2.5, priceOut: 10 },
  { re: /^gpt-4\.1/, contextWindow: 1_000_000, maxOutput: 32_000, vision: true, tools: true, priceIn: 2, priceOut: 8 },
  { re: /^gpt-4-turbo|^gpt-4-vision/, contextWindow: 128_000, maxOutput: 8_000, vision: true, tools: true, priceIn: 10, priceOut: 30 },
  { re: /^gpt-5|^chatgpt-4o-latest/, contextWindow: 200_000, maxOutput: 64_000, vision: true, tools: true, reasoning: true, priceIn: 1.25, priceOut: 10 },
  { re: /^o\d(-mini|-preview)?/, contextWindow: 200_000, maxOutput: 100_000, tools: true, reasoning: true, vision: true, priceIn: 3.5, priceOut: 14 },
  { re: /^gpt-3\.5|^gpt-4$|^gpt-4-0/, contextWindow: 16_385, maxOutput: 4_096, vision: false, tools: true, priceIn: 3, priceOut: 6 },

  // ---- Anthropic ----
  { re: /^claude-(opus|sonnet|haiku)-4|^claude-4/, contextWindow: 200_000, maxOutput: 32_000, vision: true, tools: true, reasoning: true, priceIn: 3, priceOut: 15 },
  { re: /^claude-3-5-|^claude-3-7-/, contextWindow: 200_000, maxOutput: 8_192, vision: true, tools: true, priceIn: 3, priceOut: 15 },
  { re: /^claude-3-/, contextWindow: 200_000, maxOutput: 4_096, vision: true, tools: true, priceIn: 3, priceOut: 15 },

  // ---- Google ----
  { re: /^gemini-2|^gemini-1\.5|^gemini-3/, contextWindow: 1_000_000, maxOutput: 65_536, vision: true, tools: true, priceIn: 0.1, priceOut: 0.4 },

  // ---- DeepSeek ----
  { re: /^deepseek-reasoner|^deepseek-r1/, contextWindow: 64_000, maxOutput: 8_000, vision: false, tools: false, reasoning: true, priceIn: 0.55, priceOut: 2.19 },
  { re: /^deepseek-chat|^deepseek-v3/, contextWindow: 64_000, maxOutput: 8_000, vision: false, tools: true, priceIn: 0.27, priceOut: 1.1 },

  // ---- 国产：视觉系命名统一识别 ----
  { re: /(^|[-.])vl([-.]|$)|vision|^qwen.*-v/, contextWindow: 32_000, maxOutput: 8_000, vision: true, tools: true, priceIn: 0.5, priceOut: 2 },
  { re: /^qwen3|^qwen2\.5|^qwen-max|^qwen-plus/, contextWindow: 128_000, maxOutput: 8_000, vision: false, tools: true, priceIn: 0.4, priceOut: 1.2 },
  { re: /^glm-4\.(5|6|air)|^glm-4\.v|^glm-4v/, contextWindow: 128_000, maxOutput: 16_000, vision: true, tools: true, reasoning: true, priceIn: 0.6, priceOut: 2 },
  { re: /^glm-/, contextWindow: 128_000, maxOutput: 4_096, vision: false, tools: true, priceIn: 0.6, priceOut: 2 },
  { re: /^kimi-|^moonshot/, contextWindow: 128_000, maxOutput: 8_000, vision: true, tools: true, priceIn: 0.6, priceOut: 2 },
  { re: /^doubao-|^ep-/, contextWindow: 128_000, maxOutput: 12_000, vision: true, tools: true, priceIn: 0.8, priceOut: 2 },
  { re: /^ernie-|^qianfan/, contextWindow: 128_000, maxOutput: 8_000, vision: true, tools: true, priceIn: 0.85, priceOut: 4.25 },
  { re: /:-\d+b$/, contextWindow: 32_768, maxOutput: 8_192, vision: false, tools: false, priceIn: 0.5, priceOut: 2 },   // Ollama 本地 tag

  // ---- 开源权重系（ollama / sglang 常见） ----
  { re: /^llama[-.]?[34]|^mistral|^mixtral|^qwen1|^yi-|^phi-|^gemma-|^deepseek-coder/, contextWindow: 32_768, maxOutput: 8_192, vision: false, tools: true, priceIn: 0, priceOut: 0 },
  { re: /^coder|^.*-coder/, contextWindow: 64_000, maxOutput: 16_000, vision: false, tools: true, priceIn: 0.2, priceOut: 0.6 },
];

const FALLBACK: ModelCapabilities = {
  contextWindow: 32_768, maxOutput: 4_096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 4,
};

/** 本地/自托管服务的价格一律记 0 */
const LOCAL_PRICE = /^(ollama|lmstudio|local|vllm|sglang)$/i;

export function inferCapabilities(modelId: string, providerId?: string): ModelCapabilities {
  const id = String(modelId ?? '').toLowerCase();
  const rule = CATALOG.find(r => r.re.test(id));
  const out: ModelCapabilities = {
    contextWindow: rule?.contextWindow ?? FALLBACK.contextWindow,
    maxOutput: rule?.maxOutput ?? FALLBACK.maxOutput,
    vision: rule?.vision ?? FALLBACK.vision,
    tools: rule?.tools ?? FALLBACK.tools,
    reasoning: rule?.reasoning ?? (/[_-](thinking|reasoner|r1)[_-]|[_-]o[13](?:[_-]|$)/.test(id)),
    priceIn: rule?.priceIn ?? FALLBACK.priceIn,
    priceOut: rule?.priceOut ?? FALLBACK.priceOut,
  };
  if (providerId && LOCAL_PRICE.test(providerId)) { out.priceIn = 0; out.priceOut = 0; }
  if (/(^|[-.])vl([-.]|$)|vision/.test(id)) out.vision = true;      // 名字里有 vl/vision 一定支持视觉
  return out;
}

/** provider /models 返回的原始对象里可能带的真实字段（各家命名不一），提取为部分能力 */
export function extractFromProviderMeta(meta: unknown): Partial<ModelCapabilities> {
  if (!meta || typeof meta !== 'object') return {};
  const m = meta as Record<string, unknown>;
  const out: Partial<ModelCapabilities> = {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);
  out.contextWindow = num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_length)
    ?? num((m.model_limits as Record<string, unknown> | undefined)?.context_length) ?? out.contextWindow;
  out.maxOutput = num(m.max_tokens) ?? num(m.max_output_tokens)
    ?? num((m.model_limits as Record<string, unknown> | undefined)?.output_length) ?? out.maxOutput;
  const modalities = m.supported_modalities ?? m.modalities ?? m.input_modalities;
  if (Array.isArray(modalities)) {
    const has = (k: string) => modalities.some(x => typeof x === 'string' && x.toLowerCase().includes(k));
    if (has('image')) out.vision = true;
    if (has('text') && !has('image')) out.vision = false;
  }
  const caps = m.capabilities;
  if (caps && typeof caps === 'object') {
    const c = caps as Record<string, unknown>;
    if (typeof c.tools === 'boolean') out.tools = c.tools;
    if (typeof c.vision === 'boolean') out.vision = c.vision;
    if (typeof c.reasoning === 'boolean') out.reasoning = c.reasoning;
  }
  if (typeof m.supports_tools === 'boolean') out.tools = m.supports_tools;
  if (typeof m.supports_vision === 'boolean') out.vision = m.supports_vision;
  if (typeof m.supports_reasoning === 'boolean') out.reasoning = m.supports_reasoning;
  const pricing = m.pricing as Record<string, unknown> | undefined;
  if (pricing) {
    const pin = Number(pricing.prompt ?? pricing.input);
    const pout = Number(pricing.completion ?? pricing.output);
    // ollama 类返回单位是 美元/秒或/百万，仅在接受范围内才采信
    if (Number.isFinite(pin) && pin >= 0 && pin < 1000) out.priceIn = pin;
    if (Number.isFinite(pout) && pout >= 0 && pout < 1000) out.priceOut = pout;
  }
  return out;
}

/** 合并：显式覆盖 > provider 真实值 > 目录推断 */
export function resolveCapabilities(
  modelId: string,
  providerId?: string,
  overrides: Partial<ModelCapabilities> = {},
  providerMeta: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  const inferred = inferCapabilities(modelId, providerId);
  return {
    contextWindow: overrides.contextWindow ?? providerMeta.contextWindow ?? inferred.contextWindow,
    maxOutput: overrides.maxOutput ?? providerMeta.maxOutput ?? inferred.maxOutput,
    vision: overrides.vision ?? providerMeta.vision ?? inferred.vision,
    tools: overrides.tools ?? providerMeta.tools ?? inferred.tools,
    reasoning: overrides.reasoning ?? providerMeta.reasoning ?? inferred.reasoning,
    priceIn: overrides.priceIn ?? providerMeta.priceIn ?? inferred.priceIn,
    priceOut: overrides.priceOut ?? providerMeta.priceOut ?? inferred.priceOut,
  };
}
