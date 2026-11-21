import { api } from './api';
import type { Material } from './material-api';
import type { RunArtifact, RunInfo } from './run-api';
import type { ExperienceFinding, ExperienceReviewStatus, ExperienceVerdict } from './experience-api';

export interface WorkbenchItem {
  id: string;
  title: string;
  note?: string;
  due?: string;
  dueTime?: string;
  lifecycle: string;
  revision: number;
  attempts?: { runId: string; status: string }[];
}

export interface WorkbenchAutomation {
  id: string;
  name: string;
  prompt: string;
  state: string;
  approval: string;
  nextDueAt?: number;
  lastTriggeredAt?: number;
  revision: number;
  trigger: Record<string, unknown>;
}

export interface WorkbenchProject {
  id: string;
  name: string;
  stage: string;
  next: string;
  blocker: string;
  status: 'active' | 'blocked' | 'done';
  updatedAt: number;
}

export interface WorkbenchNote {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationRoleView {
  id: string;
  projectId: string;
  name: string;
  responsibilities: string[];
  capabilities: string[];
  persistent: boolean;
  employment: 'active' | 'paused';
  source: 'builtin' | 'project' | 'human';
  budgetLimitUsd?: number;
  revision: number;
  updatedAt: number;
}

export interface WorkContractView {
  id: string;
  workOrderId: string;
  teamCycleId?: string;
  roleId: string;
  runId?: string;
  branchObjective: string;
  expectedArtifacts: string[];
  acceptance: { statement: string }[];
  dependsOn: string[];
  budgetUsd?: number;
  status: string;
  delivery?: {
    summary: string;
    artifacts: string[];
    evidence: { id: string; ref: string }[];
    unfinished: string[];
    costUsd: number;
    usageKnown: boolean;
  };
}

export interface WorkReceiptView {
  costStatus?: 'known' | 'partial' | 'unknown';
  id: string;
  workOrderId: string;
  status: string;
  answer: string;
  artifacts: string[];
  sources: { id: string; ref: string }[];
  contributors: { roleId: string; contractId: string; summary: string }[];
  costUsd: number;
  cacheSavingsUsd?: number;
  unfinished: string[];
  exceptions: string[];
  usageKnown: boolean;
  updatedAt: number;
}

export interface SocietyRoleWellbeingView {
  roleId: string;
  activeAssignments: number;
  consecutiveFailures: number;
  waitingApproval: number;
  reworkAssignments: number;
  contextPressure: 'unknown' | 'normal' | 'high';
  state: 'ready' | 'busy' | 'waiting' | 'resting';
  lastFailureAt?: number;
  failureBackoffUntil?: number;
  updatedAt: number;
}

export interface WorkOrderView {
  id: string;
  projectId: string;
  sessionId: string;
  rootRunId: string;
  objective: string;
  budgetUsd?: number;
  status: string;
  createdAt: number;
  updatedAt: number;
  contracts: WorkContractView[];
  teamCycles: Array<{
    id: string;
    assignmentIds: string[];
    soloEstimateUsd?: number;
    teamEstimateUsd?: number;
    status: string;
  }>;
  roles: OrganizationRoleView[];
  receipt?: WorkReceiptView;
  exceptions: OrganizationExceptionView[];
  economics: {
    singleAgentEstimateUsd: number | null;
    teamEstimateUsd: number | null;
    actualCostUsd: number;
    costStatus?: 'known' | 'partial' | 'unknown';
    cacheSavingsUsd: number | null;
    duplicateEvidenceReads: number;
    coordinationRounds: number;
    roi: number | null;
    fallbackReason?: string;
    usageKnown: boolean;
  };
  scorecards: OrganizationScorecardView[];
  wellbeing: SocietyRoleWellbeingView[];
}

export interface OrganizationExceptionView {
  id: string;
  workOrderId: string;
  contractId?: string;
  kind: string;
  summary: string;
  facts: string[];
  factRuling: string;
  requiresHuman: boolean;
  recovery: string;
  status: string;
  humanDecision?: string;
  updatedAt: number;
}

export interface OrganizationScorecardView {
  roleId: string;
  evaluationVersion: number;
  evaluationHash: string;
  sampleSize: number;
  confidence: string;
  completionRate: number | null;
  acceptanceRate: number | null;
  reworkRate: number | null;
  budgetCompliance: number | null;
  recoveryRate: number | null;
  evidenceCompleteness: number | null;
  reviewConsistency: number | null;
  costUsd: number;
}

export interface WorkbenchSummary {
  schemaVersion: 1;
  today: string;
  todayItems: WorkbenchItem[];
  overdue: WorkbenchItem[];
  upcoming: WorkbenchItem[];
  unscheduled: WorkbenchItem[];
  pendingAutomations: WorkbenchAutomation[];
  automations: WorkbenchAutomation[];
  recentRuns: RunInfo[];
  artifacts: RunArtifact[];
  projects: WorkbenchProject[];
  notes: WorkbenchNote[];
  metrics: {
    schemaVersion: 1;
    firstTaskSuccessRate: number | null;
    takeoverRate: number | null;
    recoveredAfterFailureRate: number | null;
    automaticRecoveryRate: number | null;
    invalidToolCalls: number;
    duplicateToolCalls: number;
    capabilitySelectionFailures: number;
    durationMs: number;
    modelCalls: number;
    costUsd: number;
    experienceReviewCostUsd: number;
    experienceReviewCount: number;
  };
  experience: {
    schemaVersion: 1;
    reviewCount: number;
    negativeReviews: number;
    averageScore: number | null;
    undecidedFindings: number;
    openFindings: number;
    findings: ExperienceFinding[];
    recentReviews: Array<{
      id: string;
      sourceRunIds: string[];
      sessionId?: string;
      status: ExperienceReviewStatus;
      verdict: ExperienceVerdict;
      path: 'fast' | 'focused';
      providerId: string;
      model: string;
      originalProviderId: string;
      originalModel: string;
      crossModel: boolean;
      score: number | null;
      suggestionCount: number;
      adoptedCount: number;
      costUsd: number;
      updatedAt: number;
    }>;
  };
  organization?: {
    schemaVersion: 1;
    workOrders: WorkOrderView[];
    roles: OrganizationRoleView[];
    scorecards: OrganizationScorecardView[];
    wellbeing: WorkOrderView['wellbeing'];
    receipts: WorkReceiptView[];
    exceptions: OrganizationExceptionView[];
    proposals: Array<{
      id: string;
      workOrderId: string;
      category: string;
      title: string;
      detail: string;
      impact: string;
      status: string;
      humanDecision?: string;
    }>;
  };
  society: SocietySnapshot | null;
}

export interface SocietyDepartmentPolicy {
  id: string;
  name: string;
  charter: string;
  capabilities: string[];
  quotaUsd: number;
  maxConcurrent: number;
  priority: number;
  enabled: boolean;
}

export interface InstitutionVersionView {
  id: string;
  tenantId: string;
  version: number;
  status: 'active' | 'superseded';
  policies: {
    schemaVersion: 1;
    societyBudgetUsd: number;
    minNetBenefitUsd: number;
    maxTeamSize: number;
    welfareMaxActiveAssignments: number;
    highSpendApprovalUsd: number;
    maxQueuedPerDepartment: number;
    roleSelectionWeights?: {
      capability: number;
      memory: number;
      tools: number;
      collaboration: number;
      history: number;
      load: number;
    };
    cognitiveRouting: {
      decision: string;
      execution: string;
      utility: string;
    };
    departments: SocietyDepartmentPolicy[];
  };
  hash: string;
  createdBy: 'human' | 'maharness';
  reason: string;
  createdAt: number;
}

export interface OrganizationVersionView<T> {
  id: string;
  tenantId: string;
  kind: 'role' | 'evaluation';
  subjectId: string;
  version: number;
  status: 'active' | 'superseded';
  record: T;
  hash: string;
  createdBy: 'human' | 'maharness';
  reason: string;
  createdAt: number;
}

export interface OrganizationVersionAuditView {
  id: string;
  tenantId: string;
  kind: 'role' | 'evaluation';
  subjectId: string;
  version: number;
  action: 'initialize' | 'update' | 'rollback';
  actor: 'human' | 'maharness';
  fromVersion?: number;
  toVersion: number;
  beforeHash?: string;
  afterHash: string;
  reason: string;
  createdAt: number;
}

export interface EvaluationPolicyView {
  schemaVersion: 1;
  lowConfidenceSamples: number;
  mediumConfidenceSamples: number;
  highConfidenceSamples: number;
  rankingWeights: {
    acceptance: number;
    budget: number;
    evidence: number;
  };
  review: {
    rubricVersion: string;
    fast: { input: number; output: number; total: number };
    focused: { input: number; output: number; total: number };
    multi: { input: number; output: number; total: number };
    positiveMinAverage: number;
    positiveMinReuse: number;
    positiveMinDimension: number;
  };
  formula: string;
}

export type EvaluationVersionView = OrganizationVersionView<EvaluationPolicyView>;
export type RoleVersionView = OrganizationVersionView<OrganizationRoleView>;

export interface SocietyTaskView {
  id: string;
  tenantId: string;
  projectId: string;
  objective: string;
  acceptance: string[];
  materials: Array<{ id: string; version: string }>;
  valueUsd: number;
  maxBudgetUsd: number;
  priority: number;
  departmentId?: string;
  requiredCapabilities?: string[];
  needsWrite?: boolean;
  capabilitySource?: 'explicit' | 'legacy_heuristic';
  teamMode?: 'auto' | 'solo' | 'team';
  branches: Array<{
    objective: string;
    acceptance: string[];
    expectedArtifacts: string[];
    departmentId?: string;
  }>;
  approval: 'not_required' | 'pending' | 'approved' | 'rejected';
  status: 'queued' | 'waiting_approval' | 'scheduled' | 'awaiting_acceptance' | 'completed' | 'failed' | 'cancelled';
  scheduleId?: string;
  lastSchedulingReason?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface SocietyScheduleView {
  id: string;
  tenantId: string;
  taskId: string;
  trigger: 'human-intake' | 'institution';
  institutionVersion: number;
  departmentId: string;
  workOrderId?: string;
  teamCycleId?: string;
  contractIds: string[];
  runIds: string[];
  mode: 'solo' | 'team' | 'queue' | 'human';
  roleIds: string[];
  assignments: Array<{
    roleId: string;
    branchObjective: string;
    expectedArtifacts: string[];
    acceptance: string[];
    cognitiveTier: 'decision' | 'execution' | 'utility';
    routingStrategy: string;
  }>;
  formula: string;
  estimates: {
    soloCostUsd: number;
    teamCostUsd: number;
    coordinationCostUsd: number;
    soloNetBenefitUsd: number;
    teamNetBenefitUsd: number;
    marginalNetBenefitUsd: number;
    qualityGain: number;
    latencyGainMs: number;
    riskReduction: number;
    roi: number | null;
  };
  sharedMemoryRefs: Array<{ id: string; kind: string; ref: string; version?: string; hash?: string }>;
  selection?: SocietyScheduleSelectionView;
  reason: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  releasedAt?: number;
}

export interface RoleSelectionScoreView {
  roleId: string;
  score: number;
  capabilityFit: number;
  memoryRelevance: number;
  toolReadiness: number;
  collaborationHealth: number;
  historyReliability: number;
  loadBalance: number;
  activeAssignments: number;
  eligible: boolean;
  reason: string;
  blockedReason?: string;
}

export interface SocietyScheduleSelectionView {
  policyVersion: number;
  requiredCapabilities: string[];
  weights: {
    capability: number;
    memory: number;
    tools: number;
    collaboration: number;
    history: number;
    load: number;
  };
  chosenRoleIds: string[];
  candidates: RoleSelectionScoreView[];
}

export interface SocietyRoleLifeView {
  roleId: string;
  versions: RoleVersionView[];
  versionAudits: OrganizationVersionAuditView[];
  memories: Array<{
    id: string;
    roleId: string;
    kind: 'appointment' | 'schedule' | 'submission' | 'delivery' | 'failure' | 'lesson' | 'growth';
    summary: string;
    scheduleId?: string;
    evidence: Array<{ id: string; kind: string; ref: string }>;
    createdAt: number;
  }>;
  relations: Array<{
    id: string;
    fromRoleId: string;
    toRoleId: string;
    kind: 'collaborated' | 'handoff' | 'conflict' | 'reviewed';
    score: number;
    updatedAt: number;
  }>;
  scorecard?: OrganizationScorecardView;
  wellbeing?: SocietyRoleWellbeingView;
}

export interface SocietySnapshot {
  schemaVersion: 1;
  institution: InstitutionVersionView;
  departments: Array<SocietyDepartmentPolicy & {
    queued: number;
    active: number;
    reservedUsd: number;
    spentUsd: number;
    quotaRemainingUsd: number;
    roleIds: string[];
  }>;
  roles: OrganizationRoleView[];
  roleLife: SocietyRoleLifeView[];
  tasks: SocietyTaskView[];
  schedules: SocietyScheduleView[];
  institutionAudits: Array<{
    id: string;
    version: number;
    action: 'initialize' | 'update' | 'rollback';
    actor: 'human' | 'maharness';
    fromVersion?: number;
    toVersion: number;
    reason: string;
    createdAt: number;
  }>;
  evaluation: EvaluationVersionView;
  evaluationAudits: OrganizationVersionAuditView[];
  network: {
    nodes: Array<{ roleId: string; departmentId?: string; load: number }>;
    edges: Array<{
      id: string;
      fromRoleId: string;
      toRoleId: string;
      kind: string;
      score: number;
      updatedAt: number;
    }>;
  };
  bottlenecks: Array<{
    departmentId: string;
    kind: 'queue' | 'load' | 'budget' | 'welfare';
    count: number;
    detail: string;
  }>;
  observations: Array<{
    id: string;
    label: string;
    value: number | null;
    unit: 'ratio' | 'count' | 'usd';
    numerator: number | null;
    denominator: number | null;
    sampleSize: number;
    quality: 'observed' | 'insufficient' | 'unknown';
    formula: string;
  }>;
  economics: {
    societyBudgetUsd: number;
    societyReservedUsd: number;
    societySpentUsd: number;
    departmentBudgets: Array<{
      departmentId: string;
      quotaUsd: number;
      reservedUsd: number;
      spentUsd: number;
      remainingUsd: number;
    }>;
    roleBudgets: Array<{
      roleId: string;
      budgetLimitUsd?: number;
      budgetLimitTokens?: number;
      costUsd: number;
      tokens: number;
      cachedInputTokens: number;
      activeAssignments: number;
    }>;
    taskLedger: Array<{
      taskId: string;
      maxBudgetUsd: number;
      maxBudgetTokens: number;
      estimatedCostUsd: number;
      estimatedTokens: number;
      actualCostUsd: number;
      actualTokens: number;
      cachedInputTokens: number;
      cacheMissInputTokens: number;
      cacheWriteTokens: number;
      cacheUsageStatus: 'known' | 'unknown';
      cacheWriteUsageStatus: 'known' | 'unknown';
      valueUsd: number;
      status: string;
    }>;
    cachedInputTokens: number;
    cacheMissInputTokens: number;
    cacheWriteTokens: number;
    cacheSavingsUsd: number | null;
    cacheHitRate: number | null;
    cacheUsageStatus: 'known' | 'unknown';
    cacheWriteUsageStatus: 'known' | 'unknown';
    duplicateEvidenceReads: number;
    compression: {
      sharedMemoryRefs: number;
      reusedRefs: number;
      officialTokenCount: number;
    };
  };
  scheduling: {
    decisions: SocietyScheduleView[];
    queue: SocietyTaskView[];
    waitingApproval: SocietyTaskView[];
    activeTeams: SocietyScheduleView[];
  };
}

export const workbenchApi = {
  summary: () => api<WorkbenchSummary>(`/api/workbench/summary?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  execute: (item: WorkbenchItem) => api<{ sessionId: string }>(`/api/items/${encodeURIComponent(item.id)}/execute`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ revision: item.revision, newAttempt: false }),
  }),
  artifact: (runId: string, artifact: RunArtifact) => api<Material>('/api/materials/artifact', {
    method: 'POST',
    body: JSON.stringify({ runId, artifactId: artifact.id }),
  }),
  teamAction: (id: string, action: 'pause' | 'resume' | 'dissolve') => api<{ teamCycle: unknown; runIds: string[] }>(
    `/api/organization/teams/${encodeURIComponent(id)}/${action}`,
    { method: 'POST' },
  ),
  reassignContract: (teamId: string, contractId: string, roleId: string) => api<{ contract: WorkContractView }>(
    `/api/organization/teams/${encodeURIComponent(teamId)}/contracts/${encodeURIComponent(contractId)}/reassign`,
    { method: 'POST', body: JSON.stringify({ roleId }) },
  ),
  confirmRole: (id: string) => api<{ role: OrganizationRoleView }>(
    `/api/organization/roles/${encodeURIComponent(id)}/confirm`,
    { method: 'POST' },
  ),
  updateRole: (
    id: string,
    revision: number,
    patch: Partial<Pick<OrganizationRoleView, 'name' | 'responsibilities' | 'capabilities' | 'budgetLimitUsd' | 'employment' | 'persistent'>>,
    reason: string,
  ) => api<{ role: OrganizationRoleView }>(
    `/api/organization/roles/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ revision, patch, reason }) },
  ),
  rollbackRole: (id: string, version: number, reason: string) => api<{ role: OrganizationRoleView }>(
    `/api/organization/roles/${encodeURIComponent(id)}/rollback`,
    { method: 'POST', body: JSON.stringify({ version, reason }) },
  ),
  evaluations: () => api<{
    active: EvaluationVersionView;
    versions: EvaluationVersionView[];
    audits: OrganizationVersionAuditView[];
  }>('/api/organization/evaluations'),
  updateEvaluation: (policy: Partial<EvaluationPolicyView>, reason: string) => api<{ evaluation: EvaluationVersionView }>(
    '/api/organization/evaluations',
    { method: 'POST', body: JSON.stringify({ policy, reason }) },
  ),
  rollbackEvaluation: (version: number, reason: string) => api<{ evaluation: EvaluationVersionView }>(
    '/api/organization/evaluations/rollback',
    { method: 'POST', body: JSON.stringify({ version, reason }) },
  ),
  resolveException: (id: string, decision: string) => api<{ exception: OrganizationExceptionView }>(
    `/api/organization/exceptions/${encodeURIComponent(id)}/resolve`,
    { method: 'POST', body: JSON.stringify({ decision }) },
  ),
  decideProposal: (id: string, accepted: boolean, decision: string) => api<{ proposal: unknown }>(
    `/api/organization/proposals/${encodeURIComponent(id)}/decide`,
    { method: 'POST', body: JSON.stringify({ accepted, decision }) },
  ),
  societyTask: (input: {
    objective: string;
    valueUsd: number;
    maxBudgetUsd: number;
    departmentId?: string;
    projectId?: string;
    /** API v2: explicit capabilities and write need are required. */
    requiredCapabilities: string[];
    needsWrite: boolean;
    teamMode?: 'auto' | 'solo' | 'team';
    branches?: SocietyTaskView['branches'];
    materials?: SocietyTaskView['materials'];
  }) => api<{ task: SocietyTaskView }>('/api/organization/society/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  tickSociety: (projectId?: string) => api<{
    decisions: SocietyScheduleView[];
    queued: number;
    waitingApproval: number;
    snapshot: SocietySnapshot;
  }>('/api/organization/society/tick', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  }),
  approveSocietyTask: (id: string, approved: boolean) => api<{ task: SocietyTaskView }>(
    `/api/organization/society/tasks/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: JSON.stringify({ approved }) },
  ),
  releaseSocietyTask: (id: string, outcome: 'completed' | 'failed', summary: string) => api<{
    task: SocietyTaskView;
    schedule: SocietyScheduleView;
  }>(`/api/organization/society/tasks/${encodeURIComponent(id)}/release`, {
    method: 'POST',
    body: JSON.stringify({ outcome, summary }),
  }),
  roleLife: (id: string) => api<{ life: SocietyRoleLifeView }>(
    `/api/organization/roles/${encodeURIComponent(id)}/life`,
  ),
  updateInstitution: (policies: Record<string, unknown>, reason: string) => api<{ institution: InstitutionVersionView }>(
    '/api/organization/institution',
    { method: 'POST', body: JSON.stringify({ policies, reason }) },
  ),
  rollbackInstitution: (version: number, reason: string) => api<{ institution: InstitutionVersionView }>(
    '/api/organization/institution/rollback',
    { method: 'POST', body: JSON.stringify({ version, reason }) },
  ),
};
