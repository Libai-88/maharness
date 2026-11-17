import { createHash, randomUUID } from 'node:crypto';
import { redactTraceValue } from '../core/chat/agent';
import { callModel } from '../kernel/model-call';
import type { LLMMessage, ProviderDef } from '../kernel/types';
import { RUN_TERMINAL, type RunRecord } from '../kernel/run';
import { countMessageTokens, estimateTokens } from '../kernel/tokens';
import type { Store } from './db';
import { OrganizationService } from './organization';
import type { EvaluationVersion } from './organization-store';
import {
  REVIEW_DIMENSIONS,
  REVIEW_RUBRIC_VERSION,
  REVIEW_SYSTEM_PROMPT,
} from './review-rubric';
import {
  type AIUserReview,
  type AIUserReviewEstimate,
  type AIUserReviewRequest,
  type AIUserReviewSummary,
  type EvidenceRequest,
  type EvidenceSlice,
  type ExperienceFinding,
  type ExperienceRegressionCase,
  type FactAnomaly,
  type FactLedger,
  type FactRun,
  type FindingSeverity,
  type FindingStatus,
  type ReviewAudit,
  type ReviewBudget,
  type ReviewDimensionScore,
  type ReviewEvidenceRef,
  type ReviewObservation,
  type ReviewPath,
  type ReviewSuggestion,
} from './experience-store';

const FAST_INPUT_LIMIT = 3_000;
const FAST_OUTPUT_LIMIT = 800;
const FAST_TOTAL_LIMIT = 3_800;
const FOCUSED_INPUT_LIMIT = 8_000;
const FOCUSED_OUTPUT_LIMIT = 1_200;
const FOCUSED_TOTAL_LIMIT = 9_200;
const MULTI_INPUT_LIMIT = 10_000;
const MULTI_OUTPUT_LIMIT = 1_500;
const MULTI_TOTAL_LIMIT = 11_500;
const FACT_LEDGER_TOKEN_LIMIT = 1_200;
const EVIDENCE_SLICE_TOKEN_LIMIT = 600;

const SUGGESTION_CATEGORIES = new Set<ReviewSuggestion['category']>([
  'capability', 'tool-contract', 'result-feedback', 'state', 'recovery',
  'context', 'authorization', 'performance', 'artifact', 'organization',
]);

const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  new: ['triaged', 'wont_fix'],
  triaged: ['reproduced', 'fixing', 'wont_fix'],
  reproduced: ['fixing', 'wont_fix'],
  fixing: ['verifying', 'wont_fix'],
  verifying: ['closed', 'reopened', 'wont_fix'],
  closed: ['reopened'],
  wont_fix: ['reopened'],
  reopened: ['triaged', 'fixing', 'wont_fix'],
};

export class ExperienceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExperienceError';
  }
}

export interface ExperienceDeps {
  store: Store;
  providers: () => ProviderDef[];
  emit: (type: string, data: Record<string, unknown>, traceId?: string) => void;
  now?: () => number;
}

interface ResolvedSelection {
  provider: ProviderDef;
  model: string;
  originalProviderId: string;
  originalModel: string;
  crossModel: boolean;
  scope: 'run' | 'multi_run';
  runs: RunRecord[];
  facts: FactLedger;
  path: ReviewPath;
  evaluation: EvaluationVersion;
  budget: Pick<ReviewBudget, 'inputTokenLimit' | 'outputTokenLimit' | 'totalTokenLimit'>;
}

interface InvocationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: ReviewBudget['costSource'];
}

interface StructuredReview {
  dimensions: ReviewDimensionScore[];
  observations: ReviewObservation[];
  suggestions: ReviewSuggestion[];
  reuseIntent: 1 | 2 | 3 | 4 | 5 | null;
  confidence: number;
  evidenceGaps: string[];
}

type EvidencePlan = EvidenceRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))].slice(0, limit);
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface ReviewRubric {
  version: string;
  dimensions: string[];
  systemPrompt: string;
  hash: string;
}

function rubricFromPolicy(policy?: EvaluationVersion['record']): ReviewRubric {
  const version = policy?.review.rubricVersion ?? REVIEW_RUBRIC_VERSION;
  const dimensions = policy?.review.dimensions?.length
    ? [...policy.review.dimensions]
    : [...REVIEW_DIMENSIONS];
  const systemPrompt = policy?.review.systemPrompt ?? REVIEW_SYSTEM_PROMPT;
  return {
    version,
    dimensions,
    systemPrompt,
    hash: stableHash({ version, dimensions, systemPrompt }),
  };
}

function severityRank(value: FindingSeverity): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 } as const)[value];
}

function terminal(run: RunRecord): boolean {
  return RUN_TERMINAL.has(run.status);
}

function verificationStatus(value: unknown): string | undefined {
  return isRecord(value) && typeof value.status === 'string' ? value.status : undefined;
}

function jsonText(value: unknown): string {
  try { return JSON.stringify(redactTraceValue(value), null, 2); }
  catch { return String(value); }
}

