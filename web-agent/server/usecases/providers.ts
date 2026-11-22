/**
 * server/usecases/providers.ts —— Provider 增删改、连接测试与能力检测（ADR 0010）
 *
 * 路由层只做协议与状态码映射，真正的校验、SSRF 边界、并发版本、健康状态联动都在这里。
 * 用例不碰 req/res：入参是普通对象，出错用 UsecaseError 表达 HTTP 语义。
 */
import { observeModelRequest } from '../../kernel/model-call';
import { MODEL_SCHEMA_VERSION, stableModelIdentity } from '../../kernel/model-schema';
import type { ProviderGateway } from '../../kernel/provider-gateway';
import type { Kernel } from '../../kernel';
import { getProviderHealth, isAuthError, LLMHttpError, noteProviderFailure, noteProviderSuccess } from '../host/adapters/chat';
import type { ProviderStore } from '../store/ports';
import { buildModelToolCheck, modelCheckFingerprint } from '../model-tool-check';
import { assertProviderBaseUrl, fetchWithPublicRedirects, maskKey } from '../http/security';
import { getChatService, refreshChatProviders } from '../http/chat-service';
import { UsecaseError } from './error';
import {
  buildPing,
  buildProviderDiagnostics,
  buildProviderGatewaySnapshot,
  isConcurrentStoreWrite,
  protocolOf,
  toolCheckView,
} from './provider-support';
import type { ProviderProtocol } from './provider-support';

export interface ProviderDeps {
  kernel: Kernel;
  /** 只允许碰 Provider / 模型 / 任务事实源这三块，存储实现由端口适配器提供（ADR 0007） */
  store: ProviderStore;
}

export function listProviders(deps: ProviderDeps) {
  const { store } = deps;
  const models = store.listModels();
  return store.listProviders().map((r) => ({
    id: r.id,
    label: r.label,
    baseUrl: r.baseUrl,
    model: r.model,
    protocol: r.protocol ?? 'openai',
    priceIn: r.priceIn,
    priceOut: r.priceOut,
    enabled: !!r.enabled,
    apiKeyMasked: maskKey(r.apiKey),
    hasKey: !!r.apiKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    toolCheck: toolCheckView(store, r, r.model),
    protocolToolCalls: ['openai', 'anthropic', 'ollama'].includes(r.protocol),
    models: models.filter((m) => m.providerId === r.id).map((m) => ({ ...m, ...stableModelIdentity(r.id, m.modelId) })),
    // 健康状态（failover 链上的真实调用回报）：401/403 → authFailed，设置页红标 + 会话横幅
    health: getProviderHealth(r.id),
  }));
}

export function providerDiagnostics(deps: ProviderDeps, id: string) {
  const provider = deps.store.getProvider(id);
  if (!provider) throw new UsecaseError(404, '供应商不存在');
  const models = deps.store.listModels(provider.id).map((m) => ({
    ...stableModelIdentity(provider.id, m.modelId),
    modelId: m.modelId,
    contextWindow: m.contextWindow ?? 0,
    maxOutput: m.maxOutput ?? 0,
    vision: !!m.vision,
    tools: !!m.tools,
    reasoning: !!m.reasoning,
    priceIn: m.priceIn ?? 0,
    priceOut: m.priceOut ?? 0,
    source: m.source ?? 'unknown',
  }));
  return buildProviderDiagnostics(provider, models, getProviderHealth(provider.id));
}

export function providerGateway(deps: ProviderDeps) {
  const gateway = deps.kernel.plugins.resolveService('service:provider-gateway') as ProviderGateway | undefined;
  if (!gateway) throw new UsecaseError(503, 'Provider Gateway 未加载（对话引擎插件未启用）');
  return buildProviderGatewaySnapshot(gateway);
}

function summarize(row: { id: string; label: string; baseUrl: string; model: string; enabled: number; apiKey: string }) {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: !!row.enabled,
    apiKeyMasked: maskKey(row.apiKey),
  };
}

export async function createProvider(deps: ProviderDeps, body: Record<string, unknown>) {
  const { kernel, store } = deps;
  const { label, baseUrl, apiKey, model, priceIn, priceOut } = body as Record<string, string | undefined>;
  const protocol = protocolOf(body.protocol);
  // Ollama 等本地网关不需要 API Key——Key 必填只约束云端协议（与 /test、/models 的豁免口径一致）
  const keyOptional = protocol === 'ollama';
  if (!label?.trim() || !baseUrl?.trim() || !model?.trim() || (!keyOptional && !apiKey?.trim())) {
    throw new UsecaseError(400, keyOptional ? '名称 / 地址 / 模型 均为必填（本地网关无需 Key）' : '名称 / 地址 / Key / 模型 均为必填');
  }
  // H5 SSRF：保存路径与 /test 同规则校验（真实对话会按此地址服务端 fetch）。
  try {
    await assertProviderBaseUrl(String(baseUrl).trim());
  } catch (err) {
    throw new UsecaseError(400, err instanceof Error ? err.message : String(err));
  }
  const id = `${
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'provider'
  }-${Math.random().toString(36).slice(2, 6)}`;
  store.upsertProvider({
    id,
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: (apiKey ?? '').trim(),
    model: model.trim(),
    protocol,
    priceIn: priceIn === '' || priceIn == null ? undefined : Number(priceIn),
    priceOut: priceOut === '' || priceOut == null ? undefined : Number(priceOut),
  });
  refreshChatProviders(kernel, store);
  return summarize(store.getProvider(id)!);
}

