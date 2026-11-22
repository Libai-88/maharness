/**
 * server/usecases/provider-support.ts —— Provider 用例的共用件
 *
 * 只放无编排的成分：协议枚举、诊断快照、探测请求与模型拉取的协议差异、能力检测视图。
 * 这样 `providers.ts`（增删改测）与 `provider-models.ts`（模型画像）都不必重复这些细节。
 */
import { extractFromProviderMeta, resolveCapabilities } from '../../kernel/modelCatalog';
import { MODEL_SCHEMA_VERSION, stableModelIdentity } from '../../kernel/model-schema';
import type { ProviderGateway } from '../../kernel/provider-gateway';
import type { ProviderHealth } from '../host/adapters/chat';
import { ConcurrentStoreWriteError } from '../db';
import type { ProviderRow } from '../db';
import type { ProviderStore } from '../store/ports';
import { modelCheckFingerprint } from '../model-tool-check';
import { fetchWithPublicRedirects } from '../http/security';

/** 支持的协议族（本地/内网地址需 AGENT_ALLOW_PRIVATE_URLS=1） */
export type ProviderProtocol = 'openai' | 'anthropic' | 'ollama';
export const PROTOCOLS: ProviderProtocol[] = ['openai', 'anthropic', 'ollama'];

export function isConcurrentStoreWrite(error: unknown): error is ConcurrentStoreWriteError {
  return error instanceof ConcurrentStoreWriteError;
}

export function protocolOf(value: unknown, fallback: ProviderProtocol = 'openai'): ProviderProtocol {
  return (PROTOCOLS as string[]).includes(String(value ?? '')) ? (String(value) as ProviderProtocol) : fallback;
}

export interface PulledModel {
  id: string;
  label?: string;
  raw: unknown;
}

export interface ProviderDiagnosticModel {
  providerId: string;
  modelId: string;
  modelKey: string;
  pricingId: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  priceIn: number;
  priceOut: number;
  source: string;
}

export interface ProviderDiagnostics {
  schemaVersion: typeof MODEL_SCHEMA_VERSION;
  providerId: string;
  protocol: string;
  configured: { baseUrl: boolean; apiKey: boolean; defaultModel: boolean };
  health: ProviderHealth | null;
  models: ProviderDiagnosticModel[];
  issues: string[];
}

/** 生成不含密钥材料的 Provider 配置诊断，供设置页和运维脚本共用。 */
export function buildProviderDiagnostics(
  input: {
    id: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    protocol?: string;
  },
  models: ProviderDiagnosticModel[],
  health?: ProviderHealth,
): ProviderDiagnostics {
  const configured = {
    baseUrl: !!input.baseUrl?.trim(),
    apiKey: !!input.apiKey?.trim(),
    defaultModel: !!input.model?.trim(),
  };
  const issues: string[] = [];
  if (!configured.baseUrl) issues.push('缺少 Provider 地址');
  if (!configured.apiKey && input.protocol !== 'ollama') issues.push('缺少 API Key');
  if (!configured.defaultModel) issues.push('缺少默认模型');
  if (configured.defaultModel && models.length > 0 && !models.some((m) => m.modelId === input.model)) {
    issues.push('默认模型未登记或未完成能力探测');
  }
  if (health?.authFailed) issues.push('最近请求认证失败，请检查 API Key 或权限');
  else if ((health?.failures ?? 0) > 0) issues.push(`最近请求失败 ${health!.failures} 次`);
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    providerId: input.id,
    protocol: input.protocol ?? 'openai',
    configured,
    health: health ?? null,
    models,
    issues,
  };
}

/** Provider Gateway 的公开快照：不含地址、密钥或可执行方法。 */
export function buildProviderGatewaySnapshot(gateway: ProviderGateway): {
  schemaVersion: 1;
  providers: { id: string; label: string; protocol: string; defaultModel: string }[];
  models: ReturnType<ProviderGateway['models']>;
  health: Record<string, ReturnType<ProviderGateway['health']>>;
} {
  const providers = gateway.providers().map((provider) => ({
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol ?? 'openai',
    defaultModel: provider.defaultModel,
  }));
  return {
    schemaVersion: 1,
    providers,
    models: gateway.models(),
    health: Object.fromEntries(providers.map((provider) => [provider.id, gateway.health(provider.id)])),
  };
}

