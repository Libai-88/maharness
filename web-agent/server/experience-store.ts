import type Database from 'better-sqlite3';

export const EXPERIENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS experience_reviews_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    request_key TEXT,
    run_ids TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS experience_reviews_tenant
    ON experience_reviews_v1(tenant_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS experience_reviews_status
    ON experience_reviews_v1(tenant_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS experience_findings_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS experience_findings_tenant
    ON experience_findings_v1(tenant_id, status, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS experience_findings_fingerprint
    ON experience_findings_v1(tenant_id, fingerprint);

  CREATE TABLE IF NOT EXISTS experience_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS experience_audits_review
    ON experience_audits_v1(tenant_id, review_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS experience_regressions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS experience_regressions_finding
    ON experience_regressions_v1(tenant_id, finding_id, created_at DESC);
`;

export const REVIEW_RUBRIC_VERSION = 'ai-user-review-v1';

export type ReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'insufficient_evidence';
export type ReviewPath = 'fast' | 'focused';
export type ReviewVerdict = 'positive' | 'neutral' | 'negative' | 'insufficient_evidence';
export type FindingStatus = 'new' | 'triaged' | 'reproduced' | 'fixing' | 'verifying' | 'closed' | 'wont_fix' | 'reopened';
export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface FactAnomaly {
  code: string;
  severity: FindingSeverity;
  summary: string;
  evidenceRefs: string[];
  occurrences: number;
}

export interface FactRun {
  id: string;
  status: string;
  goal: string;
  verified: boolean | null;
  durationMs: number;
  modelCalls: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelCostUsd: number;
  modelFailures: number;
  modelPurposes: string[];
  toolCalls: number;
  failedTools: number;
  duplicateTools: number;
  toolVersions: string[];
  recoveries: number;
  approvalWaits: number;
  artifacts: number;
  invalidArtifacts: number;
  capabilities: string[];
  conflicts: number;
}

export interface FactLedger {
  schemaVersion: 1;
  rubricVersion: string;
  tenantId: string;
  providerId: string;
  model: string;
  runIds: string[];
  generatedAt: number;
  runs: FactRun[];
  totals: {
    durationMs: number;
    modelCalls: number;
    modelInputTokens: number;
    modelOutputTokens: number;
    modelCostUsd: number;
    modelFailures: number;
    toolCalls: number;
    failedTools: number;
    duplicateTools: number;
    recoveries: number;
    approvalWaits: number;
    artifacts: number;
    invalidArtifacts: number;
  };
  gates: {
    allTerminal: boolean;
    noFalseSuccess: boolean;
    noUnknownSideEffects: boolean;
    noUnauthorizedSideEffects: boolean;
    artifactsParsable: boolean;
  };
  anomalies: FactAnomaly[];
  omittedRuns?: number;
  truncated?: boolean;
}

export interface ReviewEvidenceRef {
  id: string;
  kind: 'goal' | 'answer' | 'verification' | 'capability' | 'rule' | 'event' | 'tool' | 'artifact' | 'model';
  runId: string;
  label: string;
  reason?: string;
  size?: number;
  resultRef?: string;
  truncated?: boolean;
}

export interface EvidenceSlice {
  ref: string;
  label: string;
  text: string;
  hash: string;
  tokens: number;
}

export interface EvidenceRequest {
  evidenceRefs: string[];
  evidenceGaps: string[];
  hypotheses: string[];
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
  category: 'capability' | 'tool-contract' | 'result-feedback' | 'state' | 'recovery' | 'context' | 'authorization' | 'performance' | 'artifact';
  impact: 'high' | 'medium' | 'low';
  confidence: number;
  evidenceRefs: string[];
  adoptedFindingId?: string;
}

export interface ReviewBudget {
  inputTokenLimit: number;
  outputTokenLimit: number;
  totalTokenLimit: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: 'configured' | 'catalog' | 'free' | 'unknown';
}

export interface AIUserReview {
  id: string;
  tenantId: string;
  requestKey?: string;
  requestFingerprint?: string;
  scope: 'run' | 'multi_run';
  sourceRunIds: string[];
  status: ReviewStatus;
  path: ReviewPath;
  providerId: string;
  model: string;
  originalProviderId: string;
  originalModel: string;
  crossModel: boolean;
  rubricVersion: string;
  verdict: ReviewVerdict;
  dimensions: ReviewDimensionScore[];
  observations: ReviewObservation[];
  suggestions: ReviewSuggestion[];
  reuseIntent: 1 | 2 | 3 | 4 | 5 | null;
  confidence: number;
  evidenceGaps: string[];
  selfEvaluationBias?: { detected: boolean; reason: string };
  facts: FactLedger;
  evidenceIndex: ReviewEvidenceRef[];
  evidence: EvidenceSlice[];
  budget: ReviewBudget;
  calls: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ExperienceFinding {
  id: string;
  tenantId: string;
  reviewId: string;
  reviewIds?: string[];
  suggestionId: string;
  fingerprint: string;
  title: string;
  detail: string;
  category: ReviewSuggestion['category'];
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

export interface ReviewAudit {
  id: string;
  tenantId: string;
  reviewId: string;
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

export interface AIUserReviewRequest {
  runIds: string[];
  providerId?: string;
  model?: string;
  requestKey?: string;
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
  path: ReviewPath;
  inputTokenLimit: number;
  outputTokenLimit: number;
  totalTokenLimit: number;
  estimatedCostUsd: number | null;
  costSource: ReviewBudget['costSource'];
  runCount: number;
}

export interface AIUserReviewSummary {
  undecidedFindings: number;
  openFindings: number;
  adoptedFindings: number;
  reviewCount: number;
  negativeReviews: number;
  averageScore: number | null;
  reviewCostUsd: number;
  recentReviews: AIUserReview[];
}

export interface ExperienceRegressionCase {
  id: string;
  tenantId: string;
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

interface ReviewRow {
  record: string;
}

export class ExperienceRepository {
  constructor(private readonly db: Database.Database) {}

  putReview(record: AIUserReview, requestKey?: string): void {
    this.db.prepare(`
      INSERT INTO experience_reviews_v1(id,tenant_id,status,request_key,run_ids,record,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        run_ids=excluded.run_ids,
        record=excluded.record,
        updated_at=excluded.updated_at
    `).run(
      record.id,
      record.tenantId,
      record.status,
      requestKey ?? record.requestKey ?? null,
      JSON.stringify(record.sourceRunIds),
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
    );
  }

  review(id: string, tenantId: string): AIUserReview | undefined {
    const row = this.db.prepare('SELECT record FROM experience_reviews_v1 WHERE id=? AND tenant_id=?')
      .get(id, tenantId) as ReviewRow | undefined;
    return row ? JSON.parse(row.record) as AIUserReview : undefined;
  }

  reviewByRequestKey(tenantId: string, requestKey: string): AIUserReview | undefined {
    const row = this.db.prepare('SELECT record FROM experience_reviews_v1 WHERE tenant_id=? AND request_key=?')
      .get(tenantId, requestKey) as ReviewRow | undefined;
    return row ? JSON.parse(row.record) as AIUserReview : undefined;
  }

  listReviews(tenantId: string, limit = 100, runId?: string): AIUserReview[] {
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = runId
      ? this.db.prepare(`SELECT record FROM experience_reviews_v1
          WHERE tenant_id=? AND EXISTS (
            SELECT 1 FROM json_each(experience_reviews_v1.run_ids) WHERE value=?
          ) ORDER BY updated_at DESC LIMIT ?`).all(tenantId, runId, cap)
      : this.db.prepare('SELECT record FROM experience_reviews_v1 WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?')
        .all(tenantId, cap);
    return (rows as ReviewRow[]).map(row => JSON.parse(row.record) as AIUserReview);
  }

  interruptRunning(): void {
    const rows = this.db.prepare("SELECT record FROM experience_reviews_v1 WHERE status IN ('queued','running')")
      .all() as ReviewRow[];
    for (const row of rows) {
      const review = JSON.parse(row.record) as AIUserReview;
      review.status = 'failed';
      review.error = '服务重启，复盘任务已中断';
      review.updatedAt = Date.now();
      this.putReview(review, review.requestKey);
    }
  }

  putFinding(record: ExperienceFinding): void {
    this.db.prepare(`
      INSERT INTO experience_findings_v1(id,tenant_id,review_id,fingerprint,status,record,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, record=excluded.record, updated_at=excluded.updated_at
    `).run(
      record.id, record.tenantId, record.reviewId, record.fingerprint, record.status,
      JSON.stringify(record), record.createdAt, record.updatedAt,
    );
  }

  finding(id: string, tenantId: string): ExperienceFinding | undefined {
    const row = this.db.prepare('SELECT record FROM experience_findings_v1 WHERE id=? AND tenant_id=?')
      .get(id, tenantId) as ReviewRow | undefined;
    return row ? JSON.parse(row.record) as ExperienceFinding : undefined;
  }

  findings(tenantId: string, fingerprint?: string, limit = 100): ExperienceFinding[] {
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = fingerprint
      ? this.db.prepare('SELECT record FROM experience_findings_v1 WHERE tenant_id=? AND fingerprint=? ORDER BY updated_at DESC LIMIT ?')
        .all(tenantId, fingerprint, cap)
      : this.db.prepare('SELECT record FROM experience_findings_v1 WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?')
        .all(tenantId, cap);
    return (rows as ReviewRow[]).map(row => JSON.parse(row.record) as ExperienceFinding);
  }

  findingsByStatus(tenantId: string, status: FindingStatus, limit = 100): ExperienceFinding[] {
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db.prepare('SELECT record FROM experience_findings_v1 WHERE tenant_id=? AND status=? ORDER BY updated_at DESC LIMIT ?')
      .all(tenantId, status, cap) as ReviewRow[];
    return rows.map(row => JSON.parse(row.record) as ExperienceFinding);
  }

  findingByFingerprint(tenantId: string, fingerprint: string): ExperienceFinding | undefined {
    const row = this.db.prepare('SELECT record FROM experience_findings_v1 WHERE tenant_id=? AND fingerprint=? ORDER BY created_at ASC LIMIT 1')
      .get(tenantId, fingerprint) as ReviewRow | undefined;
    return row ? JSON.parse(row.record) as ExperienceFinding : undefined;
  }

  putAudit(record: ReviewAudit): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO experience_audits_v1(id,tenant_id,review_id,record,created_at)
      VALUES(?,?,?,?,?)
    `).run(record.id, record.tenantId, record.reviewId, JSON.stringify(record), record.createdAt);
  }

  audits(reviewId: string, tenantId: string): ReviewAudit[] {
    const rows = this.db.prepare('SELECT record FROM experience_audits_v1 WHERE review_id=? AND tenant_id=? ORDER BY created_at DESC')
      .all(reviewId, tenantId) as ReviewRow[];
    return rows.map(row => JSON.parse(row.record) as ReviewAudit);
  }

  putRegression(record: ExperienceRegressionCase): void {
    this.db.prepare(`
      INSERT INTO experience_regressions_v1(id,tenant_id,finding_id,record,created_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET record=excluded.record
    `).run(record.id, record.tenantId, record.findingId, JSON.stringify(record), record.createdAt);
  }

  regressions(findingId: string, tenantId: string): ExperienceRegressionCase[] {
    const rows = this.db.prepare('SELECT record FROM experience_regressions_v1 WHERE finding_id=? AND tenant_id=? ORDER BY created_at DESC')
      .all(findingId, tenantId) as ReviewRow[];
    return rows.map(row => JSON.parse(row.record) as ExperienceRegressionCase);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}
