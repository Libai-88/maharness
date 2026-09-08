/**
 * core/chat/routing.ts —— 任务复杂度模型路由（2026 实践：FrugalGPT / RouteLLM）
 * 简单任务走便宜模型、复杂任务走强模型——harness 管理认知资源，而不是让 LLM 自觉。
 * maharness 版：复用 kernel/budget.ts 的 classifyTask（与任务画像同源），
 * 按任务类型把整次 run 路由到配置指定的 provider/model；未命中配置则用默认模型。
 */
import { classifyTask } from '../../kernel/budget';
import { capabilityFor } from './provider';
import type { ModelCapability, ProviderDef } from '../../kernel/types';

export interface RouteDecision {
  provider: ProviderDef;
  model: string;
  reason: string;
}

/**
 * 按任务类型路由到目标 provider/model。
 * @param taskText 当前用户消息（路由只对真实用户消息生效）
 * @param routing  config `agent.modelRouting`：任务类型 → provider id，如
 *   { 问答: 'deepseek', 代码: 'deepseek@deepseek-reasoner' }
 *   「默认」键作为兜底；值可用 `providerId@model` 同时指定模型。
 * @param providers 当前可用 provider 列表
 * @returns 路由决策；无配置 / 无可用 provider / 目标不存在时返回 undefined（调用方用默认）
 */
export function routeForTask(
  taskText: string,
  routing: Record<string, string>,
  providers: ProviderDef[],
): RouteDecision | undefined {
  const keys = Object.keys(routing);
  if (!keys.length || !providers.length) return undefined;
  const taskType = classifyTask(taskText || '');
  const target = routing[taskType] ?? routing['默认'];
  if (!target) return undefined;
  const [pid, model] = target.split('@');
  const provider = providers.find((p) => p.id === pid);
  if (!provider) return undefined;
  return {
    provider,
    model: model || provider.defaultModel,
    reason: `任务复杂度路由：${taskType} → ${pid}${model ? `@${model}` : ''}`,
  };
}

/** 能力谓词（当前只用到 vision，预留 tools/reasoning/长上下文） */
export interface CapabilityNeed {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  minContext?: number;
}

export interface CapabilityRoute {
  provider: ProviderDef;
  model: string;
  reason: string;
  /** 与请求方模型相同 = 无需切换 */
  same: boolean;
}

/**
 * 按能力需求选路：请求模型不满足能力时，从可用 provider 里挑一个满足的模型。
 * 偏好顺序：① 同 provider 内的能力模型（切换代价最小）→ ② 其他 provider；
 * 同层内按「上下文够用 + 价格低」排序。找不到返回 undefined（调用方如实报错）。
 */
export function routeForCapability(
  need: CapabilityNeed,
  providers: ProviderDef[],
  current: { providerId: string; model: string },
): CapabilityRoute | undefined {
  const satisfies = (cap: ModelCapability): boolean =>
    (need.vision === undefined || cap.vision === need.vision)
    && (need.tools === undefined || cap.tools === need.tools)
    && (need.reasoning === undefined || cap.reasoning === need.reasoning)
    && (need.minContext === undefined || cap.contextWindow >= need.minContext);

  const candidates: { provider: ProviderDef; cap: ModelCapability }[] = [];
  for (const p of providers) {
    for (const m of p.models ?? []) {
      if (!m.enabled || m.modelId === current.model) continue;
      if (satisfies(m)) candidates.push({ provider: p, cap: m });
    }
    // 未登记模型：默认模型按目录推断兜底
    if (!(p.models ?? []).some(m => m.modelId === p.defaultModel) && p.defaultModel && p.defaultModel !== current.model) {
      const cap = capabilityFor(p, p.defaultModel);
      if (cap && satisfies(cap)) candidates.push({ provider: p, cap });
    }
  }
  if (!candidates.length) return undefined;
  const rank = (c: { provider: ProviderDef; cap: ModelCapability }): number => {
    const sameProvider = c.provider.id === current.providerId ? 0 : 1;
    const price = c.cap.priceIn + c.cap.priceOut;
    return sameProvider * 1e6 + (need.minContext ? Math.max(0, need.minContext - c.cap.contextWindow) : 0) + price;
  };
  const best = candidates.sort((a, b) => rank(a) - rank(b))[0];
  return {
    provider: best.provider,
    model: best.cap.modelId,
    same: false,
    reason: `能力路由：${need.vision ? '需要视觉' : ''}${need.tools ? ' 需要工具' : ''}${need.reasoning ? ' 需要推理' : ''} → ${best.provider.id}@${best.cap.modelId}`,
  };
}

/** 当前模型是否已满足需求（满足则不路由） */
export function capabilitySatisfied(need: CapabilityNeed, provider: ProviderDef, model: string): boolean {
  const cap = capabilityFor(provider, model);
  if (!cap) return false;
  return (need.vision === undefined || cap.vision === need.vision)
    && (need.tools === undefined || cap.tools === need.tools)
    && (need.reasoning === undefined || cap.reasoning === need.reasoning)
    && (need.minContext === undefined || cap.contextWindow >= need.minContext);
}
