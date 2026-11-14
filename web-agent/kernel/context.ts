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

/** Message provenance is assigned at ingress, never inferred from its text. */
export function isUserMessage(message: import('./types').LLMMessage): boolean {
  return message.role === 'user' && !!message.content && (!message.context || message.context.trust === 'user' && ['user', 'user-supplement'].includes(message.context.source));
}

/** Called only by the schema migration for records without structured provenance. */
export function importLegacyContext(messages: import('./types').LLMMessage[]): import('./types').LLMMessage[] {
  return messages.map((message, index) => {
    if (message.context) return message;
    const protectedLegacy = /^(【任务约束】|【验收条件】|【核心记忆块】|【长期记忆】|【失败教训】)/.test(message.content ?? '');
    const summary = (message.content ?? '').startsWith('【历史摘要】');
    return { ...message, context: { id: `legacy:${index}`, source: summary ? 'history-summary' : 'legacy-unclassified', scope: 'history', trust: 'reference', retention: protectedLegacy ? 'required' : 'summarize' } };
  });
}