function trimToTokens(text: string, limit: number, tokenizer?: ProviderDef['tokenizer']): string {
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

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> {
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

function modelPrice(provider: ProviderDef, model: string): { input: number; output: number; source: ReviewBudget['costSource'] } | undefined {
  const capability = provider.models?.find(item => item.modelId === model);
  const candidate = provider.priceSource !== 'unknown' && capability?.source !== 'inferred'
    ? { input: capability?.priceIn, output: capability?.priceOut }
    : model === provider.defaultModel && provider.prices
      ? { input: provider.prices.in, output: provider.prices.out }
      : undefined;
  if (!candidate || !Number.isFinite(candidate.input) || !Number.isFinite(candidate.output)
    || (candidate.input ?? -1) < 0 || (candidate.output ?? -1) < 0) return undefined;
  const input = candidate.input!;
  const output = candidate.output!;
  const source: ReviewBudget['costSource'] = input === 0 && output === 0
    ? 'free'
    : provider.priceSource === 'unknown' ? 'unknown'
      : capability?.source === 'manual' || provider.priceSource === 'configured' ? 'configured' : 'catalog';
  return { input, output, source };
}

function estimateCost(provider: ProviderDef, model: string, inputTokens: number, outputTokens: number): { costUsd: number | null; costSource: ReviewBudget['costSource'] } {
  const price = modelPrice(provider, model);
  return price
    ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1e6, costSource: price.source }
    : { costUsd: null, costSource: 'unknown' };
}

function providerFor(providers: ProviderDef[], providerId: string, model: string): ProviderDef | undefined {
  const provider = providers.find(item => item.id === providerId);
  if (!provider) return undefined;
  if (model === provider.defaultModel) return provider;
  return provider.models?.some(item => item.modelId === model && item.enabled) ? provider : undefined;
}

function aggregateAnomaly(map: Map<string, FactAnomaly>, anomaly: Omit<FactAnomaly, 'evidenceRefs' | 'occurrences'> & { evidenceRefs: string[] }): void {
  const key = `${anomaly.severity}:${anomaly.code}:${anomaly.summary}`;
  const current = map.get(key);
  if (current) {
    current.evidenceRefs = [...new Set([...current.evidenceRefs, ...anomaly.evidenceRefs])].slice(0, 12);
    current.occurrences++;
    return;
  }
  map.set(key, { ...anomaly, evidenceRefs: [...new Set(anomaly.evidenceRefs)].slice(0, 12), occurrences: 1 });
}

function loadFactSources(store: Store, runs: RunRecord[]) {
  return runs.map(run => ({
    run,
    events: store.runs.events(run.id),
    calls: store.runs.toolCalls(run.id),
    modelCalls: store.runs.modelCalls(run.id, 0, 100),
    artifacts: store.runs.artifacts(run.id),
  }));
}

export function buildFactLedger(store: Store, tenantId: string, runs: RunRecord[], now = Date.now()): FactLedger {
  return buildFactLedgerFromSources(
    store,
    tenantId,
    loadFactSources(store, runs),
    now,
    REVIEW_RUBRIC_VERSION,
  );
}

function buildFactLedgerFromSources(
  store: Store,
  tenantId: string,
  sources: ReturnType<typeof loadFactSources>,
  now: number,
  rubricVersion: string,
): FactLedger {
  const anomalies = new Map<string, FactAnomaly>();
  const facts: FactRun[] = [];
  let allTerminal = true;
  let toolTotal = 0;
  let failedTotal = 0;
  let duplicateTotal = 0;
  let recoveryTotal = 0;
  let approvalTotal = 0;
  let artifactTotal = 0;
  let invalidArtifactTotal = 0;
  let modelCallTotal = 0;

  for (const { run, events, calls, modelCalls, artifacts } of sources) {
    if (!terminal(run)) allTerminal = false;
    const seen = new Set<string>();
    let duplicateTools = 0;
    let failedTools = 0;
    let modelInputTokens = 0;
    let modelOutputTokens = 0;
    let modelCostUsd = 0;
    let modelFailures = 0;
    const modelPurposes = new Set<string>();
    const toolVersions = new Set<string>();
    let invalidArtifacts = 0;
    let recoveries = 0;
    let approvalWaits = 0;

    const toolRef = (id: string) => `run:${run.id}:tool:${id}`;
    const eventRef = (seq: number) => `run:${run.id}:event:${seq}`;
    const artifactRef = (id: string) => `run:${run.id}:artifact:${id}`;
    for (const call of calls) {
      if (call.version) toolVersions.add(call.version);
      const key = `${call.name}\u0000${call.argsSummary}`;
      if (seen.has(key)) {
        duplicateTools++;
        aggregateAnomaly(anomalies, {
          code: 'DUPLICATE_TOOL_CALL', severity: 'P2',
          summary: `${call.name} 使用了重复参数签名`, evidenceRefs: [toolRef(call.id)],
        });
      } else seen.add(key);
      if (call.status === 'failed' || call.status === 'unknown') {
        failedTools++;
        const code = call.failure?.code ?? call.status.toUpperCase();
        const ref = toolRef(call.id);
        if (call.sideEffectOutcome === 'unknown' || call.failure?.outcome === 'unknown') {
          aggregateAnomaly(anomalies, { code: 'UNKNOWN_SIDE_EFFECT', severity: 'P0', summary: `${call.name} 的副作用结果未知`, evidenceRefs: [ref] });
        }
        if (call.failure?.outcome === 'applied' && /AUTH|FORBID|DENIED|NOT_ALLOWED/i.test(code)) {
          aggregateAnomaly(anomalies, { code: 'UNAUTHORIZED_SIDE_EFFECT', severity: 'P0', summary: `${call.name} 未获授权却已产生副作用`, evidenceRefs: [ref] });
        }
        if (/ARG|INVALID|SCHEMA|UNKNOWN_TOOL/i.test(code)) {
          aggregateAnomaly(anomalies, { code: 'INVALID_TOOL_CONTRACT', severity: 'P2', summary: `${call.name} 暴露工具契约或参数问题`, evidenceRefs: [ref] });
        }
        aggregateAnomaly(anomalies, { code: 'TOOL_FAILURE', severity: code.startsWith('P') ? 'P1' : 'P2', summary: `${call.name} 失败：${code}`, evidenceRefs: [ref] });
      }
    }
    for (const call of modelCalls) {
      modelInputTokens += call.input ?? 0;
      modelOutputTokens += call.output ?? 0;
      modelCostUsd += call.cost ?? 0;
      if (call.status !== 'completed') modelFailures++;
      modelPurposes.add(call.purpose);
    }
    for (const event of events) {
      if (event.type === 'approval_required' || event.type === 'state' && event.data.status === 'waiting_approval') approvalWaits++;
      if (event.type === 'tool_recovered') recoveries++;
      const failureEvent = /error|failed|partial/i.test(event.type);
      const checkpointEvent = /CONTEXT|CHECKPOINT|RESUME|HISTORY/i.test(event.type);
      if (failureEvent || checkpointEvent || event.type === 'task_failed' || event.type === 'task_partial') {
        const detail = jsonText(event.data);
        if (checkpointEvent || /CONTEXT|CHECKPOINT|RESUME|HISTORY/i.test(detail)) {
          aggregateAnomaly(anomalies, { code: 'CONTEXT_LOSS', severity: 'P1', summary: `${event.type} 显示上下文或断点连续性异常`, evidenceRefs: [eventRef(event.seq)] });
        }
      }
      if (event.type === 'artifact_invalid') {
        invalidArtifacts++;
        aggregateAnomaly(anomalies, { code: 'ARTIFACT_INVALID', severity: 'P1', summary: '产物重新解析失败', evidenceRefs: [eventRef(event.seq)] });
      }
    }
    for (const artifact of artifacts) {
      if (!artifact.ref || !artifact.kind || !artifact.label) {
        invalidArtifacts++;
        aggregateAnomaly(anomalies, { code: 'ARTIFACT_INVALID', severity: 'P1', summary: '产物登记缺少必要引用或格式信息', evidenceRefs: [artifactRef(artifact.id)] });
      }
    }
    const verification = verificationStatus(run.verification);
    if (run.status === 'completed' && (verification === 'failed' || verification === 'partial' || run.error || run.problem)) {
      aggregateAnomaly(anomalies, {
        code: 'FALSE_SUCCESS', severity: 'P0', summary: `任务标记完成但验收为 ${verification ?? run.problem?.code ?? '异常'}`,
        evidenceRefs: [`run:${run.id}:verification`],
      });
    }
    const conflicts = run.capabilityResolution?.conflicts.length ?? 0;
    const contract = store.organization.contractsForRun(run.id, tenantId)[0];
    const workOrder = store.organization.workOrderByRun(run.rootId, tenantId);
    const durationMs = Math.max(0, run.updatedAt - run.createdAt);
    toolTotal += calls.length;
    failedTotal += failedTools;
    duplicateTotal += duplicateTools;
    recoveryTotal += recoveries;
    approvalTotal += approvalWaits;
    artifactTotal += artifacts.length;
    invalidArtifactTotal += invalidArtifacts;
    modelCallTotal += modelCalls.length;
    facts.push({
      id: run.id,
      status: run.status,
      goal: trimToTokens(run.objective, 120),
      verified: verification ? verification === 'passed' || verification === 'done' : null,
      durationMs,
      modelCalls: modelCalls.length,
      modelInputTokens,
      modelOutputTokens,
      modelCostUsd: Math.round(modelCostUsd * 1e6) / 1e6,
      modelFailures,
      modelPurposes: [...modelPurposes].slice(0, 4),
      toolCalls: calls.length,
      failedTools,
      duplicateTools,
      toolVersions: [...toolVersions].slice(0, 4),
      recoveries,
      approvalWaits,
      artifacts: artifacts.length,
      invalidArtifacts,
      capabilities: (run.capabilityResolution?.selected ?? []).slice(0, 16),
      conflicts,
      ...(workOrder ? {
        team: {
          workOrderId: workOrder.id,
          ...(run.teamCycleId ? { teamCycleId: run.teamCycleId } : {}),
          ...(run.organizationRoleId ? { roleId: run.organizationRoleId } : {}),
          ...(contract ? { contractId: contract.id, contractStatus: contract.status } : {}),
          expectedArtifacts: (contract?.expectedArtifacts ?? []).slice(0, 6),
          unfinished: (contract?.delivery?.unfinished ?? []).slice(0, 6),
          evidenceRefs: (contract?.delivery?.evidence ?? contract?.evidenceInputs ?? []).map(item => item.id).slice(0, 8),
          ...(run.cachePrefixHash ? { cachePrefixHash: run.cachePrefixHash.slice(0, 24) } : {}),
          ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
        },
      } : {}),
    });
  }

  const sortedAnomalies = [...anomalies.values()]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code));
  const ledger: FactLedger = {
    schemaVersion: 1,
    rubricVersion,
    tenantId,
    providerId: sources[0]?.run.providerId ?? '',
    model: sources[0]?.run.model ?? '',
    runIds: sources.map(source => source.run.id),
    generatedAt: now,
    runs: facts,
    totals: {
      durationMs: facts.reduce((sum, run) => sum + run.durationMs, 0),
      modelCalls: modelCallTotal,
      modelInputTokens: facts.reduce((sum, run) => sum + run.modelInputTokens, 0),
      modelOutputTokens: facts.reduce((sum, run) => sum + run.modelOutputTokens, 0),
      modelCostUsd: Math.round(facts.reduce((sum, run) => sum + run.modelCostUsd, 0) * 1e6) / 1e6,
      modelFailures: facts.reduce((sum, run) => sum + run.modelFailures, 0),
      toolCalls: toolTotal,
      failedTools: failedTotal,
      duplicateTools: duplicateTotal,
      recoveries: recoveryTotal,
      approvalWaits: approvalTotal,
      artifacts: artifactTotal,
      invalidArtifacts: invalidArtifactTotal,
    },
    gates: {
      allTerminal,
      noFalseSuccess: !sortedAnomalies.some(anomaly => anomaly.code === 'FALSE_SUCCESS'),
      noUnknownSideEffects: !sortedAnomalies.some(anomaly => anomaly.code === 'UNKNOWN_SIDE_EFFECT'),
      noUnauthorizedSideEffects: !sortedAnomalies.some(anomaly => anomaly.code === 'UNAUTHORIZED_SIDE_EFFECT'),
      artifactsParsable: invalidArtifactTotal === 0,
    },
    anomalies: sortedAnomalies.slice(0, 20),
    ...(sortedAnomalies.length > 20 ? { truncated: true } : {}),
  };
  return compactFactLedger(ledger);
}

export function buildCachedFactLedger(
  store: Store,
  tenantId: string,
  runs: RunRecord[],
  now: number,
  cache: Map<string, FactLedger>,
  rubric = rubricFromPolicy(),
): FactLedger {
  const sources = loadFactSources(store, runs);
  const key = stableHash({
    tenantId,
    rubricVersion: rubric.version,
    rubricHash: rubric.hash,
    runs: sources.map(source => ({
      id: source.run.id,
      record: source.run,
      events: source.events,
      tools: source.calls,
      modelCalls: source.modelCalls,
      artifacts: source.artifacts,
      contracts: store.organization.contractsForRun(source.run.id, tenantId),
      workOrder: store.organization.workOrderByRun(source.run.rootId, tenantId),
    })),
  });
  const cached = cache.get(key);
  if (cached) {
    const reused = { ...cached, generatedAt: now };
    cache.delete(key);
    cache.set(key, reused);
    return reused;
  }
  const ledger = buildFactLedgerFromSources(store, tenantId, sources, now, rubric.version);
  cache.set(key, ledger);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return ledger;
}

