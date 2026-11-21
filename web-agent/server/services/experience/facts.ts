import type { ProviderDef } from '../../../kernel/types';
import { estimateTokens } from '../../../kernel/tokens';
import type { RunRecord } from '../../../kernel/run';
import type { Store } from '../../db';
import type { EvaluationVersion } from '../../organization-store';
import { REVIEW_DIMENSIONS, REVIEW_RUBRIC_VERSION, REVIEW_SYSTEM_PROMPT } from '../../review-rubric';
import type {
  AIUserReview,
  FactAnomaly,
  FactLedger,
  FactRun,
  ReviewBudget,
  ReviewEvidenceRef,
} from '../../experience-store';
import {
  jsonText,
  severityRank,
  stableHash,
  terminal,
  trimToTokens,
  verificationStatus,
} from './shared';

const FAST_INPUT_LIMIT = 4_000;
const FAST_OUTPUT_LIMIT = 4_000;
const FAST_TOTAL_LIMIT = 8_000;
const FOCUSED_INPUT_LIMIT = 8_000;
const FOCUSED_OUTPUT_LIMIT = 6_000;
const FOCUSED_TOTAL_LIMIT = 14_000;
const MULTI_INPUT_LIMIT = 10_000;
const MULTI_OUTPUT_LIMIT = 6_000;
const MULTI_TOTAL_LIMIT = 16_000;
const FACT_LEDGER_TOKEN_LIMIT = 1_200;

/** Fact ledger, evidence index, pricing and review-budget helpers. */

export interface ReviewRubric {
  version: string;
  dimensions: string[];
  systemPrompt: string;
  hash: string;
}

export function rubricFromPolicy(policy?: EvaluationVersion['record']): ReviewRubric {
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

export function modelPrice(provider: ProviderDef, model: string): { input: number; output: number; source: ReviewBudget['costSource'] } | undefined {
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

export function estimateCost(provider: ProviderDef, model: string, inputTokens: number, outputTokens: number): { costUsd: number | null; costSource: ReviewBudget['costSource'] } {
  const price = modelPrice(provider, model);
  return price
    ? { costUsd: (inputTokens * price.input + outputTokens * price.output) / 1e6, costSource: price.source }
    : { costUsd: null, costSource: 'unknown' };
}

export function providerFor(providers: ProviderDef[], providerId: string, model: string): ProviderDef | undefined {
  const provider = providers.find(item => item.id === providerId);
  if (!provider) return undefined;
  if (model === provider.defaultModel) return provider;
  return provider.models?.some(item => item.modelId === model && item.enabled) ? provider : undefined;
}

export function aggregateAnomaly(map: Map<string, FactAnomaly>, anomaly: Omit<FactAnomaly, 'evidenceRefs' | 'occurrences'> & { evidenceRefs: string[] }): void {
  const key = `${anomaly.severity}:${anomaly.code}:${anomaly.summary}`;
  const current = map.get(key);
  if (current) {
    current.evidenceRefs = [...new Set([...current.evidenceRefs, ...anomaly.evidenceRefs])].slice(0, 12);
    current.occurrences++;
    return;
  }
  map.set(key, { ...anomaly, evidenceRefs: [...new Set(anomaly.evidenceRefs)].slice(0, 12), occurrences: 1 });
}

export function loadFactSources(store: Store, runs: RunRecord[]) {
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

export function buildFactLedgerFromSources(
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

export function compactFactLedger(input: FactLedger): FactLedger {
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

export function clusterMultiRunFacts(input: FactLedger): FactLedger {
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

export function compactEvidenceIndex(index: ReviewEvidenceRef[], facts: FactLedger): ReviewEvidenceRef[] {
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

export function ledgerGateFailed(facts: FactLedger): boolean {
  return Object.values(facts.gates).some(value => !value);
}

export function hasFocusedSignal(facts: FactLedger, factsIncomplete: boolean): boolean {
  return factsIncomplete || facts.runIds.length > 1 || facts.anomalies.length > 0 || ledgerGateFailed(facts);
}

export function budgetFor(
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

export function scoreOf(review: AIUserReview): number | null {
  const values = review.dimensions.flatMap(item => item.score === null ? [] : [item.score]);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
}
