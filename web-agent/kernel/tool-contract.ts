import type { ToolDef, ToolSideEffect } from './types';

/** Resolve the call-specific side effect; classifier failures stay on the conservative static contract. */
export function effectiveToolSideEffect(tool: Pick<ToolDef, 'sideEffect' | 'classifySideEffect'>, args?: unknown): ToolSideEffect {
  if (!tool.classifySideEffect) return tool.sideEffect ?? 'external';
  try {
    return tool.classifySideEffect(args) ?? tool.sideEffect ?? 'external';
  } catch {
    return tool.sideEffect ?? 'external';
  }
}

/** 只读/无副作用工具不进入恢复账本：恢复时应重新观察，不能复用旧文件/网页结果。 */
export function shouldJournalToolEffect(tool: Pick<ToolDef, 'sideEffect' | 'classifySideEffect'>, args?: unknown): boolean {
  const sideEffect = effectiveToolSideEffect(tool, args);
  return sideEffect !== 'none' && sideEffect !== 'read';
}

/** 给 LLM 与审计面展示的副作用标签；未声明按 external 处理，保持恢复账本保守行为。 */
export function toolSideEffectLabel(tool: Pick<ToolDef, 'sideEffect' | 'classifySideEffect'>, args?: unknown): ToolSideEffect {
  return effectiveToolSideEffect(tool, args);
}
