import { createHash } from 'node:crypto';
import { redactTraceValue } from '../../../kernel/content-safety';
import { RUN_TERMINAL, type RunRecord } from '../../../kernel/run';
import { estimateTokens } from '../../../kernel/tokens';
import type { ProviderDef } from '../../../kernel/types';
import type { FindingSeverity } from '../../experience-store';
import { ExperienceError } from '../../experience-error';

/** Small shared helpers for the experience review engine. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function uniqueStrings(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))].slice(0, limit);
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function terminal(run: RunRecord): boolean {
  return RUN_TERMINAL.has(run.status);
}

export function verificationStatus(value: unknown): string | undefined {
  return isRecord(value) && typeof value.status === 'string' ? value.status : undefined;
}

export function jsonText(value: unknown): string {
  try {
    // JSON.stringify(undefined) returns undefined (not a string); callers use
    // .length on the result, so normalise it instead of throwing.
    return JSON.stringify(redactTraceValue(value), null, 2) ?? 'null';
  } catch { return String(value); }
}

export function trimToTokens(text: string, limit: number, tokenizer?: ProviderDef['tokenizer']): string {
  const count = (value: string) => tokenizer?.countText ? tokenizer.countText(value) : estimateTokens(value);
  if (count(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}\n[TRUNCATED]`;
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripCodeFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '复盘模型未返回 JSON 对象');
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '复盘模型返回的 JSON 无法解析');
  }
}

export function severityRank(value: FindingSeverity): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 } as const)[value];
}

