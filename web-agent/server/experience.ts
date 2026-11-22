import { randomUUID } from 'node:crypto';
import { callModel } from '../kernel/model-call';
import type { LLMMessage, ProviderDef } from '../kernel/types';
import { RUN_TERMINAL, type RunRecord } from '../kernel/run';
import { countMessageTokens, estimateTokens } from '../kernel/tokens';
import type { Store } from './db';
import { OrganizationService } from './services/organization/service';
import type { EvaluationVersion } from './organization-store';
import { ExperienceError } from './experience-error';
import type {
  AIUserReview,
  AIUserReviewEstimate,
  AIUserReviewRequest,
  AIUserReviewSummary,
  EvidenceRequest,
  EvidenceSlice,
  ExperienceFinding,
  ExperienceRegressionCase,
  FactLedger,
  FindingSeverity,
  FindingStatus,
  ReviewAudit,
  ReviewBudget,
  ReviewDimensionScore,
  ReviewEvidenceRef,
  ReviewObservation,
  ReviewPath,
  ReviewSuggestion,
} from './experience-store';

import {
  buildCachedFactLedger,
  buildEvidenceIndex,
  buildFactLedger,
  budgetFor,
  clusterMultiRunFacts,
  compactEvidenceIndex,
  estimateCost,
  hasFocusedSignal,
  ledgerGateFailed,
  modelPrice,
  providerFor,
  rubricFromPolicy,
  scoreOf,
} from './services/experience/facts';
import {
  isRecord,
  jsonText,
  parseJsonObject,
  severityRank,
  stableHash,
  terminal,
  trimToTokens,
  uniqueStrings,
  verificationStatus,
} from './services/experience/shared';

export { ExperienceError };
export { buildCachedFactLedger, buildEvidenceIndex, buildFactLedger };

const FOCUSED_INPUT_LIMIT = 8_000;
const FOCUSED_OUTPUT_LIMIT = 1_200;
const FOCUSED_TOTAL_LIMIT = 9_200;
const EVIDENCE_SLICE_TOKEN_LIMIT = 600;