export async function updateProvider(deps: ProviderDeps, id: string, body: Record<string, unknown>) {
  const { kernel, store } = deps;
  const existing = store.getProvider(id);
  if (!existing) throw new UsecaseError(404, '供应商不存在');
  if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw new UsecaseError(428, '更新供应商前须携带读取到的 updatedAt 版本');
  const { label, baseUrl, apiKey, model, priceIn, priceOut, enabled } = body as Record<string, string | number | boolean | undefined>;
  const protocol = protocolOf(body.protocol, (existing.protocol ?? 'openai') as ProviderProtocol);
  // H5 SSRF：仅当地址被修改时校验（沿用已保存地址无需重复检查）
  if (typeof baseUrl === 'string' && baseUrl.trim() && baseUrl.trim() !== existing.baseUrl) {
    try {
      await assertProviderBaseUrl(baseUrl.trim());
    } catch (err) {
      throw new UsecaseError(400, err instanceof Error ? err.message : String(err));
    }
  }
  try {
    store.upsertProvider({
      id: existing.id,
      label: typeof label === 'string' && label.trim() ? label.trim() : existing.label,
      baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : existing.baseUrl,
      // Key 留空/不传 = 保持不变
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : existing.apiKey,
      model: typeof model === 'string' && model.trim() ? model.trim() : existing.model,
      protocol,
      priceIn: priceIn === undefined ? (existing.priceIn ?? undefined) : priceIn === '' ? undefined : Number(priceIn),
      priceOut: priceOut === undefined ? (existing.priceOut ?? undefined) : priceOut === '' ? undefined : Number(priceOut),
      enabled: enabled === undefined ? existing.enabled : enabled ? 1 : 0,
      expectedUpdatedAt: Number(body.expectedUpdatedAt),
    });
  } catch (error) {
    if (isConcurrentStoreWrite(error)) throw new UsecaseError(409, '供应商已被其他写入者修改，请重新读取后再保存');
    throw error;
  }
  refreshChatProviders(kernel, store);
  const row = store.getProvider(existing.id)!;
  return { ...summarize(row), updatedAt: row.updatedAt };
}

export function removeProvider(deps: ProviderDeps, id: string, body: Record<string, unknown>) {
  const { kernel, store } = deps;
  const existing = store.getProvider(id);
  if (!existing) throw new UsecaseError(404, '供应商不存在');
  if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw new UsecaseError(428, '删除供应商前须携带读取到的 updatedAt 版本');
  try {
    store.deleteProvider(id, Number(body.expectedUpdatedAt));
  } catch (error) {
    if (isConcurrentStoreWrite(error)) throw new UsecaseError(409, '供应商已被其他写入者修改，请重新读取后再删除');
    throw error;
  }
  refreshChatProviders(kernel, store);
  return { ok: true };
}

