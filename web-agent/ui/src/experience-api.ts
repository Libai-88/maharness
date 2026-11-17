import { api } from './api';
import type { RunInfo } from './run-api';

export type ExperienceReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'insufficient_evidence';
export type ExperienceVerdict = 'positive' | 'neutral' | 'negative' | 'insufficient_evidence';
export type FindingStatus = 'new' | 'triaged' | 'reproduced' | 'fixing' | 'verifying' | 'closed' | 'wont_fix' | 'reopened';
export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface FactAnomaly {
  code: string;
  severity: FindingSeverity;
  summary: string;
  evidenceRefs: string[];
  occurrences: number;
}

export interface FactLedger {
  schemaVersion: 1;
  rubricVersion: string;
  runIds: string[];
  generatedAt: number;
  runs: Array<{
    id: string; status: string; goal: string; verified: boolean | null; durationMs: number;
    modelCalls: number; modelInputTokens?: number; modelOutputTokens?: number; modelCostUsd?: number;
    modelFailures?: number; modelPurposes?: string[]; toolCalls: number; failedTools: number;
    duplicateTools: number; toolVersions?: string[]; recoveries: number; approvalWaits: number;
    artifacts: number; invalidArtifacts: number; capabilities: string[]; conflicts: number;
  }>;
  totals: {
    durationMs: number; modelCalls: number; modelInputTokens?: number; modelOutputTokens?: number;
    modelCostUsd?: number; modelFailures?: number; toolCalls: number; failedTools: number;
    duplicateTools: number; recoveries: number; approvalWaits: number; artifacts: number;
    invalidArtifacts: number;
  };
  gates: { allTerminal: boolean; noFalseSuccess: boolean; noUnknownSideEffects: boolean; noUnauthorizedSideEffects: boolean; artifactsParsable: boolean };
  anomalies: FactAnomaly[];
  omittedRuns?: number;
  truncated?: boolean;
}

export interface ReviewEvidenceRef {
  id: string;
  kind: string;
  runId: string;
  label: string;
}

export interface ReviewDimensionScore {
  id: string;
  score: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
  evidenceRefs: string[];
}

export interface ReviewObservation {
  kind: 'positive' | 'friction';
  summary: string;
  cost?: string;
  evidenceRefs: string[];
}

export interface ReviewSuggestion {
  id: string;
  title: string;
  detail: string;
  category: string;
  impact: 'high' | 'medium' | 'low';
  confidence: number;
  evidenceRefs: string[];
  adoptedFindingId?: string;
}

