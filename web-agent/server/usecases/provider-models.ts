/** server/usecases/provider-models.ts —— 模型列表拉取与模型画像（ADR 0010） */
import { MODEL_SCHEMA_VERSION, stableModelIdentity } from '../../kernel/model-schema';
import type { ProviderStore } from '../store/ports';
import { assertProviderBaseUrl } from '../http/security';
import { refreshChatProviders } from '../http/chat-service';
import { UsecaseError } from './error';
import { capabilitiesOfPulled, fetchProviderModels, isConcurrentStoreWrite, PROTOCOLS } from './provider-support';
import type { ProviderDeps } from './providers';
import type { ProviderProtocol, PulledModel } from './provider-support';

/** 拉取模型列表（openai / anthropic / ollama 三协议），并落 models 表。
 *  persist=false 时只返回不落库（新增供应商尚未保存的场景）。 */
export async function pullModels(deps: ProviderDeps, body: Record<string, unknown>) {
  const { kernel, store } = deps;
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
  const providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
  const persist = body.persist;
  let useKey = apiKey;
  let protocol = String(body.protocol ?? '').trim();
  const existingRow = providerId ? store.getProvider(String(providerId)) : undefined;
  if (!useKey && existingRow) useKey = existingRow.apiKey;
  if (!protocol) protocol = existingRow?.protocol ?? 'openai';
  if (!PROTOCOLS.includes(protocol as ProviderProtocol)) throw new UsecaseError(400, `protocol 非法: ${protocol}`);
  if (!baseUrl?.trim()) throw new UsecaseError(400, '地址为必填');
  if (!useKey?.trim() && protocol !== 'ollama') throw new UsecaseError(400, '地址 / Key 均为必填（编辑已保存供应商时 Key 可留空）');
  const base = String(baseUrl).trim().replace(/\/+$/, '');
  // 豁免判定统一走 assertProviderBaseUrl；真正的逐跳防护在 fetchProviderModels 内部
  try {
    await assertProviderBaseUrl(base);
  } catch (err) {
    throw new UsecaseError(400, err instanceof Error ? err.message : String(err));
  }
  let raw: PulledModel[];
  try {
    raw = await fetchProviderModels(base, protocol as ProviderProtocol, String(useKey ?? ''));
  } catch (err) {
    throw new UsecaseError(400, err instanceof Error ? err.message : String(err));
  }
  if (!raw.length) throw new UsecaseError(400, '响应中没有模型列表（data 为空或非该协议格式）');
  const pid = existingRow?.id ?? String(body.providerDraftId ?? 'draft');
  const out = raw.map((m) => ({
    label: m.label,
    ...capabilitiesOfPulled(pid, m.id, m.raw),
  }));
  if (persist !== false && existingRow) {
    store.upsertModels(
      out.map((o) => ({
        providerId: existingRow.id,
        modelId: o.id,
        contextWindow: o.contextWindow,
        maxOutput: o.maxOutput,
        vision: o.vision ? 1 : 0,
        tools: o.tools ? 1 : 0,
        reasoning: o.reasoning ? 1 : 0,
        priceIn: o.priceIn,
        priceOut: o.priceOut,
        source: o.source,
        enabled: 1,
      })),
    );
    refreshChatProviders(kernel, store);
  }
  return { ok: true, protocol, count: out.length, models: out.slice(0, 500) };
}

export function readModels(store: ProviderStore, providerId: string) {
  if (!store.getProvider(providerId)) throw new UsecaseError(404, '供应商不存在');
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    models: store.listModels(providerId).map((m) => ({ ...m, ...stableModelIdentity(m.providerId, m.modelId) })),
  };
}

/** 手改单个模型的能力位/价格（modelId 走 query：模型名含 / : 等字符，不能进路径） */
export function updateModelProfile(deps: ProviderDeps, providerId: string, query: Record<string, unknown>, body: Record<string, unknown>) {
  const { kernel, store } = deps;
  const provider = store.getProvider(providerId);
  if (!provider) throw new UsecaseError(404, '供应商不存在');
  const modelId = String(query.model ?? body.modelId ?? '');
  const prev = store.listModels(provider.id).find((m) => m.modelId === modelId);
  if (!prev) throw new UsecaseError(404, '模型未登记，请先拉取模型列表');
  if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw new UsecaseError(428, '更新模型画像前须携带读取到的 updatedAt 版本');
  try {
    store.updateModel(
      {
        ...prev,
        contextWindow: body.contextWindow === undefined ? prev.contextWindow : Number(body.contextWindow) || null,
        maxOutput: body.maxOutput === undefined ? prev.maxOutput : Number(body.maxOutput) || null,
        vision: body.vision === undefined ? prev.vision : body.vision ? 1 : 0,
        tools: body.tools === undefined ? prev.tools : body.tools ? 1 : 0,
        reasoning: body.reasoning === undefined ? prev.reasoning : body.reasoning ? 1 : 0,
        priceIn: body.priceIn === undefined ? prev.priceIn : Number(body.priceIn),
        priceOut: body.priceOut === undefined ? prev.priceOut : Number(body.priceOut),
        enabled: body.enabled === undefined ? prev.enabled : body.enabled ? 1 : 0,
        source: 'manual',
        latencyMs: body.latencyMs === undefined ? prev.latencyMs : Number(body.latencyMs) || null,
        privacyTier:
          body.privacyTier === undefined
            ? prev.privacyTier
            : ['local', 'trusted', 'external'].includes(String(body.privacyTier))
              ? (String(body.privacyTier) as 'local' | 'trusted' | 'external')
              : null,
        riskLevel:
          body.riskLevel === undefined
            ? prev.riskLevel
            : ['low', 'medium', 'high'].includes(String(body.riskLevel))
              ? (String(body.riskLevel) as 'low' | 'medium' | 'high')
              : null,
      },
      Number(body.expectedUpdatedAt),
    );
  } catch (error) {
    if (isConcurrentStoreWrite(error)) throw new UsecaseError(409, '模型画像已被其他写入者修改，请重新读取后再保存');
    throw error;
  }
  refreshChatProviders(kernel, store);
  return { ok: true };
}
