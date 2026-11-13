import { createHash } from 'node:crypto';
import { countMessageTokens, estimateTokens, type TokenizerAdapter } from './tokens';
import type { LLMMessage } from './types';

export interface InputDiagnostics {
  messageTokens: number;
  toolTokens: number;
  sources: { source: string; tokens: number }[];
  fingerprint: string;
  attemptId?: string;
  resumedFromTurn?: number;
}

export function describeModelInput(messages: LLMMessage[], tools: unknown[], tokenizer?: TokenizerAdapter): InputDiagnostics {
  const sources = new Map<string, number>();
  for (const message of messages) {
    const source = message.context?.source ?? (message.role === 'tool' ? 'tool-observation' : 'history');
    sources.set(source, (sources.get(source) ?? 0) + countMessageTokens([message], tokenizer));
  }
  return {
    messageTokens: countMessageTokens(messages, tokenizer), toolTokens: estimateTokens(JSON.stringify(tools)),
    sources: [...sources].map(([source, tokens]) => ({ source, tokens })),
    fingerprint: createHash('sha256').update(JSON.stringify({ messages, tools })).digest('hex'),
  };
}