/** 连接测试：按协议发最小请求，返回真实往返延迟（替代前端伪造的 Math.random） */
export async function testProvider(deps: ProviderDeps, body: Record<string, unknown>) {
  const { store } = deps;
  const { baseUrl, apiKey, model, providerId } = body as Record<string, string | undefined>;
  let useKey = apiKey;
  if (!useKey && providerId) useKey = store.getProvider(String(providerId))?.apiKey;
  if (!baseUrl?.trim() || !model?.trim()) throw new UsecaseError(400, '地址 / 模型 均为必填');
  if (!useKey?.trim() && String(body.protocol ?? '') !== 'ollama') throw new UsecaseError(400, 'Key 为必填');
  const base = String(baseUrl).trim().replace(/\/+$/, '');
  // H5 SSRF 防护：协议白名单 + 逐跳校验（redirect:'manual'，见 fetchWithPublicRedirects）
  try {
    await assertProviderBaseUrl(base);
  } catch (err) {
    throw new UsecaseError(400, err instanceof Error ? err.message : String(err));
  }
  const protocol = protocolOf(body.protocol);
  const started = Date.now();
  // 验证结果联动 provider 健康状态：换 key 后点「验证密钥」立即确认恢复
  const pid = providerId ? String(providerId) : undefined;
  try {
    const [pingUrl, pingInit] = buildPing(base, protocol, String(useKey ?? ''), String(model));
    const r = await observeModelRequest(String(providerId ?? 'draft'), String(model), 1, async (signal) => {
      const value = await fetchWithPublicRedirects(pingUrl, {
        ...pingInit,
        signal: signal ? AbortSignal.any([signal, pingInit.signal!]) : pingInit.signal,
      });
      const parsed = (await value
        .clone()
        .json()
        .catch(() => ({}))) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
      return { value, input: parsed.usage?.prompt_tokens, output: parsed.usage?.completion_tokens, actualModel: parsed.model };
    });
    const latencyMs = Date.now() - started;
    if (!r.ok) {
      // H5：不回显远端 body（内网探针/错误页可能泄露内部信息）——只给状态码
      const error = `HTTP ${r.status}`;
      if (pid) noteProviderFailure(pid, new LLMHttpError(r.status, error));
      return { ok: false, latencyMs, error, authFailed: isAuthError(error) };
    }
    await r.body?.cancel().catch(() => {
      /* 忽略 */
    });
    if (pid) noteProviderSuccess(pid);
    return { ok: true, latencyMs, protocol, message: `连接成功（${latencyMs}ms）——密钥有效，provider 已恢复健康` };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (pid) noteProviderFailure(pid, error);
    return { ok: false, latencyMs: Date.now() - started, error, authFailed: isAuthError(error) };
  }
}

/** 原生工具调用检测：只认真实往返结果，transport 失败不改变既有能力判定。 */
export async function checkToolCall(deps: ProviderDeps, id: string, body: Record<string, unknown>) {
  const { store } = deps;
  const provider = store.getProvider(id);
  if (!provider) throw new UsecaseError(404, '供应商不存在');
  const model = body.model ?? provider.model;
  if (typeof model !== 'string' || !model.trim() || model.length > 500) throw new UsecaseError(400, '模型名称无效');
  try {
    await assertProviderBaseUrl(provider.baseUrl);
    const probe = buildModelToolCheck(provider.baseUrl, provider.protocol, provider.apiKey, model);
    const response = await observeModelRequest(provider.id, model, 256, async (signal) => {
      const value = await fetchWithPublicRedirects(probe.url, {
        ...probe.init,
        signal: signal ? AbortSignal.any([signal, probe.init.signal!]) : probe.init.signal,
      });
      const parsed = (await value
        .clone()
        .json()
        .catch(() => ({}))) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
        model?: string;
      };
      return {
        value,
        input: parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens,
        output: parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens,
        actualModel: parsed.model,
      };
    });
    let confirmed = false;
    if (response.ok) {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1_000_000) throw new Error('检测响应超过容量');
          chunks.push(chunk.value);
        }
        confirmed = probe.confirm(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
    } else await response.body?.cancel().catch(() => undefined);
    const check = {
      status: confirmed ? ('confirmed' as const) : ('not_confirmed' as const),
      checkedAt: Date.now(),
      fingerprint: modelCheckFingerprint(provider),
      ...(confirmed ? {} : { reason: response.ok ? '此次检测未返回有效原生工具调用；可核对模型与协议后重试' : `HTTP ${response.status}` }),
    };
    store.runs.saveModelToolCheck(provider.id, model, check);
    return toolCheckView(store, provider, model);
  } catch {
    // Transport failure cannot establish or revoke model capability.
    throw new UsecaseError(502, '工具调用检测失败，请检查连接后重试');
  }
}

/** 前端模型选择器的数据源：每个 provider 的全部可用模型，key = provider@model */
export function listChatModels(deps: ProviderDeps) {
  const { kernel, store } = deps;
  const chat = getChatService(kernel);
  if (!chat) return [];
  return chat.providers.flatMap((p) => {
    const list = p.models?.length
      ? p.models
      : [
          {
            modelId: p.defaultModel,
            enabled: true,
            contextWindow: 0,
            maxOutput: 0,
            vision: false,
            tools: false,
            reasoning: false,
            priceIn: 0,
            priceOut: 0,
            source: 'inferred',
          },
        ];
    return list
      .filter((m) => m.enabled)
      .map((m) => ({
        ...stableModelIdentity(p.id, m.modelId),
        toolCheck: (() => {
          const row = store.getProvider(p.id);
          return row ? toolCheckView(store, row, m.modelId) : { status: 'unknown' };
        })(),
        schemaVersion: MODEL_SCHEMA_VERSION,
        id: `${p.id}@${m.modelId}`,
        provider: p.id,
        label: p.label,
        model: m.modelId,
        vision: m.vision,
        tools: m.tools,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));
  });
}
