import type { ToolDef } from './types';

/** 只读/无副作用工具不进入恢复账本：恢复时应重新观察，不能复用旧文件/网页结果。 */
export function shouldJournalToolEffect(tool: Pick<ToolDef, 'sideEffect'>): boolean {
  return tool.sideEffect !== 'none' && tool.sideEffect !== 'read';
}

/** 给 LLM 与审计面展示的副作用标签；未声明按 external 处理，保持恢复账本保守行为。 */
export function toolSideEffectLabel(tool: Pick<ToolDef, 'sideEffect'>): 'none' | 'read' | 'write' | 'external' | 'irreversible' {
  return tool.sideEffect ?? 'external';
}
