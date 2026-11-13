export interface ContextItem {
  id: string;
  source: string;
  scope: 'runtime' | 'workspace' | 'run' | 'history';
  trust: 'core' | 'user' | 'reference' | 'untrusted';
  retention: 'required' | 'summarize' | 'ephemeral';
  ref?: string;
  sourceRange?: { from: number; to: number };
  sourceIds?: string[];
}

export class ContextCapacityError extends Error {
  readonly code = 'CONTEXT_CAPACITY';
  constructor(readonly requiredTokens: number, readonly capacity: number) { super(`必需上下文需要 ${requiredTokens} tokens，超过当前可用容量 ${capacity}；请选择更大窗口的模型或缩减任务约束`); }
}