function compactFactLedger(input: FactLedger): FactLedger {
  const ledger: FactLedger = {
    ...input,
    runs: input.runs.map(run => ({
      ...run,
      capabilities: run.capabilities.slice(0, 12),
      modelPurposes: run.modelPurposes.slice(0, 4),
      toolVersions: run.toolVersions.slice(0, 4),
    })),
    anomalies: input.anomalies.slice(0, 20).map(anomaly => ({
      ...anomaly,
      summary: trimToTokens(anomaly.summary, 60),
      evidenceRefs: anomaly.evidenceRefs.slice(0, 8),
    })),
  };
  if (estimateTokens(JSON.stringify(ledger)) <= FACT_LEDGER_TOKEN_LIMIT) return ledger;
  ledger.truncated = true;
  const anomalyCaps = [12, 8, 5, 3, 1, 0];
  const capabilityCaps = [4, 2, 1, 0];
  const goalCaps = [40, 24, 12];
  for (const anomalyCap of anomalyCaps) {
    ledger.anomalies = input.anomalies.slice(0, anomalyCap).map(anomaly => ({
      ...anomaly,
      summary: trimToTokens(anomaly.summary, 48),
      evidenceRefs: anomaly.evidenceRefs.slice(0, 4),
    }));
    for (const capabilityCap of capabilityCaps) {
      for (const goalCap of goalCaps) {
        ledger.runs = input.runs.map(run => ({
          ...run,
          goal: trimToTokens(run.goal, goalCap),
          capabilities: run.capabilities.slice(0, capabilityCap),
          modelPurposes: run.modelPurposes.slice(0, capabilityCap),
          toolVersions: run.toolVersions.slice(0, capabilityCap),
        }));
        if (estimateTokens(JSON.stringify(ledger)) <= FACT_LEDGER_TOKEN_LIMIT) return ledger;
      }
    }
  }
  ledger.runs = input.runs.slice(0, 5).map(run => ({
    ...run,
    goal: trimToTokens(run.goal, 12),
    capabilities: [],
    modelPurposes: run.modelPurposes.slice(0, 1),
    toolVersions: run.toolVersions.slice(0, 1),
  }));
  ledger.omittedRuns = Math.max(0, input.runs.length - ledger.runs.length);
  if (estimateTokens(JSON.stringify(ledger)) <= FACT_LEDGER_TOKEN_LIMIT) return ledger;
  ledger.anomalies = [];
  ledger.runs = input.runs.slice(0, 3).map(run => ({
    id: run.id,
    status: run.status,
    goal: '',
    verified: run.verified,
    durationMs: run.durationMs,
    modelCalls: run.modelCalls,
    modelInputTokens: run.modelInputTokens,
    modelOutputTokens: run.modelOutputTokens,
    modelCostUsd: run.modelCostUsd,
    modelFailures: run.modelFailures,
    modelPurposes: [],
    toolCalls: run.toolCalls,
    failedTools: run.failedTools,
    duplicateTools: run.duplicateTools,
    toolVersions: [],
    recoveries: run.recoveries,
    approvalWaits: run.approvalWaits,
    artifacts: run.artifacts,
    invalidArtifacts: run.invalidArtifacts,
    capabilities: [],
    conflicts: run.conflicts,
  }));
  ledger.omittedRuns = Math.max(0, input.runs.length - ledger.runs.length);
  if (estimateTokens(JSON.stringify(ledger)) > FACT_LEDGER_TOKEN_LIMIT) {
    ledger.runs = [];
    ledger.omittedRuns = input.runs.length;
  }
  return ledger;
}

function clusterMultiRunFacts(input: FactLedger): FactLedger {
  if (input.runIds.length <= 1) return input;
  const clusters = new Map<string, FactAnomaly>();
  for (const anomaly of input.anomalies) {
    const current = clusters.get(anomaly.code);
    if (!current) {
      clusters.set(anomaly.code, { ...anomaly, evidenceRefs: [...anomaly.evidenceRefs] });
      continue;
    }
    current.occurrences += anomaly.occurrences;
    current.evidenceRefs = [...new Set([...current.evidenceRefs, ...anomaly.evidenceRefs])].slice(0, 8);
    if (severityRank(anomaly.severity) < severityRank(current.severity)) {
      current.severity = anomaly.severity;
      current.summary = anomaly.summary;
    }
  }
  const anomalies = [...clusters.values()]
    .sort((a, b) => b.occurrences - a.occurrences || severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 5);
  return compactFactLedger({
    ...input,
    anomalies,
    ...(anomalies.length < clusters.size ? { truncated: true } : {}),
  });
}

export function buildEvidenceIndex(runs: RunRecord[], store: Store): ReviewEvidenceRef[] {
  const rows: ReviewEvidenceRef[] = [];
  const push = (ref: ReviewEvidenceRef) => {
    if (!rows.some(item => item.id === ref.id)) rows.push(ref);
  };
  for (const run of runs) {
    push({ id: `run:${run.id}:goal`, kind: 'goal', runId: run.id, label: '任务目标', size: jsonText(run.objective).length });
    if (run.answer) push({ id: `run:${run.id}:answer`, kind: 'answer', runId: run.id, label: '最终回答', size: run.answer.length });
    if (run.verification) push({ id: `run:${run.id}:verification`, kind: 'verification', runId: run.id, label: '机器验收结果', size: jsonText(run.verification).length });
    if (run.capabilityResolution) push({ id: `run:${run.id}:capability`, kind: 'capability', runId: run.id, label: '能力选择', size: jsonText(run.capabilityResolution).length });
    if (run.ruleResolution) push({ id: `run:${run.id}:rule`, kind: 'rule', runId: run.id, label: '规则裁决', size: jsonText(run.ruleResolution).length });
    const events = store.runs.events(run.id);
    for (const event of events.filter(item => /error|failed|partial|approval|recover|artifact|state/.test(item.type)).slice(-12)) {
      push({ id: `run:${run.id}:event:${event.seq}`, kind: 'event', runId: run.id, label: `${event.type} · #${event.seq}`, size: jsonText(event.data).length });
    }
    for (const call of store.runs.toolCalls(run.id).slice(-24)) {
      const page = store.runs.readTool(run.id, call.id);
      const longResult = !!page && page.length > 4_000;
      if (call.status === 'succeeded' && (!call.sideEffect || call.sideEffect === 'none' || call.sideEffect === 'read') && !longResult) continue;
      push({
        id: `run:${run.id}:tool:${call.id}`,
        kind: 'tool',
        runId: run.id,
        label: longResult ? `${call.name} · 长结果 ${page.length} 字符` : `${call.name} · ${call.status}`,
        ...(longResult ? { reason: 'long_result' } : {}),
        size: page?.length ?? call.argsSummary.length + (call.failure ? 120 : 0),
        ...(longResult ? { resultRef: call.id, truncated: page.truncated } : {}),
      });
    }
    for (const call of store.runs.modelCalls(run.id, 0, 100).filter(item => item.status !== 'completed' || item.errorCode).slice(-8)) {
      push({ id: `run:${run.id}:model:${call.id}`, kind: 'model', runId: run.id, label: `${call.purpose} · ${call.status}`, size: 200 });
    }
    for (const artifact of store.runs.artifacts(run.id).slice(-12)) {
      push({ id: `run:${run.id}:artifact:${artifact.id}`, kind: 'artifact', runId: run.id, label: `${artifact.label} · ${artifact.ref}`, size: jsonText(artifact.metadata).length });
    }
  }
  return rows;
}

