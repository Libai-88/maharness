import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ChatOptions, LLMChunk, LLMMessage, ProviderDef } from './types';
import { countMessageTokens, deterministicInputTokenUpperBound, estimateTokens } from './tokens';
import { ModelResponseError, type FinishReason } from './model-response';

export type ModelPurpose = 'agent' | 'compaction' | 'vision' | 'mcp_sampling' | 'embedding' | 'connection_check' | 'experience_review' | 'experience_audit';
export interface ModelCallRecord {
  id: string; rootId?: string; runId?: string; parentRunId?: string; scope: 'run' | 'maintenance';
  turn?: number; purpose: ModelPurpose; providerId: string; model: string; actualModel?: string;
  startedAt: number; finishedAt?: number; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  inputEstimate: number; outputLimit: number; input?: number; output?: number;
  inputUpperBound?: number; inputUpperBoundSource?: 'provider' | 'conservative';
  contextWindow?: number;
  reservedTokens?: number;
  usageStatus: 'reported' | 'estimated' | 'unknown'; cost?: number; reservedCost?: number;
  cachedInput?: number; missInput?: number; cacheWriteTokens?: number; cachePrefixHash?: string;
  priceSource: 'configured' | 'catalog' | 'unknown'; priceIn?: number; priceOut?: number;
  error?: string; errorCode?: string; finishReason?: FinishReason; rawFinishReason?: string;
}
export interface ModelCallScope {
  turn?: number; runId: string; rootId?: string; parentRunId?: string; signal: AbortSignal;
  cachePrefixHash?: string;
  acquire(signal?: AbortSignal): Promise<() => void>;
  start(record: ModelCallRecord): void;
  finish(record: ModelCallRecord): void;
  input?(record: ModelCallRecord, messages: LLMMessage[], tools: ChatOptions['tools'], tokenizer?: ProviderDef['tokenizer']): void;
  /** Admission and reservation happen atomically before a network request. */
  admit?(record: ModelCallRecord): void;
}
const scopes = new AsyncLocalStorage<ModelCallScope>();
let maintenanceScope: ModelCallScope | undefined;
export function setMaintenanceModelScope(scope: ModelCallScope): () => void {
  maintenanceScope = scope;
  return () => { if (maintenanceScope === scope) maintenanceScope = undefined; };
}
export const withModelScope = <T>(scope: ModelCallScope, work: () => T): T => scopes.run(scope, work);
export const setModelCallTurn = (turn: number): void => { const scope = scopes.getStore(); if (scope) scope.turn = turn; };
export const currentModelScope = () => scopes.getStore();

export async function* inModelScope<T>(stream: AsyncIterable<T>, scope: ModelCallScope): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await scopes.run(scope, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally { await scopes.run(scope, async () => { await iterator.return?.(); }); }
}

export class ModelAdmissionError extends Error {
  readonly code = 'MODEL_BUDGET_UNCERTAIN';
}

