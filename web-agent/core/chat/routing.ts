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
  candidates: RouteCandidate[];
}

export interface RouteCandidate {
  providerId: string;
  model: string;
  score?: number;
  accepted: boolean;
  reasons: string[];
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
  const selectedModel = model || provider.defaultModel;
  const candidates: RouteCandidate[] = providers.map((p) => ({
    providerId: p.id,
    model: p.id === pid ? selectedModel : p.defaultModel,
    score: p.id === pid ? 0 : 1,
    accepted: p.id === pid,
    reasons: p.id === pid ? [`命中任务类型「${taskType}」的配置`] : ['未命中当前任务类型配置'],
  }));
  return {
    provider,
    model: selectedModel,
    reason: `任务复杂度路由：${taskType} → ${pid}${model ? `@${model}` : ''}`,
    candidates,
  };
}

/** 能力谓词（当前只用到 vision，预留 tools/reasoning/长上下文） */
export interface CapabilityNeed {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  minContext?: number;
  maxLatencyMs?: number;
  privacyTier?: 'local' | 'trusted' | 'external';
  maxRiskLevel?: 'low' | 'medium' | 'high';
}

export interface CapabilityRoute {
  provider: ProviderDef;
  model: string;
  reason: string;
  /** 与请求方模型相同 = 无需切换 */
  same: boolean;
  candidates: RouteCandidate[];
}

/** 显式约束必须由模型画像证据满足；缺少画像时不能推定为合规。 */
export function capabilityRejectionReasons(need: CapabilityNeed, cap: ModelCapability): string[] {
  const reasons: string[] = [];
  if (need.vision !== undefined && cap.vision !== need.vision) reasons.push(need.vision ? '不支持视觉能力' : '不符合视觉能力要求');
  if (need.tools !== undefined && cap.tools !== need.tools) reasons.push(need.tools ? '不支持工具调用' : '不符合工具调用要求');
  if (need.reasoning !== undefined && cap.reasoning !== need.reasoning) reasons.push(need.reasoning ? '不支持推理能力' : '不符合推理能力要求');
  if (need.minContext !== undefined && cap.contextWindow < need.minContext) reasons.push(`上下文窗口 ${cap.contextWindow} 小于要求 ${need.minContext}`);
  if (need.maxLatencyMs !== undefined) {
    if (cap.latencyMs === undefined) reasons.push('未登记延迟画像，无法确认满足延迟上限');
    else if (cap.latencyMs > need.maxLatencyMs) reasons.push(`延迟 ${cap.latencyMs}ms 超过上限 ${need.maxLatencyMs}ms`);
  }
  if (need.privacyTier !== undefined) {
    if (cap.privacyTier === undefined) reasons.push('未登记隐私画像，无法确认符合隐私要求');
    else if (cap.privacyTier !== need.privacyTier) reasons.push(`隐私等级 ${cap.privacyTier} 不符合要求 ${need.privacyTier}`);
  }
  if (need.maxRiskLevel !== undefined) {
    if (cap.riskLevel === undefined) reasons.push('未登记风险画像，无法确认符合风险上限');
    else if (['low', 'medium', 'high'].indexOf(cap.riskLevel) < 0) reasons.push(`风险等级 ${cap.riskLevel} 无法识别`);
    else if (['low', 'medium', 'high'].indexOf(cap.riskLevel) > ['low', 'medium', 'high'].indexOf(need.maxRiskLevel)) {
      reasons.push(`风险等级 ${cap.riskLevel} 超过上限 ${need.maxRiskLevel}`);
    }
  }
  return reasons.length ? ['不满足至少一项能力要求', ...reasons] : reasons;
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
  const satisfies = (cap: ModelCapability): boolean => capabilityRejectionReasons(need, cap).length === 0;

  const candidates: { provider: ProviderDef; cap: ModelCapability; score: number; reasons: string[] }[] = [];
  const rejected: RouteCandidate[] = [];
  for (const p of providers) {
    for (const m of p.models ?? []) {
      if (!m.enabled) {
        rejected.push({ providerId: p.id, model: m.modelId, accepted: false, reasons: ['模型已禁用'] });
      } else if (m.modelId === current.model) {
        rejected.push({ providerId: p.id, model: m.modelId, accepted: false, reasons: ['当前模型无需切换'] });
      } else if (satisfies(m)) {
        candidates.push({ provider: p, cap: m, score: 0, reasons: ['满足全部能力要求'] });
      } else {
        rejected.push({ providerId: p.id, model: m.modelId, accepted: false, reasons: capabilityRejectionReasons(need, m) });
      }
    }
    // 未登记模型：默认模型按目录推断兜底
    if (!(p.models ?? []).some(m => m.modelId === p.defaultModel) && p.defaultModel && p.defaultModel !== current.model) {
      const cap = capabilityFor(p, p.defaultModel);
      if (cap && satisfies(cap)) candidates.push({ provider: p, cap, score: 0, reasons: ['未登记模型按目录推断且满足能力要求'] });
    }
  }
  if (!candidates.length) return undefined;
  const rank = (c: { provider: ProviderDef; cap: ModelCapability }): number => {
    const sameProvider = c.provider.id === current.providerId ? 0 : 1;
    const price = c.cap.priceIn + c.cap.priceOut;
    const latency = c.cap.latencyMs ?? 1000;
    const privacyPenalty = need.privacyTier && c.cap.privacyTier && need.privacyTier !== c.cap.privacyTier ? 100_000 : 0;
    const riskPenalty = need.maxRiskLevel && c.cap.riskLevel && c.cap.riskLevel !== need.maxRiskLevel ? 10_000 : 0;
    return sameProvider * 1e6 + privacyPenalty + riskPenalty
      + (need.minContext ? Math.max(0, need.minContext - c.cap.contextWindow) : 0)
      + latency * 0.01 + price;
  };
  for (const candidate of candidates) candidate.score = rank(candidate);
  const best = candidates.sort((a, b) => a.score - b.score)[0];
  return {
    provider: best.provider,
    model: best.cap.modelId,
    same: false,
    reason: `能力路由：${need.vision ? '需要视觉' : ''}${need.tools ? ' 需要工具' : ''}${need.reasoning ? ' 需要推理' : ''} → ${best.provider.id}@${best.cap.modelId}`,
    candidates: [...rejected, ...candidates.map((c) => ({
      providerId: c.provider.id,
      model: c.cap.modelId,
      score: c.score,
      accepted: c === best,
      reasons: c === best ? [...c.reasons, `延迟≈${c.cap.latencyMs ?? '未知'}ms`, `隐私=${c.cap.privacyTier ?? '未知'}`, `风险=${c.cap.riskLevel ?? '未知'}`]
        : [...c.reasons, '评分低于已选候选'],
    }))],
  };
}

/** 当前模型是否已满足需求（满足则不路由） */
export function capabilitySatisfied(need: CapabilityNeed, provider: ProviderDef, model: string): boolean {
  const cap = capabilityFor(provider, model);
  if (!cap) return false;
  return capabilityRejectionReasons(need, cap).length === 0;
}