const SUGGESTION_CATEGORIES = new Set<ReviewSuggestion['category']>([
  'capability',
  'tool-contract',
  'result-feedback',
  'state',
  'recovery',
  'context',
  'authorization',
  'performance',
  'artifact',
  'organization',
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
      runIds: selection.runs.map((run) => run.id),
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
      sourceRunIds: selection.runs.map((run) => run.id),
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
    if (review.status !== 'insufficient_evidence')
      throw new ExperienceError(409, 'REVIEW_NOT_DEEPENABLE', '只有证据不足的复盘可以继续深入分析');
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
    if (!['completed', 'insufficient_evidence'].includes(review.status))
      throw new ExperienceError(409, 'REVIEW_NOT_AUDITABLE', '完成复盘后才能独立复核');
    const providers = this.deps.providers();
    const provider = providerFor(providers, input.providerId ?? review.providerId, input.model ?? review.model);
    if (!provider || provider.id !== (input.providerId ?? review.providerId)) {
      throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复核模型不可用；请显式选择替代模型');
    }
    const model = input.model ?? review.model;
    const evidenceIds = new Set(review.evidenceIndex.map((item) => item.id));
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是独立复核者。核对 AI 用户复盘是否被事实账本和证据支持，不替它改写事实。只输出严格 JSON。' },
      {
        role: 'user',
        content: JSON.stringify({
          facts: review.facts,
          review: {
            verdict: review.verdict,
            dimensions: review.dimensions,
            observations: review.observations,
            suggestions: review.suggestions,
            reuseIntent: review.reuseIntent,
            confidence: review.confidence,
            evidenceGaps: review.evidenceGaps,
          },
          evidence: review.evidence.map((item) => ({ ref: item.ref, text: trimToTokens(item.text, 400, provider.tokenizer) })),
          validEvidenceRefs: [...evidenceIds],
          output: { verdict: 'agree|disagree|inconclusive', summary: 'string', correctedEvidenceRefs: ['valid refs'], confidence: '0..1' },
        }),
      },
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
      correctedEvidenceRefs: uniqueStrings(parsed.correctedEvidenceRefs).filter((ref) => evidenceIds.has(ref)),
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
    if (!['completed', 'insufficient_evidence'].includes(review.status))
      throw new ExperienceError(409, 'REVIEW_NOT_CALIBRATABLE', '完成复盘后才能人工校准');
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary || summary.length > 2_000) throw new ExperienceError(400, 'INVALID_CALIBRATION', '人工校准摘要不能为空且不能超过 2000 字');
    const verdict = input.verdict === 'agree' || input.verdict === 'disagree' ? input.verdict : 'inconclusive';
    const rubric = rubricFromPolicy(review.evaluationPolicy);
    const dimensions = Array.isArray(input.dimensions)
      ? input.dimensions
          .flatMap((item) => {
            if (!isRecord(item) || typeof item.id !== 'string' || typeof item.reason !== 'string') return [];
            const score = item.score === null ? null : Number(item.score);
            if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) return [];
            return [
              {
                id: item.id,
                score: score as ReviewDimensionScore['score'],
                reason: item.reason.slice(0, 1_000),
                evidenceRefs: uniqueStrings(item.evidenceRefs).filter((ref) =>
                  review.evidenceIndex.some((evidence) => evidence.id === ref),
                ),
              },
            ];
          })
          .slice(0, rubric.dimensions.length)
      : undefined;
    const audit: ReviewAudit = {
      id: randomUUID(),
      tenantId,
      reviewId: id,
      source: 'human',
      kind: 'calibration',
      providerId: 'human',
      model: 'human',
      verdict,
      summary,
      correctedEvidenceRefs: review.evidence.map((item) => item.ref).slice(0, 10),
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
    if (review.status !== 'completed' && review.status !== 'insufficient_evidence')
      throw new ExperienceError(409, 'REVIEW_NOT_ADOPTABLE', '完成复盘后才能采纳建议');
    const suggestion = review.suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) throw new ExperienceError(404, 'SUGGESTION_NOT_FOUND', '复盘建议不存在');
    if (suggestion.adoptedFindingId) {
      const existing = this.deps.store.experience.finding(suggestion.adoptedFindingId, tenantId);
      if (existing) return existing;
    }
    const fingerprint = stableHash({
      category: suggestion.category,
      title: suggestion.title.trim().toLowerCase(),
      evidenceKinds: suggestion.evidenceRefs
        .map((ref) => {
          const parts = ref.split(':');
          const nestedKind = parts.at(-2);
          return nestedKind && ['event', 'tool', 'artifact', 'model'].includes(nestedKind) ? nestedKind : (parts.at(-1) ?? ref);
        })
        .sort(),
    });
    const prior = this.deps.store.experience.findingByFingerprint(tenantId, fingerprint);
    const now = this.now();
    const priorReviewIds = prior ? (prior.reviewIds ?? [prior.reviewId]) : [];
    const finding: ExperienceFinding = prior
      ? {
          ...prior,
          reviewIds: [...new Set([...priorReviewIds, reviewId])],
          sourceRunIds: [...new Set([...prior.sourceRunIds, ...review.sourceRunIds])],
          evidenceRefs: [...new Set([...prior.evidenceRefs, ...suggestion.evidenceRefs])]
            .filter((ref) => review.evidenceIndex.some((item) => item.id === ref) || prior.evidenceRefs.includes(ref))
            .slice(0, 12),
          severity:
            severityRank(this.suggestionSeverity(review, suggestion)) < severityRank(prior.severity)
              ? this.suggestionSeverity(review, suggestion)
              : prior.severity,
          occurrences: (prior.occurrences ?? priorReviewIds.length) + (priorReviewIds.includes(reviewId) ? 0 : 1),
          updatedAt: now,
        }
      : {
          id: randomUUID(),
          tenantId,
          reviewId,
          suggestionId,
          fingerprint,
          reviewIds: [reviewId],
          title: suggestion.title,
          detail: suggestion.detail,
          category: suggestion.category,
          severity: this.suggestionSeverity(review, suggestion),
          status: 'new',
          evidenceRefs: suggestion.evidenceRefs.filter((ref) => review.evidenceIndex.some((item) => item.id === ref)).slice(0, 12),
          sourceRunIds: review.sourceRunIds,
          occurrences: 1,
          createdAt: now,
          updatedAt: now,
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
    return status
      ? this.deps.store.experience.findingsByStatus(tenantId, status, limit)
      : this.deps.store.experience.findings(tenantId, undefined, limit);
  }

  updateFinding(id: string, tenantId: string, status: FindingStatus, statusNote?: string): ExperienceFinding {
    const finding = this.deps.store.experience.finding(id, tenantId);
    if (!finding) throw new ExperienceError(404, 'FINDING_NOT_FOUND', '体验问题不存在');
    if (!FINDING_TRANSITIONS[finding.status].includes(status)) {
      throw new ExperienceError(409, 'INVALID_FINDING_TRANSITION', `问题不能从 ${finding.status} 直接变为 ${status}`);
    }
    if (status === 'closed') {
      const regressionPassed = this.deps.store.experience.regressions(id, tenantId).some((item) => item.status === 'passed');
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
    if (finding.status !== 'triaged' && finding.status !== 'new')
      throw new ExperienceError(409, 'FINDING_NOT_REPRODUCIBLE', '只有新问题或已分诊问题可以建立复现案例');
    const source = this.deps.store.runs.get(finding.sourceRunIds[0] ?? '', tenantId);
    if (!source) throw new ExperienceError(404, 'SOURCE_RUN_NOT_FOUND', '问题来源运行不存在');
    const now = this.now();
    const regression = {
      id: randomUUID(),
      tenantId,
      findingId: id,
      sourceRunIds: finding.sourceRunIds,
      objective: `隔离重放：${finding.title}`,
      expected: expected?.trim().slice(0, 4_000) || `复现“${finding.title}”，修复后不再出现该问题。`,
      evidenceRefs: finding.evidenceRefs,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
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
    if (!summary || summary.length > 2_000)
      throw new ExperienceError(400, 'INVALID_REGRESSION_RESULT', '回归结论不能为空且不能超过 2000 字');
    const regression = finding.regressionId
      ? this.deps.store.experience.regressions(finding.id, tenantId).find((item) => item.id === finding.regressionId)
      : this.deps.store.experience.regressions(finding.id, tenantId)[0];
    if (!regression) throw new ExperienceError(409, 'REGRESSION_NOT_FOUND', '体验问题没有可验证的回归案例');
    const evidenceRefs = [
      `run:${run.id}:goal`,
      ...(run.answer ? [`run:${run.id}:answer`] : []),
      ...(run.verification ? [`run:${run.id}:verification`] : []),
      ...this.deps.store.runs.artifacts(run.id).map((item) => `run:${run.id}:artifact:${item.id}`),
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
    const hasCriticalRegression =
      (finding.severity === 'P0' || finding.severity === 'P1') && regressions.some((item) => item.status === 'passed');
    if (!hasRepeatedEvidence && !hasCriticalRegression) {
      throw new ExperienceError(409, 'EVOLUTION_EVIDENCE_REQUIRED', '提交自进化需要至少两次复盘证据，或 P0/P1 问题的通过回归');
    }
    const regression = regressions.find((item) => item.status === 'passed');
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
    const scores = reviews.map(scoreOf).flatMap((value) => (value === null ? [] : [value]));
    return {
      undecidedFindings: findings.filter((item) => item.status === 'new' || item.status === 'triaged').length,
      openFindings: findings.filter((item) => !['closed', 'wont_fix'].includes(item.status)).length,
      adoptedFindings: findings.length,
      reviewCount: reviews.length,
      negativeReviews: reviews.filter((item) => item.verdict === 'negative').length,
      averageScore: scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : null,
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
    const runIds = [...new Set(request.runIds.filter((item) => typeof item === 'string' && item))];
    if (runIds.length !== request.runIds.length) throw new ExperienceError(400, 'INVALID_REVIEW_SCOPE', '复盘运行不能重复');
    const runs = runIds.map((id) => this.deps.store.runs.get(id, tenantId));
    if (runs.some((run) => !run)) throw new ExperienceError(404, 'RUN_NOT_FOUND', '所选运行不存在或不属于当前租户');
    const selected = runs as RunRecord[];
    if (selected.some((run) => !terminal(run))) throw new ExperienceError(409, 'RUN_ACTIVE', '只能复盘已结束的运行');
    const first = selected[0]!;
    if (selected.some((run) => run.providerId !== first.providerId || run.model !== first.model)) {
      throw new ExperienceError(400, 'MIXED_MODELS', '多运行复盘必须使用同一原始模型');
    }
    if (selected.some((run) => run.authorization.workspace !== first.authorization.workspace)) {
      throw new ExperienceError(400, 'MIXED_WORKSPACES', '多运行复盘必须属于同一工作区');
    }
    const providers = this.deps.providers();
    const policy = new OrganizationService({ store: this.deps.store, now: this.now }).ensureEvaluation(tenantId).record;
    const originalAvailable = !!providerFor(providers, first.providerId, first.model);
    const configuredProvider = (policy.review.providerId ?? '').trim();
    const configuredModel = (policy.review.model ?? '').trim();
    const explicitProvider = (typeof request.providerId === 'string' ? request.providerId : '').trim();
    const explicitModel = (typeof request.model === 'string' ? request.model : '').trim();
    if (!!explicitProvider !== !!explicitModel) throw new ExperienceError(400, 'INVALID_MODEL', '复盘模型必须同时提供供应商和模型名称');
    if (!originalAvailable && !explicitProvider && !configuredProvider && !allowUnavailable) {
      throw new ExperienceError(409, 'ORIGINAL_MODEL_UNAVAILABLE', '原工作模型不可用；请显式选择一个替代模型');
    }
    const requestedProvider = explicitProvider || configuredProvider;
    const requestedModel = explicitModel || configuredModel;
    if (!!requestedProvider !== !!requestedModel) throw new ExperienceError(400, 'INVALID_MODEL', '复盘模型必须同时提供供应商和模型名称');
    const providerId = requestedProvider || first.providerId;
    const model = requestedModel || first.model;
    const provider =
      providerFor(providers, providerId, model) ??
      (allowUnavailable
        ? ({
            id: providerId,
            label: 'Unavailable',
            defaultModel: model,
            priceSource: 'unknown' as const,
            async *chat() {},
          } satisfies ProviderDef)
        : undefined);
    if (!provider) {
      if (requireModel || requestedProvider) throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复盘模型当前不可用');
      throw new ExperienceError(409, 'MODEL_UNAVAILABLE', '复盘模型当前不可用');
    }
    const evaluation = new OrganizationService({ store: this.deps.store, now: this.now }).ensureEvaluation(tenantId);
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
      const validRefs = new Set(review.evidenceIndex.map((item) => item.id));
      let selectedEvidence = [...review.evidence];
      let structured: StructuredReview;
      if (review.path === 'fast') {
        selectedEvidence = this.pickEvidence(
          review,
          review.facts.anomalies.flatMap((item) => item.evidenceRefs),
          4,
          1_200,
        );
        structured = await this.fastReview(review, provider, model, selectedEvidence, signal);
      } else {
        const plan = await this.focusedPlan(review, provider, model, signal);
        if (signal.aborted) throw new ExperienceError(499, 'REVIEW_CANCELLED', '复盘已取消');
        const requested = plan.evidenceRefs.filter((ref) => validRefs.has(ref));
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

  private async fastReview(
    review: AIUserReview,
    provider: ProviderDef,
    model: string,
    evidence: EvidenceSlice[],
    signal: AbortSignal,
  ): Promise<StructuredReview> {
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
      {
        role: 'user',
        content: JSON.stringify({
          mode: 'evidence_plan',
          facts: review.facts,
          evidenceIndex: review.evidenceIndex,
          request: '只判断哪些维度需要验证，以及最多 6 个能改变评分或严重度的证据引用。不要评分。',
          limits: { refs: 6, hypotheses: 4, gaps: 3, text: '每项不超过 30 个汉字' },
          output: { evidenceRefs: ['<evidence id>'], evidenceGaps: ['string'], hypotheses: ['string'] },
        }),
      },
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

  private async focusedReview(
    review: AIUserReview,
    provider: ProviderDef,
    model: string,
    plan: EvidencePlan,
    evidence: EvidenceSlice[],
    signal: AbortSignal,
    _deepen: boolean,
  ): Promise<StructuredReview> {
    const messages = this.reviewMessages(review, evidence, plan.hypotheses, true);
    const available = this.remainingInput(review);
    if (countMessageTokens(messages, provider.tokenizer) > available) {
      const baseTokens = countMessageTokens(this.reviewMessages(review, [], plan.hypotheses, true), provider.tokenizer);
      const remainingEvidence = Math.max(0, available - baseTokens);
      const shrunk = evidence.map((item) => {
        const text = trimToTokens(
          item.text,
          Math.max(80, Math.floor(Math.max(0, remainingEvidence) / Math.max(1, evidence.length))),
          provider.tokenizer,
        );
        return { ...item, text, tokens: provider.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text) };
      });
      const retry = this.reviewMessages(review, shrunk, plan.hypotheses, true);
      if (countMessageTokens(retry, provider.tokenizer) > available) throw this.insufficient('证据片段超过聚焦复盘预算');
      return this.runFocusedFinal(review, provider, model, retry, signal);
    }
    return this.runFocusedFinal(review, provider, model, messages, signal);
  }

  private async runFocusedFinal(
    review: AIUserReview,
    provider: ProviderDef,
    model: string,
    messages: LLMMessage[],
    signal: AbortSignal,
  ): Promise<StructuredReview> {
    const result = await this.invokeReview(review, provider, model, messages, signal);
    this.account(review, result);
    return this.parseStructured(result.text, review, false);
  }

  private reviewMessages(
    review: AIUserReview,
    evidence: EvidenceSlice[],
    hypotheses: string[] | undefined,
    focused: boolean,
  ): LLMMessage[] {
    const rubric = rubricFromPolicy(review.evaluationPolicy);
    return [
      { role: 'system', content: rubric.systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          kind: 'review_input',
          facts: review.facts,
          evidence,
          ...(hypotheses?.length ? { hypotheses } : {}),
          rubric: rubric.dimensions,
          ...(focused ? { priorStep: '已根据异常和冲突主动取证；现在完成评分。' } : { priorStep: '事实清楚时直接复盘。' }),
          outputLimits: `scores 恰好 ${rubric.dimensions.length} 项；observations 最多 4 项；suggestions 最多 3 项；不输出额外键或解释。`,
          output: {
            scores: rubric.dimensions.map((id) => ({ id, score: '1..5 或 null', reason: 'string', evidenceRefs: ['valid evidence id'] })),
            observations: [{ kind: 'positive|friction', summary: 'string', cost: 'optional', evidenceRefs: ['valid evidence id'] }],
            suggestions: [
              {
                title: 'string',
                detail: 'string',
                category: [...SUGGESTION_CATEGORIES],
                impact: 'high|medium|low',
                confidence: '0..1',
                evidenceRefs: ['valid evidence id'],
              },
            ],
            reuseIntent: '1..5 或 null',
            confidence: '0..1',
            evidenceGaps: ['string'],
          },
        }),
      },
    ];
  }

  private parseStructured(text: string, review: AIUserReview, fast: boolean): StructuredReview {
    const parsed = parseJsonObject(text);
    const valid = new Set(review.evidenceIndex.map((item) => item.id));
    const dimensions = rubricFromPolicy(review.evaluationPolicy).dimensions.map((id) => {
      const raw = Array.isArray(parsed.scores) ? parsed.scores.find((item) => isRecord(item) && item.id === id) : undefined;
      if (!isRecord(raw)) throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', `复盘缺少维度 ${id}`);
      const score = raw.score === null ? null : Number(raw.score);
      if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5))
        throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', `维度 ${id} 评分无效`);
      return {
        id,
        score: score as ReviewDimensionScore['score'],
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 1_200) : '',
        evidenceRefs: uniqueStrings(raw.evidenceRefs).filter((ref) => valid.has(ref)),
      };
    });
    const observations = (Array.isArray(parsed.observations) ? parsed.observations : [])
      .flatMap<ReviewObservation>((raw) => {
        if (!isRecord(raw) || (raw.kind !== 'positive' && raw.kind !== 'friction') || typeof raw.summary !== 'string') return [];
        const evidenceRefs = uniqueStrings(raw.evidenceRefs).filter((ref) => valid.has(ref));
        if (!evidenceRefs.length) throw new ExperienceError(502, 'UNSUPPORTED_REVIEW_CLAIM', '复盘观察缺少有效证据');
        return [
          {
            kind: raw.kind as ReviewObservation['kind'],
            summary: raw.summary.slice(0, 1_500),
            ...(typeof raw.cost === 'string' ? { cost: raw.cost.slice(0, 500) } : {}),
            evidenceRefs,
          },
        ];
      })
      .slice(0, 12);
    const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .flatMap<ReviewSuggestion>((raw) => {
        // Models frequently emit `category` as a single-element array; accept both
        // shapes instead of silently dropping otherwise valid suggestions.
        const rawCategory = Array.isArray(raw?.category) ? raw.category[0] : raw?.category;
        if (
          !isRecord(raw) ||
          typeof raw.title !== 'string' ||
          typeof raw.detail !== 'string' ||
          typeof rawCategory !== 'string' ||
          !SUGGESTION_CATEGORIES.has(rawCategory as ReviewSuggestion['category'])
        )
          return [];
        const evidenceRefs = uniqueStrings(raw.evidenceRefs).filter((ref) => valid.has(ref));
        if (!evidenceRefs.length) throw new ExperienceError(502, 'UNSUPPORTED_REVIEW_CLAIM', '复盘建议缺少有效证据');
        return [
          {
            id: stableHash({ title: raw.title, detail: raw.detail, evidenceRefs }).slice(0, 24),
            title: raw.title.slice(0, 300),
            detail: raw.detail.slice(0, 2_000),
            category: rawCategory as ReviewSuggestion['category'],
            impact: (raw.impact === 'high' || raw.impact === 'low' ? raw.impact : 'medium') as ReviewSuggestion['impact'],
            confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
            evidenceRefs,
          },
        ];
      })
      .slice(0, 10);
    const reuse = parsed.reuseIntent === null ? null : Number(parsed.reuseIntent);
    if (reuse !== null && (!Number.isInteger(reuse) || reuse < 1 || reuse > 5))
      throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '再次使用意愿评分无效');
    if (fast && suggestions.some((item) => item.confidence < 0.5) && !uniqueStrings(parsed.evidenceGaps).length) {
      throw new ExperienceError(502, 'REVIEW_OUTPUT_INVALID', '低置信建议需要明确证据缺口');
    }
    return {
      dimensions,
      observations,
      suggestions,
      reuseIntent: reuse as StructuredReview['reuseIntent'],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      evidenceGaps: uniqueStrings(parsed.evidenceGaps, 8),
    };
  }

  private applyStructured(review: AIUserReview, structured: StructuredReview, valid: Set<string>): void {
    review.dimensions = structured.dimensions;
    review.observations = structured.observations.filter((item) => item.evidenceRefs.some((ref) => valid.has(ref)));
    review.suggestions = structured.suggestions.filter((item) => item.evidenceRefs.some((ref) => valid.has(ref)));
    review.reuseIntent = structured.reuseIntent;
    review.confidence = structured.confidence;
    review.evidenceGaps = structured.evidenceGaps;
    const critical = review.facts.anomalies.some((item) => item.severity === 'P0' || item.severity === 'P1');
    const scores = review.dimensions.flatMap((item) => (item.score === null ? [] : [item.score]));
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const factGateFailed = ledgerGateFailed(review.facts) || critical;
    const policy = review.evaluationPolicy?.review;
    const positiveAverage = policy?.positiveMinAverage ?? 3.5;
    const positiveReuse = policy?.positiveMinReuse ?? 4;
    const positiveDimension = policy?.positiveMinDimension ?? 3;
    review.selfEvaluationBias =
      factGateFailed && average >= positiveAverage && review.reuseIntent !== null && review.reuseIntent >= positiveReuse
        ? {
            detected: true,
            reason: `事实门槛未通过，AI 主观平均 ${Math.round(average * 10) / 10}/5，再次使用意愿 ${review.reuseIntent}/5。`,
          }
        : undefined;
    if (factGateFailed || (review.reuseIntent !== null && review.reuseIntent <= 2)) {
      review.verdict = 'negative';
    } else if (
      !scores.length ||
      scores.some((score) => score < positiveDimension) ||
      average < positiveAverage ||
      review.reuseIntent === null ||
      review.reuseIntent < positiveReuse
    ) {
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
      throw new ExperienceError(
        422,
        'TOKEN_BUDGET_EXCEEDED',
        `复盘用量 ${used} token 已超过 ${review.budget.totalTokenLimit} token 上限（输入 ${review.budget.inputTokens}，输出 ${review.budget.outputTokens}）`,
      );
    }
  }

  private remainingInput(review: AIUserReview, preferred?: number): number {
    const remaining = Math.max(0, review.budget.inputTokenLimit - review.budget.inputTokens);
    return preferred === undefined ? remaining : Math.min(remaining, preferred);
  }

  private reviewMaxTokens(review: AIUserReview, provider: ProviderDef, model: string, messages: LLMMessage[]): number {
    const inputTokens = countMessageTokens(messages, provider.tokenizer);
    const remainingOutput = review.budget.outputTokenLimit - review.budget.outputTokens;
    const remainingTotal = review.budget.totalTokenLimit - review.budget.inputTokens - review.budget.outputTokens - inputTokens;
    const modelCapability = provider.models?.find((item) => item.modelId === model);
    const protocolCap = modelCapability?.maxOutput;
    // The configured output number is a nominal target, not a hard ceiling:
    // verbose models and reasoning tokens otherwise exhaust it before the JSON
    // review body is complete. The total budget stays the hard cap, and the
    // provider's declared maxOutput is still enforced below.
    const headroom = Math.min(8_192, Math.max(2_048, protocolCap ?? 8_192));
    const outputLimit = Math.max(remainingOutput, Math.min(remainingTotal, headroom));
    const limits = [outputLimit, remainingTotal];
    if (protocolCap !== undefined && Number.isSafeInteger(protocolCap) && protocolCap > 0) limits.push(protocolCap);
    const maxTokens = Math.min(...limits);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw this.insufficient('复盘 token 预算不足以发起下一次模型调用');
    }
    return maxTokens;
  }

  private pickEvidence(review: AIUserReview, requested: string[], limit: number, tokenBudget: number): EvidenceSlice[] {
    const provider = providerFor(this.deps.providers(), review.providerId, review.model);
    const candidates = [
      ...new Set([
        ...requested,
        ...review.facts.anomalies.flatMap((item) => item.evidenceRefs),
        ...review.evidenceIndex.filter((item) => item.kind === 'verification' || item.kind === 'artifact').map((item) => item.id),
        ...review.evidenceIndex.filter((item) => item.kind === 'answer' || item.kind === 'goal').map((item) => item.id),
      ]),
    ];
    const selected: EvidenceSlice[] = [];
    let used = 0;
    for (const ref of candidates) {
      if (selected.length >= limit) break;
      const source = review.evidenceIndex.find((item) => item.id === ref);
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
    else if (tail.startsWith('event:')) value = this.deps.store.runs.events(run.id).find((event) => event.seq === Number(tail.slice(6)));
    else if (tail.startsWith('tool:')) {
      const id = tail.slice(5);
      const call = this.deps.store.runs.toolCalls(run.id).find((item) => item.id === id);
      const page = this.deps.store.runs.readTool(run.id, id);
      value = call
        ? {
            ...call,
            resultExcerpt: page?.content?.slice(0, 3_000),
            result: page ? { length: page.length, offset: page.offset, nextOffset: page.nextOffset, truncated: page.truncated } : undefined,
          }
        : undefined;
    } else if (tail.startsWith('artifact:')) {
      value = this.deps.store.runs.artifacts(run.id).find((item) => item.id === tail.slice(9));
    } else if (tail.startsWith('model:')) {
      value = this.deps.store.runs.modelCalls(run.id, 0, 100).find((item) => item.id === tail.slice(6));
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
      ref: index.id,
      label: index.label,
      text,
      hash: stableHash(text),
      tokens: provider?.tokenizer?.countText ? provider.tokenizer.countText(text) : estimateTokens(text),
    };
    this.evidenceCache.set(cacheKey, slice);
    if (this.evidenceCache.size > 256) this.evidenceCache.delete(this.evidenceCache.keys().next().value!);
    return slice;
  }

  private async invoke(
    provider: ProviderDef,
    model: string,
    messages: LLMMessage[],
    maxTokens: number,
    purpose: 'experience_review' | 'experience_audit',
    externalSignal?: AbortSignal,
  ): Promise<InvocationResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason ?? 'review_cancelled');
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let structured = false;
    try {
      for await (const chunk of callModel(
        provider,
        messages,
        {
          model,
          maxTokens,
          reasoningEffort: 'none',
          signal: controller.signal,
          ...(provider.capabilities?.structuredOutput ? { responseFormat: { type: 'json_object' as const } } : {}),
        },
        purpose,
      )) {
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

  private async invokeReview(
    review: AIUserReview,
    provider: ProviderDef,
    model: string,
    messages: LLMMessage[],
    signal: AbortSignal,
  ): Promise<InvocationResult> {
    const maxTokens = this.reviewMaxTokens(review, provider, model, messages);
    try {
      return await this.invoke(provider, model, messages, maxTokens, 'experience_review', signal);
    } catch (error) {
      // A model that truncates before emitting the complete JSON body is a budget
      // problem, not a semantic one: retry once with a doubled output cap. The
      // total-budget and provider ceilings below still bound the larger cap, and
      // the retry keeps a complete review from being discarded on a 502.
      if (error instanceof ExperienceError && error.code === 'REVIEW_OUTPUT_TRUNCATED' && signal && !signal.aborted) {
        const retryCap = Math.min(review.budget.totalTokenLimit, maxTokens * 2);
        return await this.invoke(provider, model, messages, retryCap, 'experience_review', signal);
      }
      throw error;
    }
  }

  private insufficient(reason: string): ExperienceError {
    const error = new ExperienceError(422, 'INSUFFICIENT_EVIDENCE', reason);
    (error as ExperienceError & { evidenceGaps: string[] }).evidenceGaps = [reason];
    return error;
  }

  private suggestionSeverity(review: AIUserReview, suggestion: ReviewSuggestion): FindingSeverity {
    const refs = new Set(suggestion.evidenceRefs);
    const matched = review.facts.anomalies.filter((item) => item.evidenceRefs.some((ref) => refs.has(ref)));
    return (
      matched.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]?.severity ??
      (suggestion.impact === 'high' ? 'P2' : 'P3')
    );
  }

  private emitReview(review: AIUserReview): void {
    this.deps.emit(
      'experience.review.updated',
      {
        tenantId: review.tenantId,
        reviewId: review.id,
        status: review.status,
        verdict: review.verdict,
      },
      review.id,
    );
  }

  private emitFinding(finding: ExperienceFinding): void {
    this.deps.emit(
      'experience.finding.updated',
      {
        tenantId: finding.tenantId,
        findingId: finding.id,
        status: finding.status,
        severity: finding.severity,
      },
      finding.id,
    );
  }
}

export function reviewScore(review: AIUserReview): number | null {
  return scoreOf(review);
}
