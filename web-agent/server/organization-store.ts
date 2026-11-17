import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RunAuthorization } from '../kernel/run';
import type { MaterialRef } from '../kernel/material';

export const ORGANIZATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS organization_work_orders_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    root_run_id TEXT,
    origin_kind TEXT NOT NULL DEFAULT 'run',
    origin_id TEXT,
    status TEXT NOT NULL,
    operation_key TEXT,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, operation_key)
  );
  CREATE INDEX IF NOT EXISTS organization_work_orders_tenant
    ON organization_work_orders_v1(tenant_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS organization_work_orders_project
    ON organization_work_orders_v1(tenant_id, project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_roles_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_roles_tenant
    ON organization_roles_v1(tenant_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS organization_roles_project
    ON organization_roles_v1(tenant_id, project_id, status);

  CREATE TABLE IF NOT EXISTS organization_team_cycles_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_team_cycles_order
    ON organization_team_cycles_v1(tenant_id, work_order_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_contracts_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    team_cycle_id TEXT,
    role_id TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_contracts_order
    ON organization_contracts_v1(tenant_id, work_order_id, created_at);
  CREATE INDEX IF NOT EXISTS organization_contracts_run
    ON organization_contracts_v1(tenant_id, run_id);

  CREATE TABLE IF NOT EXISTS organization_ledger_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    contract_id TEXT,
    type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_ledger_order
    ON organization_ledger_v1(tenant_id, work_order_id, created_at);

  CREATE TABLE IF NOT EXISTS organization_receipts_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_receipts_tenant
    ON organization_receipts_v1(tenant_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_exceptions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    contract_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_exceptions_tenant
    ON organization_exceptions_v1(tenant_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_proposals_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_proposals_tenant
    ON organization_proposals_v1(tenant_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_institutions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tenant_id, version)
  );
  CREATE INDEX IF NOT EXISTS organization_institutions_tenant
    ON organization_institutions_v1(tenant_id, version DESC);

  CREATE TABLE IF NOT EXISTS organization_institution_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_institution_audits_tenant
    ON organization_institution_audits_v1(tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS organization_versions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tenant_id, kind, subject_id, version)
  );
  CREATE INDEX IF NOT EXISTS organization_versions_subject
    ON organization_versions_v1(tenant_id, kind, subject_id, version DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS organization_versions_one_active
    ON organization_versions_v1(tenant_id, kind, subject_id)
    WHERE status='active';

  CREATE TABLE IF NOT EXISTS organization_version_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    from_version INTEGER,
    to_version INTEGER NOT NULL,
    before_hash TEXT,
    after_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_version_audits_subject
    ON organization_version_audits_v1(tenant_id, kind, subject_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS organization_society_tasks_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    department_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_society_tasks_tenant
    ON organization_society_tasks_v1(tenant_id, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS organization_society_schedules_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    work_order_id TEXT,
    department_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_society_schedules_tenant
    ON organization_society_schedules_v1(tenant_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS organization_society_schedules_order
    ON organization_society_schedules_v1(tenant_id, work_order_id);

  CREATE TABLE IF NOT EXISTS organization_role_memories_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS organization_role_memories_role
    ON organization_role_memories_v1(tenant_id, role_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS organization_role_relations_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    from_role_id TEXT NOT NULL,
    to_role_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, from_role_id, to_role_id, kind)
  );
  CREATE INDEX IF NOT EXISTS organization_role_relations_role
    ON organization_role_relations_v1(tenant_id, from_role_id, updated_at DESC);
`;

export type WorkOrderStatus = 'active' | 'waiting_approval' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type ContractStatus = 'proposed' | 'active' | 'delivered' | 'failed' | 'cancelled' | 'collapsed';
export type ExceptionStatus = 'open' | 'auto_resolved' | 'waiting_human' | 'resolved' | 'dismissed';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface WorkAcceptance {
  id: string;
  statement: string;
  verification?: string;
}

export interface WorkOrder {
  id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  rootRunId?: string;
  originKind: 'run' | 'society-task';
  originId: string;
  objective: string;
  acceptance: WorkAcceptance[];
  successConditions: string[];
  budgetUsd?: number;
  budgetTokens?: number;
  budgetPolicy: 'advisory' | 'enforce';
  deadlineAt?: number;
  materials: Pick<MaterialRef, 'id' | 'version'>[];
  authorization: RunAuthorization;
  creator: string;
  status: WorkOrderStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationRole {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  responsibilities: string[];
  capabilities: string[];
  authority: { workspace: string; readOnly: boolean; profile: 'standard' | 'developer'; allowedTools: string[] };
  modelPolicy: { providerId: string; model: string };
  budgetLimitUsd?: number;
  budgetLimitTokens?: number;
  persistent: boolean;
  employment: 'active' | 'paused';
  source: 'builtin' | 'project' | 'human';
  executionSessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type OrganizationRoleGovernance = Pick<OrganizationRole,
  'id' | 'tenantId' | 'projectId' | 'name' | 'responsibilities' | 'capabilities' |
  'modelPolicy' | 'budgetLimitUsd' | 'budgetLimitTokens' | 'persistent' | 'employment' |
  'source' | 'revision' | 'createdAt'>;

export function roleGovernance(role: OrganizationRole): OrganizationRoleGovernance {
  return {
    id: role.id,
    tenantId: role.tenantId,
    projectId: role.projectId,
    name: role.name,
    responsibilities: [...role.responsibilities],
    capabilities: [...role.capabilities],
    modelPolicy: { ...role.modelPolicy },
    ...(role.budgetLimitUsd === undefined ? {} : { budgetLimitUsd: role.budgetLimitUsd }),
    ...(role.budgetLimitTokens === undefined ? {} : { budgetLimitTokens: role.budgetLimitTokens }),
    persistent: role.persistent,
    employment: role.employment,
    source: role.source,
    revision: role.revision,
    createdAt: role.createdAt,
  };
}

export interface EvidenceRef {
  id: string;
  kind: string;
  ref: string;
  version?: string;
  hash?: string;
}

export interface AssignmentDelivery {
  summary: string;
  artifacts: string[];
  evidence: EvidenceRef[];
  unfinished: string[];
  costUsd: number;
  cacheSavingsUsd?: number;
  usageKnown: boolean;
}

export interface AssignmentContract {
  id: string;
  tenantId: string;
  workOrderId: string;
  teamCycleId?: string;
  roleId: string;
  departmentId?: string;
  runId?: string;
  branchObjective: string;
  expectedArtifacts: string[];
  acceptance: WorkAcceptance[];
  evidenceInputs: EvidenceRef[];
  dependsOn: string[];
  budgetUsd?: number;
  budgetTokens?: number;
  deadlineAt?: number;
  allowedTools: string[];
  status: ContractStatus;
  delivery?: AssignmentDelivery;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamCycle {
  id: string;
  tenantId: string;
  workOrderId: string;
  assignmentIds: string[];
  soloEstimateUsd: number;
  teamEstimateUsd: number;
  hardBudget: boolean;
  reason: string;
  status: 'planned' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'dissolved';
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SocietyDepartmentPolicy {
  id: string;
  name: string;
  charter: string;
  capabilities: string[];
  quotaUsd: number;
  quotaTokens: number;
  maxConcurrent: number;
  priority: number;
  enabled: boolean;
}

export interface InstitutionPolicies {
  schemaVersion: 1;
  societyBudgetUsd: number;
  societyTokenBudget: number;
  minNetBenefitUsd: number;
  maxTeamSize: number;
  welfareMaxActiveAssignments: number;
  highSpendApprovalUsd: number;
  maxQueuedPerDepartment: number;
  cognitiveRouting: {
    decision: 'configured-primary-model';
    execution: 'configured-role-model-or-tools';
    utility: 'deterministic-tools';
  };
  departments: SocietyDepartmentPolicy[];
}

export interface InstitutionVersion {
  id: string;
  tenantId: string;
  version: number;
  status: 'active' | 'superseded';
  policies: InstitutionPolicies;
  hash: string;
  createdBy: 'human' | 'maharness';
  reason: string;
  createdAt: number;
}

export interface InstitutionAudit {
  id: string;
  tenantId: string;
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

export type OrganizationVersionKind = 'role' | 'evaluation';
export type OrganizationVersionStatus = 'active' | 'superseded';

export interface OrganizationVersion<T> {
  id: string;
  tenantId: string;
  kind: OrganizationVersionKind;
  subjectId: string;
  version: number;
  status: OrganizationVersionStatus;
  record: T;
  hash: string;
  createdBy: 'human' | 'maharness';
  reason: string;
  createdAt: number;
}

export interface OrganizationVersionAudit {
  id: string;
  tenantId: string;
  kind: OrganizationVersionKind;
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

export interface EvaluationPolicy {
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
    dimensions: string[];
    systemPrompt: string;
    fast: { input: number; output: number; total: number };
    focused: { input: number; output: number; total: number };
    multi: { input: number; output: number; total: number };
    positiveMinAverage: number;
    positiveMinReuse: number;
    positiveMinDimension: number;
  };
  formula: string;
}

export type RoleVersion = OrganizationVersion<OrganizationRoleGovernance>;
export type EvaluationVersion = OrganizationVersion<EvaluationPolicy>;

export interface SocietyTaskBranch {
  objective: string;
  acceptance: string[];
  expectedArtifacts: string[];
  departmentId?: string;
  dependsOn?: string[];
  maxBudgetTokens?: number;
}

export interface SocietyTask {
  id: string;
  tenantId: string;
  projectId: string;
  objective: string;
  acceptance: string[];
  materials: Pick<MaterialRef, 'id' | 'version'>[];
  valueUsd: number;
  maxBudgetUsd: number;
  maxBudgetTokens: number;
  priority: number;
  departmentId?: string;
  economics?: {
    qualityGain: number;
    riskReduction: number;
    latencyGainMs: number;
    latencyBenefitUsd: number;
  };
  branches: SocietyTaskBranch[];
  evidenceExperimentId?: string;
  experiment?: SocietyTaskExperiment;
  approval: 'not_required' | 'pending' | 'approved' | 'rejected';
  status: 'queued' | 'waiting_approval' | 'scheduled' | 'awaiting_acceptance' | 'completed' | 'failed' | 'cancelled';
  scheduleId?: string;
  lastSchedulingReason?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface SocietyExperimentMeasurement {
  taskId: string;
  scheduleId?: string;
  runIds: string[];
  status: SocietyTask['status'];
  completed: boolean;
  quality: number;
  artifactCoverage: number;
  latencyMs: number;
  risk: number;
  costUsd: number;
  tokens: number;
  coordinationCostUsd: number;
  coordinationTokens: number;
  usageKnown: boolean;
}

export interface SocietyPairedExperiment {
  id: string;
  tenantId: string;
  projectId: string;
  objective: string;
  valueUsd: number;
  status: 'running' | 'measured' | 'inconclusive';
  soloTaskId: string;
  teamTaskId: string;
  measurements?: {
    solo: SocietyExperimentMeasurement;
    team: SocietyExperimentMeasurement;
  };
  netBenefitUsd?: {
    solo: number;
    team: number;
    marginal: number;
  };
  formula: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface SocietyTaskExperiment {
  id: string;
  variant: 'solo' | 'team';
  peerTaskId: string;
  snapshot: SocietyPairedExperiment;
}

export interface SocietyScheduleAssignment {
  roleId: string;
  departmentId?: string;
  contractId?: string;
  runId?: string;
  branchObjective: string;
  expectedArtifacts: string[];
  acceptance: string[];
  cognitiveTier: 'decision' | 'execution' | 'utility';
  routingStrategy: string;
  dependsOn: string[];
  budgetTokens: number;
  providerId: string;
  model: string;
  fallbackReason?: string;
}

export interface SocietySchedule {
  id: string;
  tenantId: string;
  taskId: string;
  teamCycleId?: string;
  contractIds: string[];
  runIds: string[];
  trigger: 'human-intake' | 'institution';
  institutionVersion: number;
  departmentId: string;
  workOrderId?: string;
  mode: 'solo' | 'team' | 'queue' | 'human';
  roleIds: string[];
  assignments: SocietyScheduleAssignment[];
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
    soloTokens: number;
    teamTokens: number;
    coordinationTokens: number;
    roi: number | null;
  };
  sharedMemoryRefs: EvidenceRef[];
  reason: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  releasedAt?: number;
}

export interface SocietyRoleMemory {
  id: string;
  tenantId: string;
  roleId: string;
  kind: 'appointment' | 'schedule' | 'delivery' | 'failure' | 'lesson' | 'growth';
  summary: string;
  scheduleId?: string;
  workOrderId?: string;
  evidence: EvidenceRef[];
  createdAt: number;
}

export interface SocietyRoleRelation {
  id: string;
  tenantId: string;
  fromRoleId: string;
  toRoleId: string;
  kind: 'collaborated' | 'handoff' | 'conflict' | 'reviewed';
  score: number;
  evidence: EvidenceRef[];
  updatedAt: number;
}

export interface SocialHealth {
  score: number | null;
  loadBalance: number | null;
  welfare: number | null;
  exceptionHealth: number | null;
  budgetUtilization: number | null;
  collaborationHealth: number | null;
}

export interface SocietySnapshot {
  schemaVersion: 1;
  institution: InstitutionVersion;
  departments: Array<SocietyDepartmentPolicy & {
    queued: number;
    active: number;
    reservedUsd: number;
    spentUsd: number;
    quotaRemainingUsd: number;
    roleIds: string[];
  }>;
  roles: OrganizationRole[];
  roleLife: Array<{
    roleId: string;
    versions: RoleVersion[];
    versionAudits: OrganizationVersionAudit[];
    memories: SocietyRoleMemory[];
    relations: SocietyRoleRelation[];
    scorecard?: RoleScorecard;
    wellbeing?: RoleWellbeingSnapshot;
  }>;
  tasks: SocietyTask[];
  schedules: SocietySchedule[];
  institutionAudits: InstitutionAudit[];
  evaluation: EvaluationVersion;
  evaluationAudits: OrganizationVersionAudit[];
  network: {
    nodes: Array<{ roleId: string; departmentId?: string; load: number }>;
    edges: SocietyRoleRelation[];
  };
  bottlenecks: Array<{ departmentId: string; kind: 'queue' | 'load' | 'budget' | 'welfare'; count: number; detail: string }>;
  health: SocialHealth;
  economics: {
    societyBudgetUsd: number;
    societyTokenBudget: number;
    societyReservedUsd: number;
    societySpentUsd: number;
    societyReservedTokens: number;
    societySpentTokens: number;
    departmentBudgets: Array<{ departmentId: string; quotaUsd: number; reservedUsd: number; spentUsd: number; remainingUsd: number; quotaTokens: number; reservedTokens: number; spentTokens: number; remainingTokens: number }>;
    roleBudgets: Array<{ roleId: string; budgetLimitUsd?: number; budgetLimitTokens?: number; costUsd: number; tokens: number; cachedInputTokens: number; activeAssignments: number }>;
    taskLedger: Array<{ taskId: string; maxBudgetUsd: number; maxBudgetTokens: number; estimatedCostUsd: number; estimatedTokens: number; actualCostUsd: number; actualTokens: number; cachedInputTokens: number; cacheMissInputTokens: number; cacheWriteTokens: number; cacheUsageStatus: 'known' | 'unknown'; cacheWriteUsageStatus: 'known' | 'unknown'; valueUsd: number; status: string }>;
    cachedInputTokens: number;
    cacheMissInputTokens: number;
    cacheWriteTokens: number;
    cacheSavingsUsd: number | null;
    cacheHitRate: number | null;
    cacheUsageStatus: 'known' | 'unknown';
    cacheWriteUsageStatus: 'known' | 'unknown';
    duplicateEvidenceReads: number;
    compression: { sharedMemoryRefs: number; reusedRefs: number; officialTokenCount: number };
  };
  scheduling: {
    decisions: SocietySchedule[];
    queue: SocietyTask[];
    waitingApproval: SocietyTask[];
    activeTeams: SocietySchedule[];
  };
}

export interface WorkLedgerEntry {
  id: string;
  tenantId: string;
  workOrderId: string;
  contractId?: string;
  type: 'commitment' | 'accepted' | 'started' | 'evidence' | 'checkpoint' | 'handoff' | 'exception' | 'delivered' | 'reviewed' | 'closed';
  actorId: string;
  summary: string;
  evidence: EvidenceRef[];
  createdAt: number;
}

export interface WorkReceipt {
  id: string;
  tenantId: string;
  workOrderId: string;
  status: WorkOrderStatus;
  answer: string;
  artifacts: string[];
  sources: EvidenceRef[];
  contributors: { roleId: string; contractId: string; summary: string }[];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensCacheMiss: number;
  cacheWriteTokens: number;
  budgetTokens?: number;
  tokenCompliance: boolean | null;
  cacheSavingsUsd?: number;
  unfinished: string[];
  exceptions: string[];
  humanAcceptedAt?: number;
  usageKnown: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoleScorecard {
  roleId: string;
  tenantId: string;
  evaluationVersion: number;
  evaluationHash: string;
  sampleSize: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  completionRate: number | null;
  acceptanceRate: number | null;
  reworkRate: number | null;
  budgetCompliance: number | null;
  recoveryRate: number | null;
  evidenceCompleteness: number | null;
  reviewConsistency: number | null;
  costUsd: number;
  tokens: number;
  cachedInputTokens: number;
  tokenBudgetCompliance: number | null;
  updatedAt: number;
}

export interface RoleWellbeingSnapshot {
  roleId: string;
  activeAssignments: number;
  consecutiveFailures: number;
  waitingApproval: number;
  reworkAssignments: number;
  contextPressure: 'unknown' | 'normal' | 'high';
  state: 'ready' | 'busy' | 'waiting' | 'resting';
  updatedAt: number;
}

export interface ExceptionCase {
  id: string;
  tenantId: string;
  workOrderId: string;
  contractId?: string;
  kind: 'ambiguity' | 'rule-conflict' | 'tool-failure' | 'budget' | 'authority' | 'handoff' | 'overload' | 'opinion-conflict';
  summary: string;
  facts: string[];
  evidence: EvidenceRef[];
  factRuling: string;
  requiresHuman: boolean;
  recovery: string;
  status: ExceptionStatus;
  humanDecision?: string;
  createdBy: 'maharness' | 'ai';
  createdAt: number;
  updatedAt: number;
}

export interface InstitutionProposal {
  id: string;
  tenantId: string;
  workOrderId: string;
  category: 'role' | 'rule' | 'cache' | 'skill' | 'workflow';
  title: string;
  detail: string;
  evidence: EvidenceRef[];
  impact: 'high' | 'medium' | 'low';
  status: ProposalStatus;
  humanDecision?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamEconomics {
  workOrderId: string;
  singleAgentEstimateUsd: number | null;
  teamEstimateUsd: number;
  actualCostUsd: number;
  singleAgentEstimateTokens: number | null;
  teamEstimateTokens: number;
  actualTokens: number;
  cachedInputTokens: number;
  tokensCacheMiss: number;
  cacheWriteTokens: number;
  cacheSavingsUsd: number | null;
  duplicateEvidenceReads: number;
  coordinationRounds: number;
  roi: number | null;
  fallbackReason?: string;
  usageKnown: boolean;
}

export interface CreateWorkOrderInput {
  tenantId: string;
  projectId?: string;
  sessionId?: string;
  rootRunId?: string;
  originKind?: 'run' | 'society-task';
  originId?: string;
  objective: string;
  acceptance?: WorkAcceptance[];
  budgetUsd?: number;
  budgetTokens?: number;
  budgetPolicy?: 'advisory' | 'enforce';
  deadlineAt?: number;
  materials?: MaterialRef[];
  authorization: RunAuthorization;
  creator?: string;
  operationKey?: string;
  now?: number;
}

function parseRows<T>(rows: { record: string }[]): T[] {
  return rows.map(row => JSON.parse(row.record) as T);
}

function stableId(prefix: string, tenantId: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(`${tenantId}\0${value}`).digest('hex').slice(0, 24)}`;
}

function recordHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class OrganizationRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  createWorkOrder(input: CreateWorkOrderInput): WorkOrder {
    const now = input.now ?? Date.now();
    const record: WorkOrder = {
      id: randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId ?? '',
      sessionId: input.sessionId ?? '',
      rootRunId: input.rootRunId,
      originKind: input.originKind ?? 'run',
      originId: input.originId ?? input.rootRunId ?? '',
      objective: input.objective,
      acceptance: input.acceptance ?? [],
      successConditions: input.acceptance?.map(item => item.statement) ?? [],
      budgetUsd: input.budgetUsd,
      budgetTokens: input.budgetTokens,
      budgetPolicy: input.budgetPolicy ?? 'advisory',
      deadlineAt: input.deadlineAt,
      materials: (input.materials ?? []).map(({ id, version }) => ({ id, version })),
      authorization: input.authorization,
      creator: input.creator ?? 'user',
      status: 'active',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (input.operationKey) {
      const existing = this.db.prepare(
        'SELECT record FROM organization_work_orders_v1 WHERE tenant_id=? AND operation_key=?',
      ).get(input.tenantId, input.operationKey) as { record: string } | undefined;
      if (existing) return JSON.parse(existing.record) as WorkOrder;
    }
    this.db.prepare(`INSERT INTO organization_work_orders_v1
      (id,tenant_id,project_id,session_id,root_run_id,origin_kind,origin_id,status,operation_key,record,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.projectId, record.sessionId, record.rootRunId ?? null,
      record.originKind, record.originId, record.status, input.operationKey ?? null, JSON.stringify(record), now, now,
    );
    return record;
  }

  getWorkOrder(id: string, tenantId: string): WorkOrder | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_work_orders_v1 WHERE id=? AND tenant_id=?',
    ).get(id, tenantId) as { record: string } | undefined;
    return row ? this.normalizeWorkOrder(JSON.parse(row.record) as WorkOrder) : undefined;
  }

  workOrderByRun(runId: string, tenantId: string): WorkOrder | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_work_orders_v1 WHERE root_run_id=? AND tenant_id=?',
    ).get(runId, tenantId) as { record: string } | undefined;
    return row ? this.normalizeWorkOrder(JSON.parse(row.record) as WorkOrder) : undefined;
  }

  listWorkOrders(tenantId: string, projectId?: string, limit = 100): WorkOrder[] {
    const rows = this.db.prepare(`SELECT record FROM organization_work_orders_v1
      WHERE tenant_id=? AND (?='' OR project_id=?)
      ORDER BY updated_at DESC LIMIT ?`).all(
      tenantId, projectId ?? '', projectId ?? '', Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<WorkOrder>(rows).map(record => this.normalizeWorkOrder(record));
  }

  private normalizeWorkOrder(record: WorkOrder): WorkOrder {
    if (!record.originKind) record.originKind = 'run';
    if (!record.originId) record.originId = record.rootRunId ?? '';
    return record;
  }

  updateWorkOrder(record: WorkOrder, patch: Partial<Omit<WorkOrder, 'id' | 'tenantId'>>, revision: number): WorkOrder {
    if (record.revision !== revision) throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '工作单已变化，请刷新后重试', true);
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() });
    this.db.prepare(`UPDATE organization_work_orders_v1
      SET project_id=?,status=?,record=?,updated_at=? WHERE id=? AND tenant_id=?`).run(
      record.projectId, record.status, JSON.stringify(record), record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  private atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work)();
  }

  ensureSoloRole(tenantId: string, providerId: string, model: string, authorization: RunAuthorization, projectId = ''): OrganizationRole {
    const id = stableId('solo', tenantId, projectId || 'organization');
    const existing = this.getRole(id, tenantId);
    if (existing) return existing;
    const now = Date.now();
    const role: OrganizationRole = {
      id, tenantId, projectId,
      name: projectId ? '项目执行员' : '工作执行员',
      responsibilities: ['完成单角色任务', '报告事实、产物和未完成项'],
      capabilities: ['files', 'research', 'documents', 'automation'],
      authority: {
        workspace: authorization.workspace,
        readOnly: authorization.readOnly,
        profile: authorization.profile,
        allowedTools: [],
      },
      modelPolicy: { providerId, model },
      persistent: true,
      employment: 'active',
      source: 'builtin',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.createRole(role);
    return role;
  }

  createRole(role: OrganizationRole): OrganizationRole {
    this.atomic(() => {
      this.db.prepare(`INSERT INTO organization_roles_v1
        (id,tenant_id,project_id,status,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(
        role.id, role.tenantId, role.projectId, role.employment, JSON.stringify(role), role.createdAt, role.updatedAt,
      );
      const governance = roleGovernance(role);
      const version = this.createOrganizationVersion({
        id: randomUUID(), tenantId: role.tenantId, kind: 'role', subjectId: role.id,
        version: 1, status: 'active', record: governance, hash: recordHash(governance),
        createdBy: role.source === 'human' ? 'human' : 'maharness',
        reason: '建立角色版本', createdAt: role.createdAt,
      });
      this.appendOrganizationVersionAudit({
        id: randomUUID(), tenantId: role.tenantId, kind: 'role', subjectId: role.id,
        version: 1, action: 'initialize', actor: version.createdBy, toVersion: 1,
        afterHash: version.hash, reason: version.reason, createdAt: role.createdAt,
      });
    });
    return role;
  }

  getRole(id: string, tenantId: string): OrganizationRole | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_roles_v1 WHERE id=? AND tenant_id=?',
    ).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as OrganizationRole : undefined;
  }

  listRoles(tenantId: string, projectId?: string, includePaused = false): OrganizationRole[] {
    const rows = this.db.prepare(`SELECT record FROM organization_roles_v1
      WHERE tenant_id=@tenant AND (@project='' OR project_id=@project)
        AND (@include=1 OR status='active') ORDER BY updated_at DESC`).all({
      tenant: tenantId, project: projectId ?? '', include: includePaused ? 1 : 0,
    }) as { record: string }[];
    return parseRows<OrganizationRole>(rows);
  }

  updateRole(
    role: OrganizationRole,
    patch: Partial<Omit<OrganizationRole, 'id' | 'tenantId'>>,
    revision: number,
    audit: {
      actor?: 'human' | 'maharness';
      reason?: string;
      action?: 'update' | 'rollback';
      fromVersion?: number;
      trackVersion?: boolean;
    } = {},
  ): OrganizationRole {
    if (role.revision !== revision) throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '角色已变化，请刷新后重试', true);
    const before = structuredClone(role);
    const tracksGovernance = audit.trackVersion !== false;
    const next: OrganizationRole = {
      ...role,
      ...patch,
      revision: tracksGovernance ? role.revision + 1 : role.revision,
      updatedAt: Date.now(),
    };
    const currentVersion = this.activeOrganizationVersion('role', role.tenantId, role.id)?.version ?? 0;
    this.atomic(() => {
      this.db.prepare(`UPDATE organization_roles_v1 SET project_id=?,status=?,record=?,updated_at=?
        WHERE id=? AND tenant_id=?`).run(
        next.projectId, next.employment, JSON.stringify(next), next.updatedAt, next.id, next.tenantId,
      );
      if (!tracksGovernance) return;
      const governance = roleGovernance(next);
      this.supersedeOrganizationVersions(role.tenantId, 'role', role.id, currentVersion + 1);
      const version = this.createOrganizationVersion({
        id: randomUUID(), tenantId: role.tenantId, kind: 'role', subjectId: role.id,
        version: currentVersion + 1, status: 'active', record: governance, hash: recordHash(governance),
        createdBy: audit.actor ?? 'maharness',
        reason: audit.reason ?? '角色运行配置更新', createdAt: next.updatedAt,
      });
      this.appendOrganizationVersionAudit({
        id: randomUUID(), tenantId: role.tenantId, kind: 'role', subjectId: role.id,
        version: version.version, action: audit.action ?? 'update', actor: audit.actor ?? 'maharness',
        ...(audit.fromVersion === undefined
          ? currentVersion ? { fromVersion: currentVersion } : {}
          : { fromVersion: audit.fromVersion }),
        toVersion: version.version, beforeHash: recordHash(roleGovernance(before)), afterHash: version.hash,
        reason: version.reason, createdAt: next.updatedAt,
      });
    });
    Object.assign(role, next);
    return role;
  }

  createTeamCycle(record: TeamCycle): TeamCycle {
    this.db.prepare(`INSERT INTO organization_team_cycles_v1
      (id,tenant_id,work_order_id,status,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.workOrderId, record.status, JSON.stringify(record), record.createdAt, record.updatedAt,
    );
    return record;
  }

  getTeamCycle(id: string, tenantId: string): TeamCycle | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_team_cycles_v1 WHERE id=? AND tenant_id=?',
    ).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TeamCycle : undefined;
  }

  listTeamCycles(workOrderId: string, tenantId: string): TeamCycle[] {
    const rows = this.db.prepare(`SELECT record FROM organization_team_cycles_v1
      WHERE work_order_id=? AND tenant_id=? ORDER BY created_at`).all(workOrderId, tenantId) as { record: string }[];
    return parseRows<TeamCycle>(rows);
  }

  updateTeamCycle(record: TeamCycle, patch: Partial<Omit<TeamCycle, 'id' | 'tenantId'>>): TeamCycle {
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() });
    this.db.prepare(`UPDATE organization_team_cycles_v1 SET status=?,record=?,updated_at=?
      WHERE id=? AND tenant_id=?`).run(
      record.status, JSON.stringify(record), record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  createContract(record: AssignmentContract): AssignmentContract {
    this.db.prepare(`INSERT INTO organization_contracts_v1
      (id,tenant_id,work_order_id,team_cycle_id,role_id,run_id,status,record,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.workOrderId, record.teamCycleId ?? null, record.roleId,
      record.runId ?? null, record.status, JSON.stringify(record), record.createdAt, record.updatedAt,
    );
    return record;
  }

  getContract(id: string, tenantId: string): AssignmentContract | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_contracts_v1 WHERE id=? AND tenant_id=?',
    ).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as AssignmentContract : undefined;
  }

  contracts(workOrderId: string, tenantId: string): AssignmentContract[] {
    const rows = this.db.prepare(`SELECT record FROM organization_contracts_v1
      WHERE work_order_id=? AND tenant_id=? ORDER BY created_at`).all(workOrderId, tenantId) as { record: string }[];
    return parseRows<AssignmentContract>(rows);
  }

  contractsForRun(runId: string, tenantId: string): AssignmentContract[] {
    const rows = this.db.prepare(`SELECT record FROM organization_contracts_v1
      WHERE run_id=? AND tenant_id=? ORDER BY created_at`).all(runId, tenantId) as { record: string }[];
    return parseRows<AssignmentContract>(rows);
  }

  updateContract(record: AssignmentContract, patch: Partial<Omit<AssignmentContract, 'id' | 'tenantId'>>, revision: number): AssignmentContract {
    if (record.revision !== revision) throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '分工契约已变化，请刷新后重试', true);
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() });
    this.db.prepare(`UPDATE organization_contracts_v1 SET run_id=?,status=?,record=?,updated_at=?
      WHERE id=? AND tenant_id=?`).run(
      record.runId ?? null, record.status, JSON.stringify(record), record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  appendLedger(entry: WorkLedgerEntry): WorkLedgerEntry {
    this.db.prepare(`INSERT INTO organization_ledger_v1
      (id,tenant_id,work_order_id,contract_id,type,actor_id,record,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      entry.id, entry.tenantId, entry.workOrderId, entry.contractId ?? null, entry.type,
      entry.actorId, JSON.stringify(entry), entry.createdAt,
    );
    return entry;
  }

  ledger(workOrderId: string, tenantId: string, limit = 500): WorkLedgerEntry[] {
    const rows = this.db.prepare(`SELECT record FROM organization_ledger_v1
      WHERE work_order_id=? AND tenant_id=? ORDER BY created_at LIMIT ?`).all(
      workOrderId, tenantId, Math.max(1, Math.min(2000, limit)),
    ) as { record: string }[];
    return parseRows<WorkLedgerEntry>(rows);
  }

  saveReceipt(record: WorkReceipt): WorkReceipt {
    this.db.prepare(`INSERT INTO organization_receipts_v1
      (id,tenant_id,work_order_id,record,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(work_order_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at`).run(
      record.id, record.tenantId, record.workOrderId, JSON.stringify(record), record.createdAt, record.updatedAt,
    );
    return record;
  }

  receipt(workOrderId: string, tenantId: string): WorkReceipt | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_receipts_v1 WHERE work_order_id=? AND tenant_id=?',
    ).get(workOrderId, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as WorkReceipt : undefined;
  }

  receipts(tenantId: string, limit = 100): WorkReceipt[] {
    const rows = this.db.prepare(`SELECT record FROM organization_receipts_v1
      WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?`).all(
      tenantId, Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<WorkReceipt>(rows);
  }

  createException(record: ExceptionCase): ExceptionCase {
    this.db.prepare(`INSERT INTO organization_exceptions_v1
      (id,tenant_id,work_order_id,contract_id,status,record,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.workOrderId, record.contractId ?? null, record.status,
      JSON.stringify(record), record.createdAt, record.updatedAt,
    );
    return record;
  }

  getException(id: string, tenantId: string): ExceptionCase | undefined {
    const row = this.db.prepare(
      'SELECT record FROM organization_exceptions_v1 WHERE id=? AND tenant_id=?',
    ).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ExceptionCase : undefined;
  }

  exceptions(tenantId: string, status?: ExceptionStatus, limit = 200): ExceptionCase[] {
    const rows = this.db.prepare(`SELECT record FROM organization_exceptions_v1
      WHERE tenant_id=? AND (?='' OR status=?) ORDER BY updated_at DESC LIMIT ?`).all(
      tenantId, status ?? '', status ?? '', Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<ExceptionCase>(rows);
  }

  updateException(record: ExceptionCase, patch: Partial<Omit<ExceptionCase, 'id' | 'tenantId'>>): ExceptionCase {
    Object.assign(record, patch, { updatedAt: Date.now() });
    this.db.prepare(`UPDATE organization_exceptions_v1 SET status=?,record=?,updated_at=?
      WHERE id=? AND tenant_id=?`).run(
      record.status, JSON.stringify(record), record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  createProposal(record: InstitutionProposal): InstitutionProposal {
    this.db.prepare(`INSERT INTO organization_proposals_v1
      (id,tenant_id,work_order_id,status,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.workOrderId, record.status, JSON.stringify(record),
      record.createdAt, record.updatedAt,
    );
    return record;
  }

  proposals(tenantId: string, status?: ProposalStatus): InstitutionProposal[] {
    const rows = this.db.prepare(`SELECT record FROM organization_proposals_v1
      WHERE tenant_id=? AND (?='' OR status=?) ORDER BY updated_at DESC`).all(
      tenantId, status ?? '', status ?? '',
    ) as { record: string }[];
    return parseRows<InstitutionProposal>(rows);
  }

  updateProposal(record: InstitutionProposal, status: ProposalStatus, humanDecision?: string): InstitutionProposal {
    Object.assign(record, { status, ...(humanDecision ? { humanDecision } : {}), updatedAt: Date.now() });
    this.db.prepare('UPDATE organization_proposals_v1 SET status=?,record=?,updated_at=? WHERE id=? AND tenant_id=?').run(
      record.status, JSON.stringify(record), record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  createInstitution(record: InstitutionVersion): InstitutionVersion {
    this.db.prepare(`INSERT INTO organization_institutions_v1
      (id,tenant_id,version,status,record,created_at) VALUES(?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.version, record.status, JSON.stringify(record), record.createdAt,
    );
    return record;
  }

  activeInstitution(tenantId: string): InstitutionVersion | undefined {
    const row = this.db.prepare(`SELECT record FROM organization_institutions_v1
      WHERE tenant_id=? AND status='active' ORDER BY version DESC LIMIT 1`).get(tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as InstitutionVersion : undefined;
  }

  institutions(tenantId: string, limit = 100): InstitutionVersion[] {
    const rows = this.db.prepare(`SELECT record FROM organization_institutions_v1
      WHERE tenant_id=? ORDER BY version DESC LIMIT ?`).all(
      tenantId, Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<InstitutionVersion>(rows);
  }

  updateInstitution(record: InstitutionVersion, patch: Partial<Pick<InstitutionVersion, 'status'>>): InstitutionVersion {
    Object.assign(record, patch);
    this.db.prepare(`UPDATE organization_institutions_v1 SET status=?,record=? WHERE id=? AND tenant_id=?`).run(
      record.status, JSON.stringify(record), record.id, record.tenantId,
    );
    return record;
  }

  appendInstitutionAudit(record: InstitutionAudit): InstitutionAudit {
    this.db.prepare(`INSERT INTO organization_institution_audits_v1
      (id,tenant_id,version,record,created_at) VALUES(?,?,?,?,?)`).run(
      record.id, record.tenantId, record.version, JSON.stringify(record), record.createdAt,
    );
    return record;
  }

  institutionAudits(tenantId: string, limit = 100): InstitutionAudit[] {
    const rows = this.db.prepare(`SELECT record FROM organization_institution_audits_v1
      WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`).all(
      tenantId, Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<InstitutionAudit>(rows);
  }

  createOrganizationVersion<T>(record: OrganizationVersion<T>): OrganizationVersion<T> {
    this.db.prepare(`INSERT INTO organization_versions_v1
      (id,tenant_id,kind,subject_id,version,status,record,hash,created_by,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.kind, record.subjectId, record.version, record.status,
      JSON.stringify(record.record), record.hash, record.createdBy, record.reason, record.createdAt,
    );
    return record;
  }

  activeOrganizationVersion<T>(kind: OrganizationVersionKind, tenantId: string, subjectId: string): OrganizationVersion<T> | undefined {
    const row = this.db.prepare(`SELECT id,tenant_id AS tenantId,kind,subject_id AS subjectId,
      version,status,record,hash,created_by AS createdBy,reason,created_at AS createdAt
      FROM organization_versions_v1
      WHERE tenant_id=? AND kind=? AND subject_id=? AND status='active'
      ORDER BY version DESC LIMIT 1`).get(tenantId, kind, subjectId) as
      (Omit<OrganizationVersion<T>, 'record'> & { record: string }) | undefined;
    if (!row) return undefined;
    return { ...row, record: JSON.parse(row.record) as T };
  }

  organizationVersions<T>(
    kind: OrganizationVersionKind,
    tenantId: string,
    subjectId: string,
    limit = 100,
  ): OrganizationVersion<T>[] {
    const rows = this.db.prepare(`SELECT id,tenant_id AS tenantId,kind,subject_id AS subjectId,
      version,status,record,hash,created_by AS createdBy,reason,created_at AS createdAt
      FROM organization_versions_v1
      WHERE tenant_id=? AND kind=? AND subject_id=?
      ORDER BY version DESC LIMIT ?`).all(
      tenantId, kind, subjectId, Math.max(1, Math.min(500, limit)),
    ) as Array<Omit<OrganizationVersion<T>, 'record'> & { record: string }>;
    return rows.map(row => ({ ...row, record: JSON.parse(row.record) as T }));
  }

  supersedeOrganizationVersions(
    tenantId: string,
    kind: OrganizationVersionKind,
    subjectId: string,
    activeVersion: number,
  ): void {
    this.db.prepare(`UPDATE organization_versions_v1 SET status='superseded'
      WHERE tenant_id=? AND kind=? AND subject_id=? AND version<>? AND status='active'`).run(
      tenantId, kind, subjectId, activeVersion,
    );
  }

  appendOrganizationVersionAudit(record: OrganizationVersionAudit): OrganizationVersionAudit {
    this.db.prepare(`INSERT INTO organization_version_audits_v1
      (id,tenant_id,kind,subject_id,version,action,actor,from_version,to_version,
       before_hash,after_hash,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.kind, record.subjectId, record.version, record.action,
      record.actor, record.fromVersion ?? null, record.toVersion, record.beforeHash ?? null,
      record.afterHash, record.reason, record.createdAt,
    );
    return record;
  }

  organizationVersionAudits(
    kind: OrganizationVersionKind,
    tenantId: string,
    subjectId: string,
    limit = 100,
  ): OrganizationVersionAudit[] {
    const rows = this.db.prepare(`SELECT id,tenant_id AS tenantId,kind,subject_id AS subjectId,
      version,action,actor,from_version AS fromVersion,to_version AS toVersion,
      before_hash AS beforeHash,after_hash AS afterHash,reason,created_at AS createdAt
      FROM organization_version_audits_v1
      WHERE tenant_id=? AND kind=? AND subject_id=?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(
      tenantId, kind, subjectId, Math.max(1, Math.min(500, limit)),
    ) as OrganizationVersionAudit[];
    return rows;
  }

  createSocietyTask(record: SocietyTask): SocietyTask {
    this.db.prepare(`INSERT INTO organization_society_tasks_v1
      (id,tenant_id,project_id,department_id,status,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.projectId, record.departmentId ?? null, record.status,
      JSON.stringify(record), record.createdAt, record.updatedAt,
    );
    return record;
  }

  getSocietyTask(id: string, tenantId: string): SocietyTask | undefined {
    const row = this.db.prepare(`SELECT record FROM organization_society_tasks_v1
      WHERE id=? AND tenant_id=?`).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as SocietyTask : undefined;
  }

  societyTasks(tenantId: string, projectId?: string, limit = 500): SocietyTask[] {
    const rows = this.db.prepare(`SELECT record FROM organization_society_tasks_v1
      WHERE tenant_id=? AND (?='' OR project_id=?) ORDER BY updated_at DESC LIMIT ?`).all(
      tenantId, projectId ?? '', projectId ?? '', Math.max(1, Math.min(1000, limit)),
    ) as { record: string }[];
    return parseRows<SocietyTask>(rows);
  }

  updateSocietyTask(record: SocietyTask, patch: Partial<Omit<SocietyTask, 'id' | 'tenantId'>>): SocietyTask {
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() });
    this.db.prepare(`UPDATE organization_society_tasks_v1
      SET project_id=?,department_id=?,status=?,record=?,updated_at=? WHERE id=? AND tenant_id=?`).run(
      record.projectId, record.departmentId ?? null, record.status, JSON.stringify(record),
      record.updatedAt, record.id, record.tenantId,
    );
    return record;
  }

  createSocietySchedule(record: SocietySchedule): SocietySchedule {
    this.db.prepare(`INSERT INTO organization_society_schedules_v1
      (id,tenant_id,task_id,work_order_id,department_id,mode,status,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.taskId, record.workOrderId ?? null, record.departmentId, record.mode, record.status,
      JSON.stringify(record), record.createdAt, record.releasedAt ?? record.createdAt,
    );
    return record;
  }

  getSocietySchedule(id: string, tenantId: string): SocietySchedule | undefined {
    const row = this.db.prepare(`SELECT record FROM organization_society_schedules_v1
      WHERE id=? AND tenant_id=?`).get(id, tenantId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as SocietySchedule : undefined;
  }

  societySchedules(tenantId: string, limit = 500): SocietySchedule[] {
    const rows = this.db.prepare(`SELECT record FROM organization_society_schedules_v1
      WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?`).all(
      tenantId, Math.max(1, Math.min(1000, limit)),
    ) as { record: string }[];
    return parseRows<SocietySchedule>(rows);
  }

  societyScheduleByWorkOrder(workOrderId: string, tenantId: string): SocietySchedule | undefined {
    const row = this.db.prepare(`SELECT record FROM organization_society_schedules_v1
      WHERE work_order_id=? AND tenant_id=? ORDER BY created_at DESC LIMIT 1`).get(
      workOrderId, tenantId,
    ) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as SocietySchedule : undefined;
  }

  updateSocietySchedule(record: SocietySchedule, patch: Partial<Pick<SocietySchedule,
    'status' | 'releasedAt' | 'workOrderId' | 'teamCycleId' | 'mode' | 'roleIds'
    | 'contractIds' | 'runIds' | 'assignments' | 'estimates' | 'reason'
  >>): SocietySchedule {
    Object.assign(record, patch);
    this.db.prepare(`UPDATE organization_society_schedules_v1
      SET work_order_id=?,status=?,record=?,updated_at=? WHERE id=? AND tenant_id=?`).run(
      record.workOrderId ?? null, record.status, JSON.stringify(record),
      record.releasedAt ?? Date.now(), record.id, record.tenantId,
    );
    return record;
  }

  appendRoleMemory(record: SocietyRoleMemory): SocietyRoleMemory {
    this.db.prepare(`INSERT INTO organization_role_memories_v1
      (id,tenant_id,role_id,kind,record,created_at) VALUES(?,?,?,?,?,?)`).run(
      record.id, record.tenantId, record.roleId, record.kind, JSON.stringify(record), record.createdAt,
    );
    return record;
  }

  roleMemories(tenantId: string, roleId: string, limit = 100): SocietyRoleMemory[] {
    const rows = this.db.prepare(`SELECT record FROM organization_role_memories_v1
      WHERE tenant_id=? AND role_id=? ORDER BY created_at DESC LIMIT ?`).all(
      tenantId, roleId, Math.max(1, Math.min(500, limit)),
    ) as { record: string }[];
    return parseRows<SocietyRoleMemory>(rows);
  }

  upsertRoleRelation(record: SocietyRoleRelation): SocietyRoleRelation {
    const existing = this.db.prepare(`SELECT record FROM organization_role_relations_v1
      WHERE tenant_id=? AND from_role_id=? AND to_role_id=? AND kind=?`).get(
      record.tenantId, record.fromRoleId, record.toRoleId, record.kind,
    ) as { record: string } | undefined;
    if (!existing) {
      this.db.prepare(`INSERT INTO organization_role_relations_v1
        (id,tenant_id,from_role_id,to_role_id,kind,record,updated_at) VALUES(?,?,?,?,?,?,?)`).run(
        record.id, record.tenantId, record.fromRoleId, record.toRoleId, record.kind,
        JSON.stringify(record), record.updatedAt,
      );
      return record;
    }
    const current = JSON.parse(existing.record) as SocietyRoleRelation;
    current.score = Math.round(((current.score + record.score) / 2) * 1000) / 1000;
    current.evidence = [...current.evidence, ...record.evidence]
      .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index)
      .slice(-20);
    current.updatedAt = record.updatedAt;
    this.db.prepare(`UPDATE organization_role_relations_v1 SET record=?,updated_at=? WHERE id=? AND tenant_id=?`).run(
      JSON.stringify(current), current.updatedAt, current.id, current.tenantId,
    );
    return current;
  }

  roleRelations(tenantId: string, roleId?: string): SocietyRoleRelation[] {
    const rows = roleId
      ? this.db.prepare(`SELECT record FROM organization_role_relations_v1
          WHERE tenant_id=? AND (from_role_id=? OR to_role_id=?) ORDER BY updated_at DESC`).all(tenantId, roleId, roleId)
      : this.db.prepare(`SELECT record FROM organization_role_relations_v1
          WHERE tenant_id=? ORDER BY updated_at DESC`).all(tenantId);
    return parseRows<SocietyRoleRelation>(rows as { record: string }[]);
  }
}

export class OrganizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'OrganizationError';
  }
}
