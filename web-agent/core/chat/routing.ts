/**
 * core/chat/routing.ts —— 任务复杂度模型路由（2026 实践：FrugalGPT / RouteLLM）
 * 简单任务走便宜模型、复杂任务走强模型——harness 管理认知资源，而不是让 LLM 自觉。
 * maharness 版：复用 kernel/budget.ts 的 classifyTask（与任务画像同源），
 * 按任务类型把整次 run 路由到配置指定的 provider/model；未命中配置则用默认模型。
 */
import { classifyTask } from '../../kernel/budget';
import type { ProviderDef } from '../../kernel/types';

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
