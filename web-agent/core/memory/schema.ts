export type MemorySource = 'user' | 'agent' | 'tool' | 'import' | 'system';

export interface MemoryFact {
  id: string;
  text: string;
  ts: number;
  source: MemorySource;
  confidence: number;
  expiresAt?: number;
  revokedAt?: number;
  conflictsWith: string[];
}

export interface MemoryFactInput {
  source?: MemorySource;
  confidence?: number;
  expiresAt?: number;
  conflictsWith?: string[];
}

export function normalizeFact(raw: Partial<MemoryFact> & { id: string; text: string; ts: number }): MemoryFact {
  const confidence = Number(raw.confidence);
  return {
    id: raw.id,
    text: raw.text,
    ts: raw.ts,
    source: raw.source ?? 'agent',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.8,
    ...(Number.isFinite(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}),
    ...(Number.isFinite(raw.revokedAt) ? { revokedAt: raw.revokedAt } : {}),
    conflictsWith: Array.isArray(raw.conflictsWith) ? raw.conflictsWith.filter((id): id is string => typeof id === 'string') : [],
  };
}

export function isFactActive(fact: MemoryFact, now = Date.now()): boolean {
  return fact.revokedAt === undefined && (fact.expiresAt === undefined || fact.expiresAt > now);
}

export function buildFact(id: string, text: string, now: number, input: MemoryFactInput = {}): MemoryFact {
  return normalizeFact({ id, text, ts: now, source: input.source ?? 'agent', confidence: input.confidence ?? 0.8, expiresAt: input.expiresAt, conflictsWith: input.conflictsWith ?? [] });
}