/** The only production boundary allowed to invoke a provider adapter. */
export async function* callModel(provider: ProviderDef, messages: LLMMessage[], options: ChatOptions, purpose: ModelPurpose = 'agent'): AsyncGenerator<LLMChunk> {
  const scope = scopes.getStore() ?? maintenanceScope;
  const signal = scope ? options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal : options.signal;
  signal?.throwIfAborted();
  const modelPrice = provider.models?.find(model => model.modelId === options.model);
  const contextWindow = modelPrice && Number.isSafeInteger(modelPrice.contextWindow) && modelPrice.contextWindow > 0
    ? modelPrice.contextWindow
    : undefined;
  const candidatePrice = provider.priceSource === 'unknown' ? undefined : modelPrice && modelPrice.source !== 'inferred' ? { in: modelPrice.priceIn, out: modelPrice.priceOut } : options.model === provider.defaultModel ? provider.prices : undefined;
  const price = candidatePrice && Number.isFinite(candidatePrice.in) && candidatePrice.in >= 0 && Number.isFinite(candidatePrice.out) && candidatePrice.out >= 0 ? candidatePrice : undefined;
  const outputLimit = options.maxTokens ?? 4096;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) throw new ModelAdmissionError('无效的模型输出上限');
  const record: ModelCallRecord = {
    id: randomUUID(), rootId: scope?.rootId, runId: scope?.runId || undefined, parentRunId: scope?.parentRunId, scope: scope?.runId ? 'run' : 'maintenance', turn: scope?.turn, purpose,
    providerId: provider.id, model: options.model, startedAt: Date.now(), status: 'running',
    inputEstimate: countMessageTokens(messages, provider.tokenizer) + estimateTokens(JSON.stringify(options.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) ?? [])),
    outputLimit, usageStatus: 'unknown', priceSource: price ? provider.priceSource ?? 'configured' : 'unknown',
    priceIn: price?.in, priceOut: price?.out,
    ...(contextWindow ? { contextWindow } : {}),
    ...(scope?.cachePrefixHash ? { cachePrefixHash: scope.cachePrefixHash } : {}),
  };
  const certifiedBound = provider.inputTokenUpperBound?.(messages, options);
  const certified = certifiedBound !== undefined && Number.isSafeInteger(certifiedBound) && certifiedBound >= 0;
  const inputUpperBound = certified ? certifiedBound! : deterministicInputTokenUpperBound(messages, options.tools ?? [], options.responseFormat);
  record.inputUpperBound = inputUpperBound;
  record.inputUpperBoundSource = certified ? 'provider' : 'conservative';
  record.reservedTokens = inputUpperBound <= Number.MAX_SAFE_INTEGER - outputLimit
    ? inputUpperBound + outputLimit
    : Number.MAX_SAFE_INTEGER;
  if (price && provider.outputLimitGuaranteed) {
    const reserved = (inputUpperBound * price.in + outputLimit * price.out) / 1e6;
    if (Number.isFinite(reserved) && reserved >= 0) record.reservedCost = reserved;
  }
  let release: (() => void) | undefined;
  let started = false;
  try {
    release = await scope?.acquire(signal);
    signal?.throwIfAborted();
    scope?.admit?.(record);
    scope?.start(record); started = true;
    scope?.input?.(record, messages, options.tools, provider.tokenizer);
    const calls: Extract<LLMChunk, { type: 'tool_call' }>[] = [];
    let ending: Extract<LLMChunk, { type: 'done' }> | undefined;
    for await (const chunk of provider.chat(messages, { ...options, maxTokens: outputLimit, signal })) {
      if (chunk.type === 'usage') {
        const validInput = Number.isSafeInteger(chunk.input) && chunk.input >= 0;
        const validOutput = Number.isSafeInteger(chunk.output) && chunk.output >= 0;
        record.input = validInput ? chunk.input : undefined; record.output = validOutput ? chunk.output : undefined;
        record.cachedInput = validInput && chunk.cachedInput !== undefined && Number.isSafeInteger(chunk.cachedInput) && chunk.cachedInput >= 0 && chunk.cachedInput <= chunk.input
          ? chunk.cachedInput : undefined;
        record.missInput = validInput && chunk.missInput !== undefined && Number.isSafeInteger(chunk.missInput) && chunk.missInput >= 0 && chunk.missInput <= chunk.input
          ? chunk.missInput : undefined;
        record.cacheWriteTokens = chunk.cacheWrite !== undefined && Number.isSafeInteger(chunk.cacheWrite) && chunk.cacheWrite >= 0
          ? chunk.cacheWrite : undefined;
        record.usageStatus = chunk.incomplete || !validInput || !validOutput ? 'unknown' : chunk.estimated ? 'estimated' : 'reported';
      }
      if (chunk.type === 'model') record.actualModel = chunk.model;
      if (chunk.type === 'tool_call') { calls.push(chunk); continue; }
      if (chunk.type === 'done') { ending = chunk; record.finishReason = chunk.reason; record.rawFinishReason = chunk.rawReason; continue; }
      yield chunk;
    }
    signal?.throwIfAborted();
    ending ??= { type: 'done', reason: 'unknown' };
    if (ending.reason === 'blocked') throw new ModelResponseError('OUTPUT_BLOCKED', '模型输出被上游内容策略阻断');
    if (ending.reason === 'length') record.errorCode = 'OUTPUT_TRUNCATED';
    if (ending.reason !== 'length') for (const call of calls) yield call;
    yield { ...ending, ...(ending.reason === 'length' ? { toolCallsTruncated: calls.length > 0 } : {}) };
    record.status = 'completed';
  } catch (error) {
    record.status = signal?.aborted ? 'cancelled' : 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    record.errorCode = (error as { code?: string })?.code;
    throw error;
  } finally {
    release?.();
    if (started) {
      if (record.status === 'running') record.status = 'unknown';
      record.finishedAt = Date.now();
      if (price && record.input !== undefined && record.output !== undefined && record.usageStatus !== 'unknown') {
        const cost = (record.input * price.in + record.output * price.out) / 1e6;
        if (Number.isFinite(cost)) record.cost = cost;
      }
      scope?.finish(record);
    }
  }
}

export async function callEmbedding(model: string, text: string, request: (signal?: AbortSignal) => Promise<number[]>): Promise<number[]> {
  let vector: number[] = [];
  const adapter: ProviderDef = {
    id: 'embedding', label: 'Embedding', defaultModel: model, priceSource: 'unknown',
    async *chat(_messages, options) {
      vector = await request(options.signal);
      yield { type: 'done' };
    },
  };
  for await (const _chunk of callModel(adapter, [{ role: 'user', content: text }], { model, maxTokens: 0 }, 'embedding')) { /* consume the bounded auxiliary request */ }
  return vector;
}

/** Non-streaming protocol probes retain their SSRF-safe transport and response. */
export async function observeModelRequest<T>(providerId: string, model: string, maxTokens: number, request: (signal?: AbortSignal) => Promise<{ value: T; input?: number; output?: number; actualModel?: string }>): Promise<T> {
  let value!: T;
  const adapter: ProviderDef = {
    id: providerId, label: providerId, defaultModel: model, priceSource: 'unknown',
    async *chat(_messages, options) {
      const result = await request(options.signal); value = result.value;
      if (result.actualModel) yield { type: 'model', model: result.actualModel };
      if (result.input !== undefined && result.output !== undefined) yield { type: 'usage', input: result.input, output: result.output };
      yield { type: 'done' };
    },
  };
  for await (const _chunk of callModel(adapter, [{ role: 'user', content: 'Provider connection / tool capability probe' }], { model, maxTokens }, 'connection_check')) { /* consume the explicit maintenance call */ }
  return value;
}