/** 各协议的最小可用探测请求（URL + 头 + 体） */
export function buildPing(base: string, protocol: string, key: string, model: string): [string, RequestInit] {
  if (protocol === 'anthropic') {
    return [
      `${base}/v1/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(15000),
      },
    ];
  }
  if (protocol === 'ollama') {
    return [
      `${base}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(30000),
      },
    ];
  }
  return [
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(15000),
    },
  ];
}

/** 按协议拉取模型列表（三家协议端点/鉴权头各异）；HTTP 非 2xx 抛错且不回显远端 body */
export async function fetchProviderModels(base: string, protocol: ProviderProtocol, key: string): Promise<PulledModel[]> {
  // A5：走 fetchWithPublicRedirects（redirect:'manual' + 逐跳 SSRF 校验），不再让 undici 自行
  // 跟随 30x——/models 会把响应体解析后回吐，重定向不校验就是可读型 SSRF。
  const doFetch = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    const r = await fetchWithPublicRedirects(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 || r.status === 403 ? '（Key 无效或无权限）' : ''}`);
    return await r.json().catch(() => null);
  };
  const asArray = (j: unknown): unknown[] => {
    if (Array.isArray(j)) return j;
    const o = j as Record<string, unknown> | null;
    for (const k of ['data', 'models', 'body']) {
      if (Array.isArray(o?.[k])) return o![k] as unknown[];
    }
    return [];
  };
  const pick = (m: unknown): PulledModel | null => {
    if (typeof m === 'string') return m ? { id: m, raw: {} } : null;
    if (!m || typeof m !== 'object') return null;
    const o = m as Record<string, unknown>;
    const id =
      (typeof o.id === 'string' && o.id) || (typeof o.model === 'string' && o.model) || (typeof o.name === 'string' && o.name) || '';
    if (!id) return null;
    const label = typeof o.display_name === 'string' ? o.display_name : typeof o.title === 'string' ? o.title : undefined;
    return { id, label, raw: o };
  };

  if (protocol === 'anthropic') {
    const j = await doFetch(`${base}/v1/models?limit=1000`, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    });
    return asArray(j)
      .map(pick)
      .filter((m): m is PulledModel => !!m);
  }
  if (protocol === 'ollama') {
    const j = await doFetch(`${base}/api/tags`, { Accept: 'application/json' });
    const list = asArray(j);
    return list.map(pick).filter((m): m is PulledModel => !!m);
  }
  const j = await doFetch(`${base}/models`, { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  return asArray(j)
    .map(pick)
    .filter((m): m is PulledModel => !!m);
}

/** 原生工具调用的持久化判定视图：指纹不一致时视为未检测（模型或地址换过）。 */
export function toolCheckView(store: ProviderStore, provider: ProviderRow, model: string) {
  const check = store.runs.modelToolCheck(provider.id, model);
  return check?.fingerprint === modelCheckFingerprint(provider)
    ? { status: check.status, checkedAt: check.checkedAt, reason: check.reason }
    : { status: 'unknown' as const };
}

/** 拉取到的模型 + 能力位（provider 真实字段优先，缺省按内置目录推断）。 */
export function capabilitiesOfPulled(providerId: string, modelId: string, raw: unknown) {
  const meta = extractFromProviderMeta(raw);
  const caps = resolveCapabilities(modelId, providerId, {}, meta);
  return {
    id: modelId,
    ...stableModelIdentity(providerId, modelId),
    contextWindow: caps.contextWindow,
    maxOutput: caps.maxOutput,
    vision: caps.vision,
    tools: caps.tools,
    reasoning: caps.reasoning,
    priceIn: caps.priceIn,
    priceOut: caps.priceOut,
    source: Object.keys(meta).length ? 'pulled' : 'inferred',
  };
}