export interface AIUserReview {
  id: string;
  tenantId: string;
  scope: 'run' | 'multi_run';
  sourceRunIds: string[];
  status: ExperienceReviewStatus;
  path: 'fast' | 'focused';
  providerId: string;
  model: string;
  originalProviderId: string;
  originalModel: string;
  crossModel: boolean;
  rubricVersion: string;
  evaluationVersion?: number;
  evaluationHash?: string;
  verdict: ExperienceVerdict;
  dimensions: ReviewDimensionScore[];
  observations: ReviewObservation[];
  suggestions: ReviewSuggestion[];
  reuseIntent: number | null;
  confidence: number;
  evidenceGaps: string[];
  selfEvaluationBias?: { detected: boolean; reason: string };
  facts: FactLedger;
  evidenceIndex: ReviewEvidenceRef[];
  evidence: Array<{ ref: string; label: string; text: string; hash: string; tokens: number }>;
  budget: { inputTokenLimit: number; outputTokenLimit: number; totalTokenLimit: number; inputTokens: number; outputTokens: number; costUsd: number; costSource: string };
  calls: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExperienceAudit {
  id: string;
  source: 'ai' | 'human';
  kind: 'independent_review' | 'calibration';
  providerId: string;
  model: string;
  verdict: 'agree' | 'disagree' | 'inconclusive';
  summary: string;
  correctedEvidenceRefs: string[];
  dimensions?: ReviewDimensionScore[];
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  createdAt: number;
}

export interface ExperienceFinding {
  id: string;
  reviewId: string;
  reviewIds?: string[];
  suggestionId: string;
  title: string;
  detail: string;
  category: string;
  severity: FindingSeverity;
  status: FindingStatus;
  evidenceRefs: string[];
  sourceRunIds: string[];
  occurrences?: number;
  regressionId?: string;
  evolutionProposalId?: string;
  evolutionSubmittedAt?: number;
  statusNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExperienceRegressionCase {
  id: string;
  findingId: string;
  sourceRunIds: string[];
  objective: string;
  expected: string;
  evidenceRefs: string[];
  status: 'ready' | 'running' | 'passed' | 'failed';
  verificationRunId?: string;
  resultSummary?: string;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AIUserReviewEstimate {
  providerId: string;
  model: string;
  originalProviderId: string;
  originalModel: string;
  crossModel: boolean;
  available: boolean;
  requiresExplicitModel: boolean;
  scope: 'run' | 'multi_run';
  path: 'fast' | 'focused';
  evaluationVersion: number;
  evaluationHash: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  totalTokenLimit: number;
  estimatedCostUsd: number | null;
  costSource: string;
  runCount: number;
}

export const experienceApi = {
  estimate: (runIds: string[], alternative?: { providerId: string; model: string }) => api<AIUserReviewEstimate>('/api/experience/reviews/estimate', {
    method: 'POST',
    body: JSON.stringify({ runIds, ...alternative }),
  }),
  create: (runIds: string[], alternative?: { providerId: string; model: string }) => api<{ review: AIUserReview }>('/api/experience/reviews', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ runIds, ...alternative }),
  }),
  list: (runId?: string) => api<{ reviews: AIUserReview[] }>(`/api/experience/reviews?limit=100${runId ? `&runId=${encodeURIComponent(runId)}` : ''}`),
  detail: (id: string) => api<{ review: AIUserReview; audits: ExperienceAudit[]; findings: ExperienceFinding[] }>(`/api/experience/reviews/${encodeURIComponent(id)}`),
  cancel: (id: string) => api<{ review: AIUserReview }>(`/api/experience/reviews/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  deepen: (id: string) => api<{ review: AIUserReview }>(`/api/experience/reviews/${encodeURIComponent(id)}/deepen`, { method: 'POST' }),
  audit: (id: string, alternative?: { providerId: string; model: string }) => api<{ audit: ExperienceAudit }>(`/api/experience/reviews/${encodeURIComponent(id)}/audit`, {
    method: 'POST',
    body: JSON.stringify(alternative ?? {}),
  }),
  calibrate: (id: string, body: { verdict: string; summary: string; dimensions?: ReviewDimensionScore[] }) => api<{ audit: ExperienceAudit }>(`/api/experience/reviews/${encodeURIComponent(id)}/calibrate`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  adopt: (reviewId: string, suggestionId: string) => api<{ finding: ExperienceFinding }>(`/api/experience/reviews/${encodeURIComponent(reviewId)}/suggestions/${encodeURIComponent(suggestionId)}/adopt`, { method: 'POST' }),
  models: () => api<Array<{ provider: string; model: string }>>('/api/models'),
  findings: (status?: FindingStatus) => api<{ findings: ExperienceFinding[] }>(`/api/experience/findings?limit=100${status ? `&status=${status}` : ''}`),
  updateFinding: (id: string, status: FindingStatus, statusNote?: string) => api<{ finding: ExperienceFinding }>(`/api/experience/findings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, statusNote }),
  }),
  reproduceFinding: (id: string, expected?: string) => api<{ finding: ExperienceFinding; regression: ExperienceRegressionCase }>(`/api/experience/findings/${encodeURIComponent(id)}/reproduce`, {
    method: 'POST',
    body: JSON.stringify({ expected }),
  }),
  verifyFinding: (id: string, body: { outcome: 'passed' | 'failed'; runId: string; summary: string }) => api<{ finding: ExperienceFinding; regression: ExperienceRegressionCase }>(`/api/experience/findings/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  evolveFinding: (id: string) => api<{ finding: ExperienceFinding }>(`/api/experience/findings/${encodeURIComponent(id)}/evolve`, {
    method: 'POST',
  }),
};

export type ExperienceSourceRun = RunInfo;
