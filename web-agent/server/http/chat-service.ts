/**
 * server/routes/chat-service.ts —— 对话能力层的端口解析与热刷新
 * server 不直接 import core/chat：这里只按服务接口解析"当前激活的提供者"，并把 DB 里的
 * Provider / 人设热刷新进去。解析不到就返回 undefined，由调用方给出可读错误。
 */
import type { Kernel } from '../../kernel';
import type { LLMMessage, ModelCapability, ProviderDef, ToolDef } from '../../kernel/types';
import { inferCapabilities } from '../../kernel/modelCatalog';
import type { AgentLoop } from '../../kernel/types';
import { makeRunner } from '../../kernel/types';
import type { ProviderConfig, CompactOptions, CompactResult } from '../host/adapters/chat';
import type { Store } from '../db';

/** 刷新对话 Provider 所需的最小读取面（端口化后由 ProviderStore 结构性满足） */
export type ProviderChatSource = Pick<Store, 'listProviders' | 'listModels' | 'getProvider'>;

export interface ChatService {
  providers: ProviderDef[];
  setProviders: (cfgs: ProviderConfig[]) => void;
  setPersonas: (list: { name: string; content: string }[]) => void;
  getSystemPrompt: () => string;
  getRuntimePrompt?: () => string;
  getUserContext?: () => LLMMessage[];
  /** 挂起审批清单（可按会话过滤）：刷新页面后审批卡原位复原 */
  listApprovals: (
    sessionId?: string,
  ) => { id: string; name: string; summary: string; args?: unknown; sessionId?: string; createdAt: number; expiresAt: number }[];
  // 对话能力层共享方法（server 经服务接口访问，不直接 import core/chat 实现——
  // 接口与 core/chat/index.ts 导出的 service 对象保持一致）
  compactHistory: (history: LLMMessage[], maxTokens: number, opts?: CompactOptions) => Promise<CompactResult>;
  annotateToolDef: (t: ToolDef) => ToolDef;
  routeForTask: (
    taskText: string,
    routing: Record<string, string>,
    providers: ProviderDef[],
  ) =>
    | {
        provider: ProviderDef;
        model: string;
        reason: string;
        candidates: { providerId: string; model: string; score?: number; accepted: boolean; reasons: string[] }[];
      }
    | undefined;
  MODE_PROMPTS: Record<string, string>;
  ROLE_READONLY_TOOLS: ReadonlySet<string>;
  validateCheckpointHistory: (
    history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[],
  ) => string | null;
}

export function getChatService(kernel: Kernel): ChatService | undefined {
  // 共效应解析（v2）：依赖注册表按 key 解析，只返回 ACTIVE 提供者的绑定——比扫描能力表更直接
  return kernel.plugins.resolveService('service:chat') as ChatService | undefined;
}

/**
 * 造一个执行循环（service:runner）：server 层不再从 chat 服务里掏 runner——
 * 循环是可被任意插件接管的独立服务，对话引擎只是它的【默认实现】提供者。
 * 返回 undefined 表示无插件提供循环（如对话引擎被停用）：调用方据此返回可读错误。
 */
export function getRunner(kernel: Kernel): AgentLoop | undefined {
  return makeRunner(kernel as unknown as Parameters<typeof makeRunner>[0]);
}

/** 用 DB 中的启用 Provider 刷新对话服务（热生效，无需重启）；一并带上协议与模型能力 */
export function refreshChatProviders(kernel: Kernel, store: ProviderChatSource): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listProviders().filter((r) => r.enabled);
  const allModels = store.listModels();
  chat.setProviders(
    rows.map((r) => ({
      id: r.id,
      baseUrl: r.baseUrl,
      apiKey: r.apiKey,
      model: r.model,
      protocol: r.protocol ?? 'openai',
      models: capabilitiesOf(
        r.id,
        r.model,
        allModels.filter((m) => m.providerId === r.id),
      ),
      inputPrice: r.priceIn ?? undefined,
      outputPrice: r.priceOut ?? undefined,
    })),
  );
}

/** DB 模型行 → 运行时能力表；默认模型未登记时按目录推断补一条，保证路由永不缺数据 */
function capabilitiesOf(providerId: string, defaultModel: string, rows: ReturnType<Store['listModels']>): ModelCapability[] {
  const out: ModelCapability[] = rows.map((m) => {
    const inferred = inferCapabilities(m.modelId, providerId);
    return {
      modelId: m.modelId,
      contextWindow: m.contextWindow ?? inferred.contextWindow,
      maxOutput: m.maxOutput ?? inferred.maxOutput,
      vision: !!m.vision,
      tools: !!m.tools,
      reasoning: !!m.reasoning,
      priceIn: m.priceIn ?? inferred.priceIn,
      priceOut: m.priceOut ?? inferred.priceOut,
      enabled: !!m.enabled,
      source: m.source,
      latencyMs: m.latencyMs ?? undefined,
      privacyTier: m.privacyTier ?? undefined,
      riskLevel: m.riskLevel ?? undefined,
    };
  });
  if (defaultModel && !out.some((m) => m.modelId === defaultModel)) {
    out.push({ modelId: defaultModel, ...inferCapabilities(defaultModel, providerId), enabled: true, source: 'inferred' });
  }
  return out;
}

/** 用 DB 中的启用人设刷新对话服务（L1 层，热生效） */
export function refreshChatPersonas(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listPersonas().filter((r) => r.enabled);
  chat.setPersonas(rows.map((r) => ({ name: r.name, content: r.content })));
}