function compactEvidenceIndex(index: ReviewEvidenceRef[], facts: FactLedger): ReviewEvidenceRef[] {
  const anomalyRefs = new Set(facts.anomalies.flatMap(item => item.evidenceRefs));
  const rank = (item: ReviewEvidenceRef) => {
    if (anomalyRefs.has(item.id)) return 0;
    if (item.reason === 'long_result') return 1;
    if (item.kind === 'verification') return 1;
    if (item.kind === 'artifact') return 2;
    if (item.kind === 'capability' || item.kind === 'rule') return 3;
    if (item.kind === 'goal' || item.kind === 'answer') return 4;
    if (item.kind === 'tool' || item.kind === 'event' || item.kind === 'model') return 5;
    return 6;
  };
  return index
    .map((item, position) => ({ item, position }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.position - b.position)
    .slice(0, 24)
    .map(entry => entry.item);
}

function ledgerGateFailed(facts: FactLedger): boolean {
  return Object.values(facts.gates).some(value => !value);
}

function hasFocusedSignal(facts: FactLedger, factsIncomplete: boolean): boolean {
  return factsIncomplete || facts.runIds.length > 1 || facts.anomalies.length > 0 || ledgerGateFailed(facts);
}

function budgetFor(
  runs: number,
  focused: boolean,
  evaluation: EvaluationVersion,
): Pick<ReviewBudget, 'inputTokenLimit' | 'outputTokenLimit' | 'totalTokenLimit'> {
  const configured = runs > 1
    ? evaluation.record.review.multi
    : focused ? evaluation.record.review.focused : evaluation.record.review.fast;
  const fallback = runs > 1
    ? { inputTokenLimit: MULTI_INPUT_LIMIT, outputTokenLimit: MULTI_OUTPUT_LIMIT, totalTokenLimit: MULTI_TOTAL_LIMIT }
    : focused
      ? { inputTokenLimit: FOCUSED_INPUT_LIMIT, outputTokenLimit: FOCUSED_OUTPUT_LIMIT, totalTokenLimit: FOCUSED_TOTAL_LIMIT }
      : { inputTokenLimit: FAST_INPUT_LIMIT, outputTokenLimit: FAST_OUTPUT_LIMIT, totalTokenLimit: FAST_TOTAL_LIMIT };
  return {
    inputTokenLimit: configured?.input ?? fallback.inputTokenLimit,
    outputTokenLimit: configured?.output ?? fallback.outputTokenLimit,
    totalTokenLimit: configured?.total ?? fallback.totalTokenLimit,
  };
}

function scoreOf(review: AIUserReview): number | null {
  const values = review.dimensions.flatMap(item => item.score === null ? [] : [item.score]);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
}

export class ExperienceService {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly evidenceCache = new Map<string, EvidenceSlice>();
  private readonly factCache = new Map<string, FactLedger>();
  private readonly now: () => number;

  constructor(private readonly deps: ExperienceDeps) {
    this.now = deps.now ?? Date.now;
  }

  estimate(request: AIUserReviewRequest, tenantId: string): AIUserReviewEstimate {
    const selection = this.resolve(request, tenantId, false, true);
    const available = !!providerFor(this.deps.providers(), selection.provider.id, selection.model);
    const cost = available
      ? estimateCost(selection.provider, selection.model, selection.budget.inputTokenLimit, selection.budget.outputTokenLimit)
      : { costUsd: null, costSource: 'unknown' as const };
    return {
      providerId: selection.provider.id,
      model: selection.model,
      originalProviderId: selection.originalProviderId,
      originalModel: selection.originalModel,
      crossModel: selection.crossModel,
      available,
      requiresExplicitModel: !available || selection.crossModel,
      scope: selection.scope,
      path: selection.path,
      evaluationVersion: selection.evaluation.version,
      evaluationHash: selection.evaluation.hash,
      inputTokenLimit: selection.budget.inputTokenLimit,
      outputTokenLimit: selection.budget.outputTokenLimit,
      totalTokenLimit: selection.budget.totalTokenLimit,
      estimatedCostUsd: cost.costUsd,
      costSource: cost.costSource,
      runCount: selection.runs.length,
    };
  }

  create(request: AIUserReviewRequest, tenantId: string): AIUserReview {
    const selection = this.resolve(request, tenantId, true, false);
    const rubric = rubricFromPolicy(selection.evaluation.record);
    const requestFingerprint = stableHash({
      runIds: selection.runs.map(run => run.id),
      providerId: selection.provider.id,
      model: selection.model,
      rubricVersion: rubric.version,
      rubricHash: rubric.hash,
      evaluationVersion: selection.evaluation.version,
      evaluationHash: selection.evaluation.hash,
    });
    const key = request.requestKey?.trim() || undefined;
    if (key) {
      const prior = this.deps.store.experience.reviewByRequestKey(tenantId, key);
      if (prior) {
        if (prior.requestFingerprint && prior.requestFingerprint !== requestFingerprint) {
          throw new ExperienceError(409, 'IDEMPOTENCY_CONFLICT', '该请求标识已用于不同的复盘范围或模型');
        }
        return prior;
      }
    }
    const facts = selection.facts;
    const evidenceIndex = compactEvidenceIndex(buildEvidenceIndex(selection.runs, this.deps.store), facts);
    const now = this.now();
    const review: AIUserReview = {
      id: randomUUID(),
      tenantId,
      ...(key ? { requestKey: key } : {}),
      requestFingerprint,
      scope: selection.scope,
      sourceRunIds: selection.runs.map(run => run.id),
      status: 'queued',
      path: selection.path,
      providerId: selection.provider.id,
      model: selection.model,
      originalProviderId: selection.originalProviderId,
      originalModel: selection.originalModel,
      crossModel: selection.crossModel,
      rubricVersion: rubric.version,
      rubricHash: rubric.hash,
      evaluationVersion: selection.evaluation.version,
      evaluationHash: selection.evaluation.hash,
      evaluationPolicy: selection.evaluation.record,
      verdict: 'neutral',
      dimensions: [],
      observations: [],
      suggestions: [],
      reuseIntent: null,
      confidence: 0,
      evidenceGaps: [],
      facts,
      evidenceIndex,
      evidence: [],
      budget: {
        ...selection.budget,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costSource: modelPrice(selection.provider, selection.model)?.source ?? 'unknown',
      },
      calls: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.experience.putReview(review, key);
    this.emitReview(review);
    this.launch(review, selection.provider, selection.model, false);
    return review;
  }

  review(id: string, tenantId: string): AIUserReview {
    const review = this.deps.store.experience.review(id, tenantId);
    if (!review) throw new ExperienceError(404, 'REVIEW_NOT_FOUND', 'AI 使用复盘不存在');
    return review;
  }

  list(tenantId: string, limit = 100, runId?: string): AIUserReview[] {
    return this.deps.store.experience.listReviews(tenantId, limit, runId);
  }

  cancel(id: string, tenantId: string): AIUserReview {
    const review = this.review(id, tenantId);
    if (['completed', 'failed', 'cancelled', 'insufficient_evidence'].includes(review.status)) return review;
    this.active.get(id)?.controller.abort('user_cancel');
    review.status = 'cancelled';
    review.error = '用户取消了 AI 使用复盘';
    review.updatedAt = this.now();
    this.deps.store.experience.putReview(review, review.requestKey);
    this.emitReview(review);
    return review;
  }

  deepen(id: string, tenantId: string): AIUserReview {
    const review = this.review(id, tenantId);
    if (review.status !== 'insufficient_evidence') throw new ExperienceError(409, 'REVIEW_NOT_DEEPENABLE', '只有证据不足的复盘可以继续深入分析');
    const focused = review.evaluationPolicy?.review?.focused;
    review.status = 'queued';
    review.path = 'focused';
    review.error = undefined;
    review.evidenceGaps = [];
    review.budget.inputTokenLimit += focused?.input ?? FOCUSED_INPUT_LIMIT;
    review.budget.outputTokenLimit += focused?.output ?? FOCUSED_OUTPUT_LIMIT;
    review.budget.totalTokenLimit += focused?.total ?? FOCUSED_TOTAL_LIMIT;
    review.updatedAt = this.now();
    const provider = providerFor(this.deps.providers(), review.providerId, review.model);
    if (!provider) throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复盘模型不可用；请显式选择替代模型后重新发起复盘');
    this.deps.store.experience.putReview(review, review.requestKey);
    this.emitReview(review);
    this.launch(review, provider, review.model, true);
    return review;
  }

  async audit(id: string, tenantId: string, input: { providerId?: string; model?: string } = {}): Promise<ReviewAudit> {
    const review = this.review(id, tenantId);
    if (!['completed', 'insufficient_evidence'].includes(review.status)) throw new ExperienceError(409, 'REVIEW_NOT_AUDITABLE', '完成复盘后才能独立复核');
    const providers = this.deps.providers();
    const provider = providerFor(providers, input.providerId ?? review.providerId, input.model ?? review.model);
    if (!provider || provider.id !== (input.providerId ?? review.providerId)) {
      throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复核模型不可用；请显式选择替代模型');
    }
    const model = input.model ?? review.model;
    const evidenceIds = new Set(review.evidenceIndex.map(item => item.id));
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是独立复核者。核对 AI 用户复盘是否被事实账本和证据支持，不替它改写事实。只输出严格 JSON。' },
      { role: 'user', content: JSON.stringify({
        facts: review.facts,
        review: {
          verdict: review.verdict, dimensions: review.dimensions, observations: review.observations,
          suggestions: review.suggestions, reuseIntent: review.reuseIntent, confidence: review.confidence,
          evidenceGaps: review.evidenceGaps,
        },
        evidence: review.evidence.map(item => ({ ref: item.ref, text: trimToTokens(item.text, 400, provider.tokenizer) })),
        validEvidenceRefs: [...evidenceIds],
        output: { verdict: 'agree|disagree|inconclusive', summary: 'string', correctedEvidenceRefs: ['valid refs'], confidence: '0..1' },
      }) },
    ];
    const promptTokens = countMessageTokens(messages, provider.tokenizer);
    if (promptTokens > 2_000) throw new ExperienceError(422, 'AUDIT_INPUT_TOO_LARGE', '复核输入超过预算，请缩小复盘证据');
    const result = await this.invoke(provider, model, messages, 500, 'experience_audit');
    const parsed = parseJsonObject(result.text);
    const verdict = parsed.verdict === 'agree' || parsed.verdict === 'disagree' ? parsed.verdict : 'inconclusive';
    const audit: ReviewAudit = {
      id: randomUUID(),
      tenantId,
      reviewId: id,
      source: 'ai',
      kind: 'independent_review',
      providerId: provider.id,
      model,
      verdict,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 2_000) : '复核未提供摘要',
      correctedEvidenceRefs: uniqueStrings(parsed.correctedEvidenceRefs).filter(ref => evidenceIds.has(ref)),
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      createdAt: this.now(),
    };
    this.deps.store.experience.putAudit(audit);
    this.deps.emit('experience.review.updated', { tenantId, reviewId: id, status: review.status, verdict: review.verdict }, id);
    return audit;
  }

  calibrate(id: string, tenantId: string, input: { verdict?: string; summary?: string; dimensions?: unknown }): ReviewAudit {
    const review = this.review(id, tenantId);
    if (!['completed', 'insufficient_evidence'].includes(review.status)) throw new ExperienceError(409, 'REVIEW_NOT_CALIBRATABLE', '完成复盘后才能人工校准');
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary || summary.length > 2_000) throw new ExperienceError(400, 'INVALID_CALIBRATION', '人工校准摘要不能为空且不能超过 2000 字');
    const verdict = input.verdict === 'agree' || input.verdict === 'disagree' ? input.verdict : 'inconclusive';
    const rubric = rubricFromPolicy(review.evaluationPolicy);
    const dimensions = Array.isArray(input.dimensions)
      ? input.dimensions.flatMap(item => {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.reason !== 'string') return [];
          const score = item.score === null ? null : Number(item.score);
          if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) return [];
          return [{ id: item.id, score: score as ReviewDimensionScore['score'], reason: item.reason.slice(0, 1_000), evidenceRefs: uniqueStrings(item.evidenceRefs).filter(ref => review.evidenceIndex.some(evidence => evidence.id === ref)) }];
        }).slice(0, rubric.dimensions.length)
      : undefined;
    const audit: ReviewAudit = {
      id: randomUUID(), tenantId, reviewId: id, source: 'human', kind: 'calibration',
      providerId: 'human', model: 'human', verdict, summary,
      correctedEvidenceRefs: review.evidence.map(item => item.ref).slice(0, 10),
      ...(dimensions ? { dimensions } : {}),
      createdAt: this.now(),
    };
    this.deps.store.experience.putAudit(audit);
    this.deps.emit('experience.review.updated', { tenantId, reviewId: id, status: review.status, verdict: review.verdict }, id);
    return audit;
  }

  audits(id: string, tenantId: string): ReviewAudit[] {
    this.review(id, tenantId);
    return this.deps.store.experience.audits(id, tenantId);
  }

  adoptSuggestion(reviewId: string, suggestionId: string, tenantId: string): ExperienceFinding {
    const review = this.review(reviewId, tenantId);
    if (review.status !== 'completed' && review.status !== 'insufficient_evidence') throw new ExperienceError(409, 'REVIEW_NOT_ADOPTABLE', '完成复盘后才能采纳建议');
    const suggestion = review.suggestions.find(item => item.id === suggestionId);
    if (!suggestion) throw new ExperienceError(404, 'SUGGESTION_NOT_FOUND', '复盘建议不存在');
    if (suggestion.adoptedFindingId) {
      const existing = this.deps.store.experience.finding(suggestion.adoptedFindingId, tenantId);
      if (existing) return existing;
    }
    const fingerprint = stableHash({
      category: suggestion.category,
      title: suggestion.title.trim().toLowerCase(),
      evidenceKinds: suggestion.evidenceRefs.map(ref => {
        const parts = ref.split(':');
        const nestedKind = parts.at(-2);
        return nestedKind && ['event', 'tool', 'artifact', 'model'].includes(nestedKind)
          ? nestedKind
          : parts.at(-1) ?? ref;
      }).sort(),
    });
    const prior = this.deps.store.experience.findingByFingerprint(tenantId, fingerprint);
    const now = this.now();
    const priorReviewIds = prior ? prior.reviewIds ?? [prior.reviewId] : [];
    const finding: ExperienceFinding = prior ? {
      ...prior,
      reviewIds: [...new Set([...priorReviewIds, reviewId])],
      sourceRunIds: [...new Set([...prior.sourceRunIds, ...review.sourceRunIds])],
      evidenceRefs: [...new Set([...prior.evidenceRefs, ...suggestion.evidenceRefs])]
        .filter(ref => review.evidenceIndex.some(item => item.id === ref) || prior.evidenceRefs.includes(ref))
        .slice(0, 12),
      severity: severityRank(this.suggestionSeverity(review, suggestion)) < severityRank(prior.severity)
        ? this.suggestionSeverity(review, suggestion)
        : prior.severity,
      occurrences: (prior.occurrences ?? priorReviewIds.length) + (priorReviewIds.includes(reviewId) ? 0 : 1),
      updatedAt: now,
    } : {
      id: randomUUID(), tenantId, reviewId, suggestionId, fingerprint,
      reviewIds: [reviewId],
      title: suggestion.title, detail: suggestion.detail, category: suggestion.category,
      severity: this.suggestionSeverity(review, suggestion), status: 'new',
      evidenceRefs: suggestion.evidenceRefs.filter(ref => review.evidenceIndex.some(item => item.id === ref)).slice(0, 12),
      sourceRunIds: review.sourceRunIds, occurrences: 1, createdAt: now, updatedAt: now,
    };
    this.deps.store.experience.transaction(() => {
      this.deps.store.experience.putFinding(finding);
      suggestion.adoptedFindingId = finding.id;
      review.updatedAt = now;
      this.deps.store.experience.putReview(review, review.requestKey);
    });
    this.emitFinding(finding);
    return finding;
  }

  findings(tenantId: string, status?: FindingStatus, limit = 100): ExperienceFinding[] {
    return status ? this.deps.store.experience.findingsByStatus(tenantId, status, limit) : this.deps.store.experience.findings(tenantId, undefined, limit);
  }

  updateFinding(id: string, tenantId: string, status: FindingStatus, statusNote?: string): ExperienceFinding {
    const finding = this.deps.store.experience.finding(id, tenantId);
    if (!finding) throw new ExperienceError(404, 'FINDING_NOT_FOUND', '体验问题不存在');
    if (!FINDING_TRANSITIONS[finding.status].includes(status)) {
      throw new ExperienceError(409, 'INVALID_FINDING_TRANSITION', `问题不能从 ${finding.status} 直接变为 ${status}`);
    }
    if (status === 'closed') {
      const regressionPassed = this.deps.store.experience.regressions(id, tenantId).some(item => item.status === 'passed');
      if (!regressionPassed && !statusNote?.trim()) {
        throw new ExperienceError(409, 'FINDING_CLOSURE_EVIDENCE_REQUIRED', '关闭体验问题需要已通过的回归结果或明确的人工例外说明');
      }
    }
    finding.status = status;
    if (statusNote !== undefined) finding.statusNote = statusNote.slice(0, 2_000);
    finding.updatedAt = this.now();
    this.deps.store.experience.putFinding(finding);
    this.emitFinding(finding);
    return finding;
  }

  reproduceFinding(id: string, tenantId: string, expected?: string): { finding: ExperienceFinding; regression: ExperienceRegressionCase } {
    const finding = this.deps.store.experience.finding(id, tenantId);
    if (!finding) throw new ExperienceError(404, 'FINDING_NOT_FOUND', '体验问题不存在');
    if (finding.status !== 'triaged' && finding.status !== 'new') throw new ExperienceError(409, 'FINDING_NOT_REPRODUCIBLE', '只有新问题或已分诊问题可以建立复现案例');
    const source = this.deps.store.runs.get(finding.sourceRunIds[0] ?? '', tenantId);
    if (!source) throw new ExperienceError(404, 'SOURCE_RUN_NOT_FOUND', '问题来源运行不存在');
    const now = this.now();
    const regression = {
      id: randomUUID(), tenantId, findingId: id, sourceRunIds: finding.sourceRunIds,
      objective: `隔离重放：${finding.title}`,
      expected: expected?.trim().slice(0, 4_000) || `复现“${finding.title}”，修复后不再出现该问题。`,
      evidenceRefs: finding.evidenceRefs, status: 'ready' as const, createdAt: now, updatedAt: now,
    };
    finding.status = 'reproduced';
    finding.regressionId = regression.id;
    finding.updatedAt = now;
    this.deps.store.experience.transaction(() => {
      this.deps.store.experience.putRegression(regression);
      this.deps.store.experience.putFinding(finding);
    });
    this.emitFinding(finding);
    return { finding, regression };
  }

  recordRegressionResult(
    findingId: string,
    tenantId: string,
    input: { outcome: 'passed' | 'failed'; runId: string; summary: string },
  ): { finding: ExperienceFinding; regression: ExperienceRegressionCase } {
    const finding = this.deps.store.experience.finding(findingId, tenantId);
    if (!finding) throw new ExperienceError(404, 'FINDING_NOT_FOUND', '体验问题不存在');
    if (finding.status !== 'verifying') throw new ExperienceError(409, 'FINDING_NOT_VERIFIABLE', '问题进入验证阶段后才能登记回归结果');
    const run = this.deps.store.runs.get(input.runId, tenantId);
    if (!run) throw new ExperienceError(404, 'VERIFICATION_RUN_NOT_FOUND', '验证运行不存在或不属于当前租户');
    if (!RUN_TERMINAL.has(run.status)) throw new ExperienceError(409, 'VERIFICATION_RUN_NOT_TERMINAL', '验证运行尚未结束');
    const verification = verificationStatus(run.verification);
    if (input.outcome === 'passed' && run.status !== 'completed') {
      throw new ExperienceError(409, 'REGRESSION_PASS_REQUIRES_COMPLETED_RUN', '只有已完成运行可以登记为回归通过');
    }
    if (input.outcome === 'passed' && (verification === 'failed' || verification === 'partial')) {
      throw new ExperienceError(409, 'REGRESSION_PASS_CONFLICTS_WITH_VERIFICATION', '运行验收未通过，不能登记为回归通过');
    }
    const summary = input.summary.trim();
    if (!summary || summary.length > 2_000) throw new ExperienceError(400, 'INVALID_REGRESSION_RESULT', '回归结论不能为空且不能超过 2000 字');
    const regression = finding.regressionId
      ? this.deps.store.experience.regressions(finding.id, tenantId).find(item => item.id === finding.regressionId)
      : this.deps.store.experience.regressions(finding.id, tenantId)[0];
    if (!regression) throw new ExperienceError(409, 'REGRESSION_NOT_FOUND', '体验问题没有可验证的回归案例');
    const evidenceRefs = [
      `run:${run.id}:goal`,
      ...(run.answer ? [`run:${run.id}:answer`] : []),
      ...(run.verification ? [`run:${run.id}:verification`] : []),
      ...this.deps.store.runs.artifacts(run.id).map(item => `run:${run.id}:artifact:${item.id}`),
    ].slice(0, 12);
    const now = this.now();
    regression.status = input.outcome;
    regression.verificationRunId = run.id;
    regression.resultSummary = summary;
    regression.evidenceRefs = evidenceRefs;
    regression.completedAt = now;
    regression.updatedAt = now;
    finding.status = input.outcome === 'passed' ? 'closed' : 'reopened';
    finding.sourceRunIds = [...new Set([...finding.sourceRunIds, run.id])];
    finding.evidenceRefs = [...new Set([...finding.evidenceRefs, ...evidenceRefs])].slice(0, 12);
    finding.statusNote = summary;
    finding.updatedAt = now;
    this.deps.store.experience.transaction(() => {
      this.deps.store.experience.putRegression(regression);
      this.deps.store.experience.putFinding(finding);
    });
    this.emitFinding(finding);
    return { finding, regression };
  }

  evolveFinding(
    findingId: string,
    tenantId: string,
    submit: (input: {
      name: string;
      description: string;
      reason: string;
      findingId: string;
      severity: FindingSeverity;
      evidenceRefs: string[];
      sourceRunIds: string[];
      regressionId?: string;
    }) => { id: string } | undefined,
  ): ExperienceFinding {
    const finding = this.deps.store.experience.finding(findingId, tenantId);
    if (!finding) throw new ExperienceError(404, 'FINDING_NOT_FOUND', '体验问题不存在');
    if (finding.evolutionProposalId) return finding;
    const regressions = this.deps.store.experience.regressions(finding.id, tenantId);
    const reviewIds = finding.reviewIds ?? [finding.reviewId];
    const occurrences = finding.occurrences ?? reviewIds.length;
    const hasRepeatedEvidence = reviewIds.length >= 2 || occurrences >= 2;
    const hasCriticalRegression = (finding.severity === 'P0' || finding.severity === 'P1')
      && regressions.some(item => item.status === 'passed');
    if (!hasRepeatedEvidence && !hasCriticalRegression) {
      throw new ExperienceError(409, 'EVOLUTION_EVIDENCE_REQUIRED', '提交自进化需要至少两次复盘证据，或 P0/P1 问题的通过回归');
    }
    const regression = regressions.find(item => item.status === 'passed');
    const proposal = submit({
      name: `experience-${finding.category}-${finding.fingerprint.slice(0, 10)}`,
      description: `避免体验问题：${finding.title}`,
      reason: `由 ${reviewIds.length} 次 AI 用户复盘确认，严重度 ${finding.severity}。${regression?.resultSummary ?? '等待采纳后进入技能验证。'}`,
      findingId: finding.id,
      severity: finding.severity,
      evidenceRefs: finding.evidenceRefs,
      sourceRunIds: finding.sourceRunIds,
      ...(regression ? { regressionId: regression.id } : {}),
    });
    if (!proposal) throw new ExperienceError(503, 'EVOLVE_UNAVAILABLE', '自进化提案服务不可用或待处理提案已达上限');
    finding.evolutionProposalId = proposal.id;
    finding.evolutionSubmittedAt = this.now();
    finding.updatedAt = this.now();
    this.deps.store.experience.putFinding(finding);
    this.emitFinding(finding);
    return finding;
  }

  summary(tenantId: string): AIUserReviewSummary {
    const reviews = this.deps.store.experience.listReviews(tenantId, 100);
    const findings = this.deps.store.experience.findings(tenantId, undefined, 500);
    const scores = reviews.map(scoreOf).flatMap(value => value === null ? [] : [value]);
    return {
      undecidedFindings: findings.filter(item => item.status === 'new' || item.status === 'triaged').length,
      openFindings: findings.filter(item => !['closed', 'wont_fix'].includes(item.status)).length,
      adoptedFindings: findings.length,
      reviewCount: reviews.length,
      negativeReviews: reviews.filter(item => item.verdict === 'negative').length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 10) / 10 : null,
      reviewCostUsd: reviews.reduce((sum, item) => sum + item.budget.costUsd, 0),
      recentReviews: reviews.slice(0, 6),
    };
  }

  settled(id: string): Promise<void> | undefined {
    return this.active.get(id)?.promise;
  }

  private resolve(request: AIUserReviewRequest, tenantId: string, requireModel: boolean, allowUnavailable: boolean): ResolvedSelection {
    if (!Array.isArray(request.runIds) || request.runIds.length < 1 || request.runIds.length > 10) {
      throw new ExperienceError(400, 'INVALID_REVIEW_SCOPE', '复盘必须选择 1 至 10 个运行');
    }
    const runIds = [...new Set(request.runIds.filter(item => typeof item === 'string' && item))];
    if (runIds.length !== request.runIds.length) throw new ExperienceError(400, 'INVALID_REVIEW_SCOPE', '复盘运行不能重复');
    const runs = runIds.map(id => this.deps.store.runs.get(id, tenantId));
    if (runs.some(run => !run)) throw new ExperienceError(404, 'RUN_NOT_FOUND', '所选运行不存在或不属于当前租户');
    const selected = runs as RunRecord[];
    if (selected.some(run => !terminal(run))) throw new ExperienceError(409, 'RUN_ACTIVE', '只能复盘已结束的运行');
    const first = selected[0]!;
    if (selected.some(run => run.providerId !== first.providerId || run.model !== first.model)) {
      throw new ExperienceError(400, 'MIXED_MODELS', '多运行复盘必须使用同一原始模型');
    }
    if (selected.some(run => run.authorization.workspace !== first.authorization.workspace)) {
      throw new ExperienceError(400, 'MIXED_WORKSPACES', '多运行复盘必须属于同一工作区');
    }
    const providers = this.deps.providers();
    const originalAvailable = !!providerFor(providers, first.providerId, first.model);
    const requestedProvider = typeof request.providerId === 'string' ? request.providerId.trim() : '';
    const requestedModel = typeof request.model === 'string' ? request.model.trim() : '';
    if (!originalAvailable && (!requestedProvider || !requestedModel) && !allowUnavailable) {
      throw new ExperienceError(409, 'ORIGINAL_MODEL_UNAVAILABLE', '原工作模型不可用；请显式选择一个替代模型');
    }
    if (!!requestedProvider !== !!requestedModel) throw new ExperienceError(400, 'INVALID_MODEL', '替代模型必须同时提供供应商和模型名称');
    const providerId = requestedProvider || first.providerId;
    const model = requestedModel || first.model;
    const provider = providerFor(providers, providerId, model) ?? (allowUnavailable ? {
      id: providerId, label: 'Unavailable', defaultModel: model, priceSource: 'unknown' as const,
      async *chat() {},
    } satisfies ProviderDef : undefined);
    if (!provider) {
      if (requireModel || requestedProvider) throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复盘模型当前不可用');
      throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复盘模型当前不可用');
    }
    const evaluation = new OrganizationService({ store: this.deps.store }).ensureEvaluation(tenantId);
    const rawFacts = buildCachedFactLedger(
      this.deps.store,
      tenantId,
      selected,
      this.now(),
      this.factCache,
      rubricFromPolicy(evaluation.record),
    );
    const focused = hasFocusedSignal(rawFacts, rawFacts.truncated === true);
    const facts = selected.length > 1 ? clusterMultiRunFacts(rawFacts) : rawFacts;
    return {
      provider,
      model,
      originalProviderId: first.providerId,
      originalModel: first.model,
      crossModel: provider.id !== first.providerId || model !== first.model,
      scope: selected.length > 1 ? 'multi_run' : 'run',
      runs: selected,
      facts,
      path: focused ? 'focused' : 'fast',
      evaluation,
      budget: budgetFor(selected.length, focused, evaluation),
    };
  }

  private launch(review: AIUserReview, provider: ProviderDef, model: string, deepen: boolean): void {
    const controller = new AbortController();
    const promise = this.execute(review, provider, model, controller.signal, deepen).finally(() => this.active.delete(review.id));
    this.active.set(review.id, { controller, promise });
  }

  private async execute(review: AIUserReview, provider: ProviderDef, model: string, signal: AbortSignal, deepen: boolean): Promise<void> {
    try {
      review.status = 'running';
      review.updatedAt = this.now();
      this.deps.store.experience.putReview(review, review.requestKey);
      this.emitReview(review);
      const validRefs = new Set(review.evidenceIndex.map(item => item.id));
      let selectedEvidence = [...review.evidence];
      let structured: StructuredReview;
      if (review.path === 'fast') {
        selectedEvidence = this.pickEvidence(review, review.facts.anomalies.flatMap(item => item.evidenceRefs), 4, 1_200);
        structured = await this.fastReview(review, provider, model, selectedEvidence, signal);
      } else {
        const plan = await this.focusedPlan(review, provider, model, signal);
        if (signal.aborted) throw new ExperienceError(499, 'REVIEW_CANCELLED', '复盘已取消');
        const requested = plan.evidenceRefs.filter(ref => validRefs.has(ref));
        if (plan.evidenceRefs.length > 0 && requested.length === 0) {
          review.status = 'insufficient_evidence';
          review.verdict = 'insufficient_evidence';
          review.evidenceGaps = ['模型请求的证据引用均无效', ...plan.evidenceGaps].slice(0, 8);
          this.complete(review);
          return;
        }
        if (!requested.length && plan.evidenceGaps.length) {
          review.status = 'insufficient_evidence';
          review.path = 'focused';
          review.verdict = 'insufficient_evidence';
          review.evidenceGaps = plan.evidenceGaps.slice(0, 8);
          review.error = undefined;
          this.complete(review);
          return;
        }
        selectedEvidence = this.pickEvidence(review, requested, 6, 3_600);
        if (requested.length > selectedEvidence.length && selectedEvidence.length === 0) {
          review.status = 'insufficient_evidence';
          review.verdict = 'insufficient_evidence';
          review.evidenceGaps = ['请求的证据无法在预算内读取', ...plan.evidenceGaps].slice(0, 8);
          this.complete(review);
          return;
        }
        structured = await this.focusedReview(review, provider, model, plan, selectedEvidence, signal, deepen);
      }
      if (signal.aborted) throw new ExperienceError(499, 'REVIEW_CANCELLED', '复盘已取消');
      this.applyStructured(review, structured, validRefs);
      review.evidence = selectedEvidence;
      this.complete(review);
    } catch (error) {
      if (signal.aborted) {
        review.status = 'cancelled';
        review.error = '用户取消了 AI 使用复盘';
      } else if (error instanceof ExperienceError && error.code === 'INSUFFICIENT_EVIDENCE') {
        review.status = 'insufficient_evidence';
        review.verdict = 'insufficient_evidence';
        review.evidenceGaps = uniqueStrings((error as ExperienceError & { evidenceGaps?: unknown }).evidenceGaps, 8);
        review.error = undefined;
      } else {
        review.status = 'failed';
        review.error = error instanceof Error ? error.message : String(error);
      }
      review.updatedAt = this.now();
      this.deps.store.experience.putReview(review, review.requestKey);
      this.emitReview(review);
    }
  }

  private async fastReview(review: AIUserReview, provider: ProviderDef, model: string, evidence: EvidenceSlice[], signal: AbortSignal): Promise<StructuredReview> {
    const messages = this.reviewMessages(review, evidence, undefined, false);
    const available = this.remainingInput(review);
    if (countMessageTokens(messages, provider.tokenizer) > available) throw this.insufficient('快速复盘输入超过预算');
    const result = await this.invokeReview(review, provider, model, messages, signal);
    this.account(review, result);
    return this.parseStructured(result.text, review, true);
  }

  private async focusedPlan(review: AIUserReview, provider: ProviderDef, model: string, signal: AbortSignal): Promise<EvidencePlan> {
    const rubric = rubricFromPolicy(review.evaluationPolicy);
    const messages: LLMMessage[] = [
      { role: 'system', content: rubric.systemPrompt },
      { role: 'user', content: JSON.stringify({
        mode: 'evidence_plan',
        facts: review.facts,
        evidenceIndex: review.evidenceIndex,
        request: '只判断哪些维度需要验证，以及最多 6 个能改变评分或严重度的证据引用。不要评分。',
        limits: { refs: 6, hypotheses: 4, gaps: 3, text: '每项不超过 30 个汉字' },
        output: { evidenceRefs: ['<evidence id>'], evidenceGaps: ['string'], hypotheses: ['string'] },
      }) },
    ];
    const allocation = review.scope === 'multi_run' ? 3_000 : 2_500;
    const available = Math.min(this.remainingInput(review, allocation), allocation);
    if (countMessageTokens(messages, provider.tokenizer) > available) throw this.insufficient('事实索引超过证据规划预算');
    const result = await this.invokeReview(review, provider, model, messages, signal);
    this.account(review, result);
    const parsed = parseJsonObject(result.text);
    return {
      evidenceRefs: uniqueStrings(parsed.evidenceRefs, 6),
      evidenceGaps: uniqueStrings(parsed.evidenceGaps, 8),
      hypotheses: uniqueStrings(parsed.hypotheses, 8),
    };
  }

  private async focusedReview(review: AIUserReview, provider: ProviderDef, model: string, plan: EvidencePlan, evidence: EvidenceSlice[], signal: AbortSignal, _deepen: boolean): Promise<StructuredReview> {
    const messages = this.reviewMessages(review, evidence, plan.hypotheses, true);
    const available = this.remainingInput(review);
    if (countMessageTokens(messages, provider.tokenizer) > available) {
      const baseTokens = countMessageTokens(this.reviewMessages(review, [], plan.hypotheses, true), provider.tokenizer);
      const remainingEvidence = Math.max(0, available - baseTokens);
      const shrunk = evidence.map(item => {
        const text = trimToTokens(item.text, Math.max(80, Math.floor(Math.max(0, remainingEvidence) / Math.max(1, evidence.length))), provider.tokenizer);
        return { ...item, text, tokens: provider.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text) };
      });
      const retry = this.reviewMessages(review, shrunk, plan.hypotheses, true);
      if (countMessageTokens(retry, provider.tokenizer) > available) throw this.insufficient('证据片段超过聚焦复盘预算');
      return this.runFocusedFinal(review, provider, model, retry, signal);
    }
    return this.runFocusedFinal(review, provider, model, messages, signal);
  }

  private async runFocusedFinal(review: AIUserReview, provider: ProviderDef, model: string, messages: LLMMessage[], signal: AbortSignal): Promise<StructuredReview> {
    const result = await this.invokeReview(review, provider, model, messages, signal);
    this.account(review, result);
    return this.parseStructured(result.text, review, false);
  }

  private reviewMessages(review: AIUserReview, evidence: EvidenceSlice[], hypotheses: string[] | undefined, focused: boolean): LLMMessage[] {
    const rubric = rubricFromPolicy(review.evaluationPolicy);
    return [
      { role: 'system', content: rubric.systemPrompt },
      { role: 'user', content: JSON.stringify({
        kind: 'review_input',
        facts: review.facts,
        evidence,
        ...(hypotheses?.length ? { hypotheses } : {}),
        rubric: rubric.dimensions,
        ...(focused ? { priorStep: '已根据异常和冲突主动取证；现在完成评分。' } : { priorStep: '事实清楚时直接复盘。' }),
        outputLimits: `scores 恰好 ${rubric.dimensions.length} 项；observations 最多 4 项；suggestions 最多 3 项；不输出额外键或解释。`,
        output: {
          scores: rubric.dimensions.map(id => ({ id, score: '1..5 或 null', reason: 'string', evidenceRefs: ['valid evidence id'] })),
          observations: [{ kind: 'positive|friction', summary: 'string', cost: 'optional', evidenceRefs: ['valid evidence id'] }],
          suggestions: [{ title: 'string', detail: 'string', category: [...SUGGESTION_CATEGORIES], impact: 'high|medium|low', confidence: '0..1', evidenceRefs: ['valid evidence id'] }],
          reuseIntent: '1..5 或 null',
          confidence: '0..1',
          evidenceGaps: ['string'],
        },
      }) },
    ];
  }

  private parseStructured(text: string, review: AIUserReview, fast: boolean): StructuredReview {
    const parsed = parseJsonObject(text);
    const valid = new Set(review.evidenceIndex.map(item => item.id));
    const dimensions = rubricFromPolicy(review.evaluationPolicy).dimensions.map(id => {
      const raw = Array.isArray(parsed.scores) ? parsed.scores.find(item => isRecord(item) && item.id === id) : undefined;
      if (!isRecord(raw)) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', `复盘缺少维度 ${id}`);
      const score = raw.score === null ? null : Number(raw.score);
      if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', `维度 ${id} 评分无效`);
      return {
        id, score: score as ReviewDimensionScore['score'],
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 1_200) : '',
        evidenceRefs: uniqueStrings(raw.evidenceRefs).filter(ref => valid.has(ref)),
      };
    });
    const observations = (Array.isArray(parsed.observations) ? parsed.observations : []).flatMap<ReviewObservation>(raw => {
      if (!isRecord(raw) || (raw.kind !== 'positive' && raw.kind !== 'friction') || typeof raw.summary !== 'string') return [];
      const evidenceRefs = uniqueStrings(raw.evidenceRefs).filter(ref => valid.has(ref));
      if (!evidenceRefs.length) throw new ExperienceError(502, 'UNSUPPORTED_REVIEW_CLAIM', '复盘观察缺少有效证据');
      return [{ kind: raw.kind as ReviewObservation['kind'], summary: raw.summary.slice(0, 1_500), ...(typeof raw.cost === 'string' ? { cost: raw.cost.slice(0, 500) } : {}), evidenceRefs }];
    }).slice(0, 12);
    const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).flatMap<ReviewSuggestion>(raw => {
      if (!isRecord(raw) || typeof raw.title !== 'string' || typeof raw.detail !== 'string' || typeof raw.category !== 'string' || !SUGGESTION_CATEGORIES.has(raw.category as ReviewSuggestion['category'])) return [];
      const evidenceRefs = uniqueStrings(raw.evidenceRefs).filter(ref => valid.has(ref));
      if (!evidenceRefs.length) throw new ExperienceError(502, 'UNSUPPORTED_REVIEW_CLAIM', '复盘建议缺少有效证据');
      return [{
        id: stableHash({ title: raw.title, detail: raw.detail, evidenceRefs }).slice(0, 24),
        title: raw.title.slice(0, 300), detail: raw.detail.slice(0, 2_000),
        category: raw.category as ReviewSuggestion['category'],
        impact: (raw.impact === 'high' || raw.impact === 'low' ? raw.impact : 'medium') as ReviewSuggestion['impact'],
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
        evidenceRefs,
      }];
    }).slice(0, 10);
    const reuse = parsed.reuseIntent === null ? null : Number(parsed.reuseIntent);
    if (reuse !== null && (!Number.isInteger(reuse) || reuse < 1 || reuse > 5)) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '再次使用意愿评分无效');
    if (fast && suggestions.some(item => item.confidence < 0.5) && !uniqueStrings(parsed.evidenceGaps).length) {
      throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '低置信建议需要明确证据缺口');
    }
    return {
      dimensions, observations, suggestions,
      reuseIntent: reuse as StructuredReview['reuseIntent'],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      evidenceGaps: uniqueStrings(parsed.evidenceGaps, 8),
    };
  }

  private applyStructured(review: AIUserReview, structured: StructuredReview, valid: Set<string>): void {
    review.dimensions = structured.dimensions;
    review.observations = structured.observations.filter(item => item.evidenceRefs.some(ref => valid.has(ref)));
    review.suggestions = structured.suggestions.filter(item => item.evidenceRefs.some(ref => valid.has(ref)));
    review.reuseIntent = structured.reuseIntent;
    review.confidence = structured.confidence;
    review.evidenceGaps = structured.evidenceGaps;
    const critical = review.facts.anomalies.some(item => item.severity === 'P0' || item.severity === 'P1');
    const scores = review.dimensions.flatMap(item => item.score === null ? [] : [item.score]);
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const factGateFailed = ledgerGateFailed(review.facts) || critical;
    const policy = review.evaluationPolicy?.review;
    const positiveAverage = policy?.positiveMinAverage ?? 3.5;
    const positiveReuse = policy?.positiveMinReuse ?? 4;
    const positiveDimension = policy?.positiveMinDimension ?? 3;
    review.selfEvaluationBias = factGateFailed && average >= positiveAverage
      && review.reuseIntent !== null && review.reuseIntent >= positiveReuse
      ? {
          detected: true,
          reason: `事实门槛未通过，AI 主观平均 ${Math.round(average * 10) / 10}/5，再次使用意愿 ${review.reuseIntent}/5。`,
        }
      : undefined;
    if (factGateFailed || review.reuseIntent !== null && review.reuseIntent <= 2) {
      review.verdict = 'negative';
    } else if (!scores.length || scores.some(score => score < positiveDimension)
      || average < positiveAverage || review.reuseIntent === null || review.reuseIntent < positiveReuse) {
      review.verdict = 'neutral';
    } else {
      review.verdict = 'positive';
    }
  }

  private complete(review: AIUserReview): void {
    if (review.status === 'insufficient_evidence') {
      review.verdict = 'insufficient_evidence';
    }
    review.status = review.status === 'insufficient_evidence' ? 'insufficient_evidence' : 'completed';
    review.completedAt = this.now();
    review.updatedAt = this.now();
    this.deps.store.experience.putReview(review, review.requestKey);
    this.emitReview(review);
  }

  private account(review: AIUserReview, result: InvocationResult): void {
    review.budget.inputTokens += result.inputTokens;
    review.budget.outputTokens += result.outputTokens;
    review.budget.costUsd += result.costUsd;
    review.budget.costSource = result.costSource;
    review.calls++;
    const used = review.budget.inputTokens + review.budget.outputTokens;
    if (used > review.budget.totalTokenLimit) {
      throw new ExperienceError(422, 'TOKEN_BUDGET_EXCEEDED', `复盘用量 ${used} token 已超过 ${review.budget.totalTokenLimit} token 上限（输入 ${review.budget.inputTokens}，输出 ${review.budget.outputTokens}）`);
    }
  }

  private remainingInput(review: AIUserReview, preferred?: number): number {
    const remaining = Math.max(0, review.budget.inputTokenLimit - review.budget.inputTokens);
    return preferred === undefined ? remaining : Math.min(remaining, preferred);
  }

  private reviewMaxTokens(review: AIUserReview, provider: ProviderDef, model: string, messages: LLMMessage[]): number {
    const inputTokens = countMessageTokens(messages, provider.tokenizer);
    const remainingOutput = review.budget.outputTokenLimit - review.budget.outputTokens;
    const remainingTotal = review.budget.totalTokenLimit
      - review.budget.inputTokens
      - review.budget.outputTokens
      - inputTokens;
    const protocolCap = provider.models?.find(item => item.modelId === model)?.maxOutput;
    const limits = [remainingOutput, remainingTotal];
    if (protocolCap !== undefined && Number.isSafeInteger(protocolCap) && protocolCap > 0) limits.push(protocolCap);
    const maxTokens = Math.min(...limits);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw this.insufficient('复盘 token 预算不足以发起下一次模型调用');
    }
    return maxTokens;
  }

  private pickEvidence(review: AIUserReview, requested: string[], limit: number, tokenBudget: number): EvidenceSlice[] {
    const provider = providerFor(this.deps.providers(), review.providerId, review.model);
    const candidates = [...new Set([
      ...requested,
      ...review.facts.anomalies.flatMap(item => item.evidenceRefs),
      ...review.evidenceIndex.filter(item => item.kind === 'verification' || item.kind === 'artifact').map(item => item.id),
      ...review.evidenceIndex.filter(item => item.kind === 'answer' || item.kind === 'goal').map(item => item.id),
    ])];
    const selected: EvidenceSlice[] = [];
    let used = 0;
    for (const ref of candidates) {
      if (selected.length >= limit) break;
      const source = review.evidenceIndex.find(item => item.id === ref);
      if (!source) continue;
      const slice = this.loadEvidence(review, source, provider);
      if (!slice) continue;
      const cap = Math.min(EVIDENCE_SLICE_TOKEN_LIMIT, tokenBudget - used);
      if (cap < 60) break;
      const text = trimToTokens(slice.text, cap, provider?.tokenizer);
      const tokens = provider?.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text);
      if (used + tokens > tokenBudget) continue;
      selected.push({ ...slice, text, tokens, hash: stableHash(text) });
      used += tokens;
    }
    return selected;
  }

  private loadEvidence(review: AIUserReview, index: ReviewEvidenceRef, provider?: ProviderDef): EvidenceSlice | undefined {
    const run = this.deps.store.runs.get(index.runId, review.tenantId);
    if (!run) return undefined;
    const prefix = `run:${run.id}:`;
    if (!index.id.startsWith(prefix)) return undefined;
    const tail = index.id.slice(prefix.length);
    let value: unknown;
    if (tail === 'goal') value = run.objective;
    else if (tail === 'answer') value = run.answer ?? '';
    else if (tail === 'verification') value = run.verification;
    else if (tail === 'capability') value = run.capabilityResolution;
    else if (tail === 'rule') value = run.ruleResolution;
    else if (tail.startsWith('event:')) value = this.deps.store.runs.events(run.id).find(event => event.seq === Number(tail.slice(6)));
    else if (tail.startsWith('tool:')) {
      const id = tail.slice(5);
      const call = this.deps.store.runs.toolCalls(run.id).find(item => item.id === id);
      const page = this.deps.store.runs.readTool(run.id, id);
      value = call ? {
        ...call,
        resultExcerpt: page?.content?.slice(0, 3_000),
        result: page ? { length: page.length, offset: page.offset, nextOffset: page.nextOffset, truncated: page.truncated } : undefined,
      } : undefined;
    } else if (tail.startsWith('artifact:')) {
      value = this.deps.store.runs.artifacts(run.id).find(item => item.id === tail.slice(9));
    } else if (tail.startsWith('model:')) {
      value = this.deps.store.runs.modelCalls(run.id, 0, 100).find(item => item.id === tail.slice(6));
    }
    if (value === undefined) return undefined;
    const raw = jsonText(value);
    const cacheKey = stableHash({ id: index.id, raw });
    const cached = this.evidenceCache.get(cacheKey);
    if (cached) {
      this.evidenceCache.delete(cacheKey);
      this.evidenceCache.set(cacheKey, cached);
      return cached;
    }
    const text = trimToTokens(raw, EVIDENCE_SLICE_TOKEN_LIMIT, provider?.tokenizer);
    const slice: EvidenceSlice = {
      ref: index.id, label: index.label, text, hash: stableHash(text),
      tokens: provider?.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text),
    };
    this.evidenceCache.set(cacheKey, slice);
    if (this.evidenceCache.size > 256) this.evidenceCache.delete(this.evidenceCache.keys().next().value!);
    return slice;
  }

  private async invoke(provider: ProviderDef, model: string, messages: LLMMessage[], maxTokens: number, purpose: 'experience_review' | 'experience_audit', externalSignal?: AbortSignal): Promise<InvocationResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason ?? 'review_cancelled');
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let structured = false;
    try {
      for await (const chunk of callModel(provider, messages, {
        model,
        maxTokens,
        reasoningEffort: 'none',
        signal: controller.signal,
        ...(provider.capabilities?.structuredOutput ? { responseFormat: { type: 'json_object' as const } } : {}),
      }, purpose)) {
        if (chunk.type === 'delta') text += chunk.text;
        else if (chunk.type === 'usage') {
          if (!chunk.incomplete) {
            inputTokens = chunk.input;
            outputTokens = chunk.output;
          }
        } else if (chunk.type === 'done' && chunk.reason === 'length') {
          throw new ExperienceError(502, 'REVIEW_OUTPUT_TRUNCATED', '复盘模型输出达到长度上限');
        }
      }
      structured = true;
    } finally {
      externalSignal?.removeEventListener('abort', abort);
    }
    if (!structured || !text.trim()) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '复盘模型未返回有效内容');
    const estimatedInput = countMessageTokens(messages, provider.tokenizer);
    const estimatedOutput = provider.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text);
    const actualInput = inputTokens ?? estimatedInput;
    const actualOutput = outputTokens ?? estimatedOutput;
    const cost = estimateCost(provider, model, actualInput, actualOutput);
    return {
      text,
      inputTokens: actualInput,
      outputTokens: actualOutput,
      costUsd: cost.costUsd ?? 0,
      costSource: cost.costSource,
    };
  }

  private async invokeReview(review: AIUserReview, provider: ProviderDef, model: string, messages: LLMMessage[], signal: AbortSignal): Promise<InvocationResult> {
    const maxTokens = this.reviewMaxTokens(review, provider, model, messages);
    return this.invoke(provider, model, messages, maxTokens, 'experience_review', signal);
  }

  private insufficient(reason: string): ExperienceError {
    const error = new ExperienceError(422, 'INSUFFICIENT_EVIDENCE', reason);
    (error as ExperienceError & { evidenceGaps: string[] }).evidenceGaps = [reason];
    return error;
  }

  private suggestionSeverity(review: AIUserReview, suggestion: ReviewSuggestion): FindingSeverity {
    const refs = new Set(suggestion.evidenceRefs);
    const matched = review.facts.anomalies.filter(item => item.evidenceRefs.some(ref => refs.has(ref)));
    return matched.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]?.severity ?? (suggestion.impact === 'high' ? 'P2' : 'P3');
  }

  private emitReview(review: AIUserReview): void {
    this.deps.emit('experience.review.updated', {
      tenantId: review.tenantId, reviewId: review.id, status: review.status, verdict: review.verdict,
    }, review.id);
  }

  private emitFinding(finding: ExperienceFinding): void {
    this.deps.emit('experience.finding.updated', {
      tenantId: finding.tenantId, findingId: finding.id, status: finding.status, severity: finding.severity,
    }, finding.id);
  }
}

export function reviewScore(review: AIUserReview): number | null {
  return scoreOf(review);
}
