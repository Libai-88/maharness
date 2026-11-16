export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'blocked' | 'unknown';

export function normalizeFinishReason(reason: unknown): FinishReason {
  if (reason === 'stop' || reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use') return 'tool_calls';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'content_filter' || reason === 'refusal') return 'blocked';
  return 'unknown';
}

export class ModelResponseError extends Error {
  constructor(readonly code: 'REQUEST_TIMEOUT' | 'STREAM_INTERRUPTED' | 'OUTPUT_BLOCKED', message: string) {
    super(message); this.name = 'ModelResponseError';
  }
}
