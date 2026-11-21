import { createHash, randomUUID } from 'node:crypto';
import { contractArtifactPath } from '../../../kernel/sandbox';
import {
  type ChildRunFallback,
  type PermissionProfile,
  type RunRecord,
} from '../../../kernel/run';
import { validateTaskContract, type TaskCriterion } from '../../../kernel/task-verifier';
import { estimateTokens } from '../../../kernel/tokens';
import type { Store } from '../../db';
import {
  estimateModelWorkloadCost,
  resolvePricedModel,
  type PricedModel,
} from '../../model-cost-estimator';
import {
  OrganizationError,
  type AssignmentContract,
  type AssignmentDelivery,
  type EvaluationPolicy,
  type EvaluationVersion,
  type EvidenceRef,
  type ExceptionCase,
  type InstitutionProposal,
  type OrganizationRole,
  type OrganizationRoleGovernance,
  type OrganizationVersionAudit,
  type RoleVersion,
  type RoleScorecard,
  type RoleWellbeingSnapshot,
  type SocietySchedule,
  type SocietyAuditEntry,
  type SocietyTask,
  type TeamCycle,
  type TeamEconomics,
  type WorkLedgerEntry,
  type WorkOrder,
  type WorkReceipt,
} from '../../organization-store';
import { REVIEW_DIMENSIONS, REVIEW_RUBRIC_VERSION, REVIEW_SYSTEM_PROMPT } from '../../review-rubric';
import { buildScorecards, buildWellbeing } from './projections';

export interface AssignmentDraft {
  roleId?: string;
  roleName?: string;
  objective: string;
  expectedArtifacts: string[];
  acceptance: string[];
  evidenceInputs?: EvidenceRef[];
  dependsOn?: string[];
  budgetUsd?: number;
  allowedTools?: string[];
}

export interface TeamCreateInput {
  assignments: AssignmentDraft[];
  /** Retained for API compatibility. The service derives its own cost baseline. */
  singleAgentEstimateUsd?: number;
  /** Retained for API compatibility. The service derives its own cost baseline. */
  teamEstimateUsd?: number;
  reason?: string;
}

export interface SocietyExecutionPlan {
  workOrder: WorkOrder;
  teamCycle?: TeamCycle;
  roles: OrganizationRole[];
  contracts: AssignmentContract[];
}

export interface OrganizationDetail {
  workOrder: WorkOrder;
  teamCycles: TeamCycle[];
  roles: OrganizationRole[];
  contracts: AssignmentContract[];
  ledger: WorkLedgerEntry[];
  societyAudits: SocietyAuditEntry[];
  receipt?: WorkReceipt;
  exceptions: ExceptionCase[];
  economics: TeamEconomics;
  scorecards: RoleScorecard[];
  wellbeing: RoleWellbeingSnapshot[];
}

export interface OrganizationServiceOptions {
  store: Store;
  emit?: (type: string, data: Record<string, unknown>) => void;
  runtimeAuthority?: (tenantId: string) => {
    workspace: string;
    readOnly: boolean;
    profile: PermissionProfile;
    allowedTools?: string[];
  };
  /** Injectable clock so scheduling, budgets and audit records are deterministic in tests. */
  now?: () => number;
  /** Goal/plan facts are supplied by the host adapter; organization must not import core/goal-plan. */
  goalPlan?: {
    currentPlan(tenantId: string, sessionId: string): { workItems?: Array<{ dependsOn: string[] }> } | undefined;
  };
}

const TEAM_TOOL_NAMES = new Set(['run_subagent', 'run_parallel', 'run_review', 'work_contract_deliver', 'raise_exception']);
const ORGANIZATION_ADVANCED_TOOLS = new Set(['team_create', 'work_contract_create', 'role_scorecard']);
const TEAM_REQUEST = /(团队|小组|多人协作|多个角色|并行|分工|派给|交给.*代理|agent\s*(team|群|组)|subagents?|parallel)/i;
const NEGATED_TEAM_REQUEST = /(?:不要|不用|无需|不需要|别|禁止|不得|暂不)[^，,。！？!?；;\n]{0,16}(?:团队|小组|多个角色|并行|分工|派给|代理|subagents?|parallel)/i;

export function explicitTeamRequest(text: string): boolean {
  return text.split(/[，,。！？!?；;\n]+/).some(clause => TEAM_REQUEST.test(clause) && !NEGATED_TEAM_REQUEST.test(clause));
}

function bounded(text: string, max: number, label: string): string {
  const value = text.trim();
  if (!value) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `${label}不能为空`);
  if (value.length > max) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `${label}过长（最多 ${max} 字）`);
  return value;
}

function evidenceOf(runIds: string[], store: Store, tenantId: string): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  for (const runId of runIds) {
    const run = store.runs.get(runId, tenantId);
    if (!run) continue;
    evidence.push({
      id: `goal:${run.id}`,
      kind: 'goal',
      ref: run.id,
      hash: createHash('sha256').update(run.objective).digest('hex').slice(0, 16),
    });
    for (const artifact of store.runs.artifacts(run.id)) {
      evidence.push({
        id: `artifact:${artifact.id}`,
        kind: 'artifact',
        ref: artifact.ref,
        version: artifact.metadata?.version,
        hash: artifact.metadata?.version,
      });
    }
  }
  return evidence;
}

function cachePrefixHash(input: {
  tenantId: string;
  workspace: string;
  projectId: string;
  providerId: string;
  model: string;
  workOrderId: string;
  materialVersions: { id: string; version: string }[];
  ruleHash?: string;
  toolVersions?: string[];
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function unfinishedForRun(run: RunRecord): string[] {
  const verification = run.verification as { status?: string; checks?: { ok?: boolean; reason?: string }[] } | undefined;
  const failedChecks = verification?.checks
    ?.filter(check => check.ok === false)
    .flatMap(check => check.reason ? [check.reason] : ['验收条件未通过']) ?? [];
  if (verification && 'type' in verification && verification.type === 'task_partial') return failedChecks.length ? failedChecks : ['任务仅部分完成'];
  if (verification && 'type' in verification && verification.type === 'task_failed') return failedChecks.length ? failedChecks : ['任务验收失败'];
  if (run.status !== 'completed') return [run.error ?? `任务未完成：${run.status}`];
  if (verification?.status === 'partial') return failedChecks.length ? failedChecks : ['任务仅部分完成'];
  if (verification?.status === 'failed') return failedChecks.length ? failedChecks : ['任务验收失败'];
  return failedChecks;
}

function artifactMatches(ref: string, expected: string, exact = false): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const target = normalize(expected);
  return normalize(ref) === target || (!exact && normalize(ref).endsWith(`/${target}`));
}

export function taskCriteriaForContract(contract: AssignmentContract): TaskCriterion[] {
  const parsed = contract.acceptance.flatMap(item => {
    if (!item.verification?.trim().startsWith('{')) return [];
    try {
      const criterion = JSON.parse(item.verification) as TaskCriterion;
      return validateTaskContract({ objective: contract.branchObjective, acceptance: [criterion] }).length
        ? []
        : [criterion];
    } catch {
      return [];
    }
  });
  const artifacts = contract.expectedArtifacts.filter(path => !contract.coordinatorArtifacts?.includes(path))
    .filter(Boolean)
    .map(path => ({ type: 'file_exists' as const, path }));
  return [...parsed, ...artifacts]
    .filter((item, index, all) =>
      all.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(item)) === index,
    );
}

function intersectTools(...groups: Array<string[] | undefined>): string[] {
  const constrained = groups.filter((group): group is string[] => !!group?.length);
  if (!constrained.length) return [];
  return [...new Set(constrained[0]!)].filter(name => constrained.slice(1).every(group => group.includes(name)));
}

function narrowProfile(left: PermissionProfile, right: PermissionProfile): PermissionProfile {
  return left === 'developer' && right === 'developer' ? 'developer' : 'standard';
}

const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  schemaVersion: 1,
  lowConfidenceSamples: 3,
  mediumConfidenceSamples: 10,
  highConfidenceSamples: 30,
  rankingWeights: { acceptance: 0.5, budget: 0.3, evidence: 0.2 },
  review: {
    rubricVersion: REVIEW_RUBRIC_VERSION,
    dimensions: [...REVIEW_DIMENSIONS],
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    fast: { input: 3_000, output: 800, total: 3_800 },
    focused: { input: 8_000, output: 1_200, total: 9_200 },
    multi: { input: 10_000, output: 1_500, total: 11_500 },
    positiveMinAverage: 3.5,
    positiveMinReuse: 4,
    positiveMinDimension: 3,
  },
  formula: 'role metrics come from contract and Run facts; review verdict cannot override fact gates',
};

function normalizeEvaluationPolicy(input: Partial<EvaluationPolicy>): EvaluationPolicy {
  const merged = {
    ...DEFAULT_EVALUATION_POLICY,
    ...input,
    rankingWeights: { ...DEFAULT_EVALUATION_POLICY.rankingWeights, ...input.rankingWeights },
    review: {
      ...DEFAULT_EVALUATION_POLICY.review,
      ...input.review,
      fast: { ...DEFAULT_EVALUATION_POLICY.review.fast, ...input.review?.fast },
      focused: { ...DEFAULT_EVALUATION_POLICY.review.focused, ...input.review?.focused },
      multi: { ...DEFAULT_EVALUATION_POLICY.review.multi, ...input.review?.multi },
    },
  };
  const integer = (value: unknown, label: string, min = 1, max = 100_000): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}必须在 ${min} 到 ${max} 之间`);
    return parsed;
  };
  const low = integer(merged.lowConfidenceSamples, '低置信度样本门槛', 2, 10_000);
  const medium = integer(merged.mediumConfidenceSamples, '中置信度样本门槛', low + 1, 10_000);
  const high = integer(merged.highConfidenceSamples, '高置信度样本门槛', medium + 1, 100_000);
  const weights = Object.fromEntries(Object.entries(merged.rankingWeights).map(([key, value]) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '角色排序权重必须在 0 到 1 之间');
    return [key, parsed];
  })) as EvaluationPolicy['rankingWeights'];
  const weightTotal = weights.acceptance + weights.budget + weights.evidence;
  if (weightTotal <= 0)
    throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '角色排序权重之和必须大于 0');
  const rubricDimensions = [...new Set((merged.review.dimensions ?? DEFAULT_EVALUATION_POLICY.review.dimensions)
    .map(item => bounded(String(item), 80, '复盘维度')))].slice(0, 20);
  if (!rubricDimensions.length)
    throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '复盘 Rubric 至少需要一个维度');
  const limit = (value: unknown, label: string, max: number): number => integer(value, label, 1, max);
  const budget = (value: EvaluationPolicy['review']['fast'], label: string) => {
    const inputTokens = limit(value.input, `${label}输入 token 上限`, 100_000);
    const outputTokens = limit(value.output, `${label}输出 token 上限`, 100_000);
    const total = limit(value.total, `${label}总 token 上限`, 200_000);
    if (total < inputTokens + outputTokens)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}总 token 上限不能小于输入与输出之和`);
    return { input: inputTokens, output: outputTokens, total };
  };
  const decimal = (value: unknown, label: string, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}必须在 ${min} 到 ${max} 之间`);
    return Math.round(parsed * 100) / 100;
  };
  return {
    schemaVersion: 1,
    lowConfidenceSamples: low,
    mediumConfidenceSamples: medium,
    highConfidenceSamples: high,
    rankingWeights: {
      acceptance: weights.acceptance / weightTotal,
      budget: weights.budget / weightTotal,
      evidence: weights.evidence / weightTotal,
    },
    review: {
      rubricVersion: bounded(merged.review.rubricVersion, 100, '复盘 Rubric 版本'),
      dimensions: rubricDimensions,
      systemPrompt: bounded(merged.review.systemPrompt ?? DEFAULT_EVALUATION_POLICY.review.systemPrompt, 4_000, '复盘提示词'),
      fast: budget(merged.review.fast, '快速复盘'),
      focused: budget(merged.review.focused, '聚焦复盘'),
      multi: budget(merged.review.multi, '多 Run 复盘'),
      positiveMinAverage: decimal(merged.review.positiveMinAverage, '正面平均分门槛', 1, 5),
      positiveMinReuse: integer(merged.review.positiveMinReuse, '再次使用意愿门槛', 1, 5),
      positiveMinDimension: integer(merged.review.positiveMinDimension, '单个维度最低分', 1, 5),
      ...(merged.review.providerId
        ? { providerId: bounded(merged.review.providerId, 100, '复盘供应商') }
        : {}),
      ...(merged.review.model ? { model: bounded(merged.review.model, 200, '复盘模型') } : {}),
    },
    formula: bounded(merged.formula, 1_000, '评价公式'),
  };
}

function validateSocietyDependencies(contracts: AssignmentContract[]): void {
  const byId = new Map(contracts.map(contract => [contract.id, contract]));
  for (const contract of contracts) {
    if (contract.dependsOn.some(id => !byId.has(id) || id === contract.id))
      throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '社会分工依赖引用无效');
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (contract: AssignmentContract): void => {
    const mark = state.get(contract.id) ?? 0;
    if (mark === 1) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '社会分工依赖存在循环');
    if (mark === 2) return;
    state.set(contract.id, 1);
    for (const dependencyId of contract.dependsOn) visit(byId.get(dependencyId)!);
    state.set(contract.id, 2);
  };
  for (const contract of contracts) visit(contract);
}

function rootAnswer(workOrder: WorkOrder, run: RunRecord, contracts: AssignmentContract[]): string {
  if ((!workOrder.rootRunId || workOrder.rootRunId === run.id) && run.answer?.trim()) return run.answer;
  return contracts.flatMap(contract => contract.delivery?.summary ? [contract.delivery.summary] : []).join('\n\n');
}

export class OrganizationService {
  private readonly repo;
  private readonly now: () => number;

  constructor(private readonly options: OrganizationServiceOptions) {
    this.repo = options.store.organization;
    this.now = options.now ?? Date.now;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.options.emit?.(type, data);
  }

  ensureEvaluation(tenantId: string): EvaluationVersion {
    const active = this.repo.activeOrganizationVersion<EvaluationPolicy>('evaluation', tenantId, 'default');
    if (active) {
      const policy = normalizeEvaluationPolicy(active.record);
      if (JSON.stringify(policy) === JSON.stringify(active.record)) return active;
      const now = this.now();
      const version: EvaluationVersion = {
        id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default',
        version: active.version + 1, status: 'active', record: policy,
        hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
        createdBy: 'maharness', reason: '补齐冻结复盘 Rubric', createdAt: now,
      };
      this.repo.transaction(() => {
        this.repo.supersedeOrganizationVersions(tenantId, 'evaluation', 'default', version.version);
        this.repo.createOrganizationVersion(version);
        this.repo.appendOrganizationVersionAudit({
          id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default', version: version.version,
          action: 'update', actor: 'maharness', fromVersion: active.version, toVersion: version.version,
          beforeHash: active.hash, afterHash: version.hash, reason: version.reason, createdAt: now,
        });
      });
      return version;
    }
    const policy = normalizeEvaluationPolicy(DEFAULT_EVALUATION_POLICY);
    const now = this.now();
    const hash = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    const version: EvaluationVersion = {
      id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default', version: 1,
      status: 'active', record: policy, hash, createdBy: 'maharness',
      reason: '初始化评价标准', createdAt: now,
    };
    this.repo.transaction(() => {
      this.repo.createOrganizationVersion(version);
      this.repo.appendOrganizationVersionAudit({
        id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default', version: 1,
        action: 'initialize', actor: 'maharness', toVersion: 1, afterHash: hash,
        reason: version.reason, createdAt: now,
      });
    });
    return version;
  }

  evaluationHistory(tenantId: string): {
    active: EvaluationVersion;
    versions: EvaluationVersion[];
    audits: OrganizationVersionAudit[];
  } {
    const active = this.ensureEvaluation(tenantId);
    return {
      active,
      versions: this.repo.organizationVersions<EvaluationPolicy>('evaluation', tenantId, 'default', 100),
      audits: this.repo.organizationVersionAudits('evaluation', tenantId, 'default', 100),
    };
  }

  updateEvaluation(tenantId: string, input: Partial<EvaluationPolicy>, reason: string): EvaluationVersion {
    const current = this.ensureEvaluation(tenantId);
    const policy = normalizeEvaluationPolicy({ ...current.record, ...input });
    const version: EvaluationVersion = {
      id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default',
      version: current.version + 1, status: 'active', record: policy,
      hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
      createdBy: 'human', reason: bounded(reason, 500, '评价标准变更原因'), createdAt: this.now(),
    };
    this.repo.transaction(() => {
      this.repo.supersedeOrganizationVersions(tenantId, 'evaluation', 'default', version.version);
      this.repo.createOrganizationVersion(version);
      this.repo.appendOrganizationVersionAudit({
        id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default', version: version.version,
        action: 'update', actor: 'human', fromVersion: current.version, toVersion: version.version,
        beforeHash: current.hash, afterHash: version.hash, reason: version.reason, createdAt: version.createdAt,
      });
    });
    this.emit('organization.evaluation.updated', { version: version.version, hash: version.hash });
    return version;
  }

  rollbackEvaluation(tenantId: string, targetVersion: number, reason: string): EvaluationVersion {
    const current = this.ensureEvaluation(tenantId);
    const target = this.repo.organizationVersions<EvaluationPolicy>('evaluation', tenantId, 'default', 500)
      .find(item => item.version === targetVersion);
    if (!target) throw new OrganizationError(404, 'EVALUATION_VERSION_NOT_FOUND', '评价标准版本不存在');
    if (target.status === 'active') return current;
    const policy = normalizeEvaluationPolicy(target.record);
    const version: EvaluationVersion = {
      id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default',
      version: current.version + 1, status: 'active', record: policy,
      hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
      createdBy: 'human', reason: `回滚至 v${targetVersion}：${bounded(reason, 450, '评价标准回滚原因')}`,
      createdAt: this.now(),
    };
    this.repo.transaction(() => {
      this.repo.supersedeOrganizationVersions(tenantId, 'evaluation', 'default', version.version);
      this.repo.createOrganizationVersion(version);
      this.repo.appendOrganizationVersionAudit({
        id: randomUUID(), tenantId, kind: 'evaluation', subjectId: 'default', version: version.version,
        action: 'rollback', actor: 'human', fromVersion: current.version, toVersion: version.version,
        beforeHash: current.hash, afterHash: version.hash, reason: version.reason, createdAt: version.createdAt,
      });
    });
    this.emit('organization.evaluation.updated', { version: version.version, rollbackTo: targetVersion });
    return version;
  }

  roleHistory(id: string, tenantId: string): {
    role: OrganizationRole;
    versions: RoleVersion[];
    audits: OrganizationVersionAudit[];
  } {
    const role = this.repo.getRole(id, tenantId);
    if (!role) throw new OrganizationError(404, 'ROLE_NOT_FOUND', '角色不存在');
    return {
      role,
      versions: this.repo.organizationVersions<OrganizationRoleGovernance>('role', tenantId, id, 100),
      audits: this.repo.organizationVersionAudits('role', tenantId, id, 100),
    };
  }

  updateRole(
    id: string,
    tenantId: string,
    revision: number,
    patch: Partial<Pick<OrganizationRole,
      'projectId' | 'name' | 'responsibilities' | 'capabilities' | 'modelPolicy' |
      'budgetLimitUsd' | 'budgetLimitTokens' | 'persistent' | 'employment'>>,
    reason: string,
  ): OrganizationRole {
    const role = this.repo.getRole(id, tenantId);
    if (!role) throw new OrganizationError(404, 'ROLE_NOT_FOUND', '角色不存在');
    const normalized: typeof patch = {};
    if (patch.projectId !== undefined) normalized.projectId = String(patch.projectId).trim().slice(0, 300);
    if (patch.name !== undefined) normalized.name = bounded(String(patch.name), 80, '角色名称');
    if (patch.responsibilities !== undefined)
      normalized.responsibilities = [...new Set(patch.responsibilities.map(item =>
        bounded(String(item), 300, '角色职责')))].slice(0, 20);
    if (patch.capabilities !== undefined)
      normalized.capabilities = [...new Set(patch.capabilities.map(item =>
        bounded(String(item), 80, '角色能力')))].slice(0, 30);
    if (patch.modelPolicy !== undefined) {
      const providerId = String(patch.modelPolicy.providerId ?? '').trim();
      const model = String(patch.modelPolicy.model ?? '').trim();
      if (!providerId || !model)
        throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '角色模型策略不能为空');
      normalized.modelPolicy = { providerId: providerId.slice(0, 200), model: model.slice(0, 200) };
    }
    for (const field of ['budgetLimitUsd', 'budgetLimitTokens'] as const) {
      if (patch[field] === undefined) continue;
      const value = Number(patch[field]);
      if (!Number.isFinite(value) || value < 0)
        throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '角色预算上限必须是非负数');
      normalized[field] = value;
    }
    if (patch.persistent !== undefined) normalized.persistent = Boolean(patch.persistent);
    if (patch.employment !== undefined) {
      if (patch.employment !== 'active' && patch.employment !== 'paused')
        throw new OrganizationError(400, 'ROLE_CONFIG_INVALID', '角色岗位状态无效');
      normalized.employment = patch.employment;
    }
    const updated = this.repo.updateRole(role, normalized, revision, {
      actor: 'human', reason: bounded(reason, 500, '角色变更原因'),
    });
    this.emit('organization.role.updated', { roleId: id, revision: updated.revision });
    return updated;
  }

  rollbackRole(id: string, tenantId: string, targetVersion: number, reason: string): OrganizationRole {
    const role = this.repo.getRole(id, tenantId);
    if (!role) throw new OrganizationError(404, 'ROLE_NOT_FOUND', '角色不存在');
    const currentVersion = this.repo.activeOrganizationVersion<OrganizationRoleGovernance>('role', tenantId, id);
    if (!currentVersion) throw new OrganizationError(409, 'ROLE_VERSION_MISSING', '角色没有可回滚的版本历史');
    if (currentVersion.version === targetVersion) return role;
    const target = this.repo.organizationVersions<OrganizationRoleGovernance>('role', tenantId, id, 500)
      .find(item => item.version === targetVersion);
    if (!target) throw new OrganizationError(404, 'ROLE_VERSION_NOT_FOUND', '角色版本不存在');
    const snapshot = target.record;
    const updated = this.repo.updateRole(role, {
      projectId: snapshot.projectId,
      name: snapshot.name,
      responsibilities: snapshot.responsibilities,
      capabilities: snapshot.capabilities,
      modelPolicy: snapshot.modelPolicy,
      budgetLimitUsd: snapshot.budgetLimitUsd,
      budgetLimitTokens: snapshot.budgetLimitTokens,
      persistent: snapshot.persistent,
      employment: snapshot.employment,
    }, role.revision, {
      actor: 'human', action: 'rollback', fromVersion: currentVersion.version,
      reason: `回滚至 v${targetVersion}：${bounded(reason, 450, '角色回滚原因')}`,
    });
    this.emit('organization.role.updated', { roleId: id, revision: updated.revision, rollbackTo: targetVersion });
    return updated;
  }

  private bindRuntimeAuthority(role: OrganizationRole): OrganizationRole {
    const runtime = this.options.runtimeAuthority?.(role.tenantId);
    const workspace = role.authority.workspace || runtime?.workspace || '';
    if (!workspace)
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色没有可执行的工作区权限');
    if (role.authority.workspace && runtime?.workspace && role.authority.workspace !== runtime.workspace)
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色工作区权限与当前运行时不匹配');
    const authority = {
      workspace,
      readOnly: role.authority.readOnly || (runtime?.readOnly ?? false),
      profile: runtime ? narrowProfile(role.authority.profile, runtime.profile) : role.authority.profile,
      allowedTools: intersectTools(role.authority.allowedTools, runtime?.allowedTools),
    };
    if (JSON.stringify(authority) === JSON.stringify(role.authority)) return role;
    return this.repo.updateRole(role, { authority }, role.revision, { trackVersion: false });
  }

  private scopeRunToRole(run: RunRecord, role: OrganizationRole): OrganizationRole {
    const current = this.repo.getRole(role.id, run.tenantId) ?? role;
    if (current.authority.workspace && current.authority.workspace !== run.authorization.workspace)
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色工作区权限与任务工作区不一致');
    const authority = {
      ...current.authority,
      workspace: run.authorization.workspace,
    };
    const scoped = JSON.stringify(authority) === JSON.stringify(current.authority)
      ? current
      : this.repo.updateRole(current, { authority }, current.revision, { trackVersion: false });
    run.authorization = {
      ...run.authorization,
      readOnly: run.authorization.readOnly || scoped.authority.readOnly,
      profile: narrowProfile(run.authorization.profile, scoped.authority.profile),
    };
    if (scoped.authority.allowedTools.length)
      run.toolNames = intersectTools(run.toolNames, scoped.authority.allowedTools);
    return scoped;
  }

  assumeRole(run: RunRecord, roleId: string): OrganizationRole {
    if (run.parentId || run.teamCycleId) throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '已有分工的任务不能切换承接角色');
    const order = this.workOrderForRun(run);
    const role = this.repo.getRole(roleId, run.tenantId);
    if (!role || !role.persistent || role.employment !== 'active') throw new OrganizationError(404, 'ROLE_NOT_FOUND', '持久角色不存在或不可用');
    if (role.projectId && role.projectId !== order.projectId) throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色不属于当前项目');
    const contract = this.repo.contracts(order.id, run.tenantId).find(item => item.id === run.assignmentContractId);
    if (!contract || contract.status !== 'active') throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '当前契约不可切换角色');
    const scoped = this.scopeRunToRole(run, role);
    this.repo.transaction(() => {
      this.repo.updateContract(contract, { roleId: role.id, allowedTools: run.toolNames ?? [] }, contract.revision);
      this.options.store.runs.update(run, { organizationRoleId: role.id, authorization: run.authorization, toolNames: run.toolNames }, 'role_selected', { roleId: role.id, contractId: contract.id });
      this.repo.appendLedger({ id: randomUUID(), tenantId: run.tenantId, workOrderId: order.id, contractId: contract.id, type: 'accepted', actorId: role.id, summary: '承接角色已选择', evidence: [], createdAt: this.now() });
    });
    this.emit('organization.updated', { workOrderId: order.id, roleId: role.id });
    return scoped;
  }

  createForRun(run: RunRecord, projectId = ''): WorkOrder {
    const soloRole = this.repo.ensureSoloRole(
      run.tenantId, run.providerId, run.model, run.authorization, projectId,
    );
    const workOrder = run.reworkOfRunId ? this.workOrderForRun(run) : this.repo.createWorkOrder({
      tenantId: run.tenantId,
      projectId,
      sessionId: run.sessionId,
      rootRunId: run.id,
      objective: run.objective,
      acceptance: run.acceptance?.map((item, index) => ({
        id: `acceptance-${index + 1}`,
        statement: item.type === 'output_contains' ? item.value
          : item.type === 'output_matches' ? item.pattern
          : item.type === 'tool_succeeded' ? item.name
          : item.type === 'tool_evidence' ? item.name
          : item.type === 'file_exists' || item.type === 'file_contains' ? item.path
          : '任务验收条件',
        verification: item.type,
      })),
      budgetUsd: run.budgetUsd,
      budgetTokens: run.budgetTokens,
      budgetPolicy: run.budgetPolicy,
      deadlineAt: run.deadlineAt,
      materials: run.materials,
      authorization: run.authorization,
      operationKey: run.requestFingerprint,
    });
    const existing = this.repo.contracts(workOrder.id, run.tenantId).find(contract => contract.runId === run.id);
    if (!existing) {
      const now = this.now();
      const contract: AssignmentContract = {
        id: randomUUID(),
        tenantId: run.tenantId,
        workOrderId: workOrder.id,
        roleId: soloRole.id,
        runId: run.id,
        branchObjective: run.objective,
        expectedArtifacts: [],
        acceptance: workOrder.acceptance,
        evidenceInputs: workOrder.materials.map(material => ({
          id: `material:${material.id}:${material.version}`,
          kind: 'material',
          ref: material.id,
          version: material.version,
        })),
        dependsOn: [],
        budgetUsd: run.budgetUsd,
        deadlineAt: run.deadlineAt,
        allowedTools: run.toolNames ?? [],
        status: 'active',
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.createContract(contract);
      this.repo.appendLedger({
        id: randomUUID(),
        tenantId: run.tenantId,
        workOrderId: workOrder.id,
        contractId: contract.id,
        type: 'accepted',
        actorId: soloRole.id,
        summary: '单角色工作契约已建立',
        evidence: [],
        createdAt: now,
      });
    }
    run.workOrderId = workOrder.id;
    if (run.reworkOfRunId) this.repo.updateWorkOrder(workOrder, { status: 'active' }, workOrder.revision);
    run.assignmentContractId = existing?.id ?? this.repo.contracts(workOrder.id, run.tenantId).find(contract => contract.runId === run.id)?.id;
    run.organizationRoleId = soloRole.id;
    run.cachePrefixHash = cachePrefixHash({
      tenantId: run.tenantId,
      workspace: run.authorization.workspace,
      projectId: workOrder.projectId,
      providerId: run.providerId,
      model: run.model,
      workOrderId: workOrder.id,
      materialVersions: workOrder.materials,
      ruleHash: createHash('sha256').update(JSON.stringify(run.ruleResolution ?? null)).digest('hex').slice(0, 24),
    });
    this.emit('work.order.updated', { workOrderId: workOrder.id, status: workOrder.status });
    return workOrder;
  }

  createSocietyExecution(task: SocietyTask, schedule: SocietySchedule): SocietyExecutionPlan {
    const roles = schedule.assignments.map(assignment => {
      const role = this.repo.getRole(assignment.roleId, schedule.tenantId);
      if (!role || role.employment !== 'active')
        throw new OrganizationError(409, 'ROLE_AUTHORITY_EXCEEDED', `社会角色不可用：${assignment.roleId}`);
      return this.bindRuntimeAuthority(role);
    });
    const primary = roles[0];
    if (!primary) throw new OrganizationError(409, 'ROLE_NOT_FOUND', '社会任务没有可执行角色');
    const operationKey = `society-task:${task.id}`;
    const workOrder = this.repo.createWorkOrder({
      tenantId: task.tenantId,
      projectId: task.projectId,
      originKind: 'society-task',
      originId: task.id,
      objective: task.objective,
      acceptance: task.acceptance.map((statement, index) => ({
        id: `acceptance-${index + 1}`,
        statement,
        verification: 'society-task',
      })),
      budgetUsd: task.maxBudgetUsd,
      budgetTokens: task.maxBudgetTokens,
      budgetPolicy: 'enforce',
      materials: task.materials.map(({ id, version }) => ({
        id, version, path: '', name: '', format: '', size: 0, createdAt: this.now(),
        tenantId: task.tenantId, workspace: primary.authority.workspace,
      })),
      authorization: { ...primary.authority, revision: 0 },
      creator: 'maharness',
      operationKey,
    });
    const scheduledContractIds = new Set(schedule.contractIds ?? []);
    const existing = this.repo.contracts(workOrder.id, task.tenantId)
      .filter(contract => !scheduledContractIds.size || scheduledContractIds.has(contract.id));
    if (existing.length) {
      return {
        workOrder,
        teamCycle: this.repo.listTeamCycles(workOrder.id, task.tenantId).at(-1),
        roles,
        contracts: existing,
      };
    }
    const now = this.now();
    const teamCycle: TeamCycle | undefined = schedule.mode === 'team' ? {
      id: randomUUID(), tenantId: task.tenantId, workOrderId: workOrder.id,
      assignmentIds: [], soloEstimateUsd: schedule.estimates.soloCostUsd,
      teamEstimateUsd: schedule.estimates.teamCostUsd, hardBudget: true,
      reason: schedule.reason, status: 'planned', revision: 0, createdAt: now, updatedAt: now,
    } : undefined;
    const contracts = schedule.assignments.map((assignment, index): AssignmentContract => {
      const role = roles[index];
      const budgetUsd = assignment.cognitiveTier === 'utility'
        ? 0
        : task.maxBudgetUsd / schedule.assignments.length;
      return {
        id: randomUUID(), tenantId: task.tenantId, workOrderId: workOrder.id,
        teamCycleId: teamCycle?.id, roleId: role.id, departmentId: assignment.departmentId,
        branchObjective: assignment.branchObjective,
        expectedArtifacts: assignment.expectedArtifacts,
        acceptance: assignment.acceptance.map((statement, acceptanceIndex) => ({
          id: `acceptance-${acceptanceIndex + 1}`, statement,
        })),
        evidenceInputs: schedule.sharedMemoryRefs,
        dependsOn: [],
        budgetUsd,
        budgetTokens: assignment.budgetTokens,
        deadlineAt: workOrder.deadlineAt,
        allowedTools: role.authority.allowedTools,
        status: 'proposed', revision: 0, createdAt: now, updatedAt: now,
      };
    });
    for (let index = 0; index < contracts.length; index += 1) {
      const contract = contracts[index]!;
      contract.dependsOn = [...new Set(schedule.assignments[index]!.dependsOn)].map(reference => {
        const match = /^(?:assignment|branch)-(\d+)$/.exec(reference);
        const numeric = match ? Number(match[1]) - 1 : /^\d+$/.test(reference) ? Number(reference) : -1;
        const dependency = contracts[numeric];
        if (!dependency || dependency.id === contract.id)
          throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `社会分工依赖引用无效：${reference}`);
        return dependency.id;
      });
    }
    validateSocietyDependencies(contracts);
    if (teamCycle) teamCycle.assignmentIds = contracts.map(contract => contract.id);
    this.repo.transaction(() => {
      if (teamCycle) this.repo.createTeamCycle(teamCycle);
      for (const contract of contracts) this.repo.createContract(contract);
      for (const contract of contracts) this.repo.appendLedger({
        id: randomUUID(), tenantId: task.tenantId, workOrderId: workOrder.id,
        contractId: contract.id, type: 'commitment', actorId: contract.roleId,
        summary: contract.branchObjective, evidence: contract.evidenceInputs, createdAt: now,
      });
    });
    return { workOrder, teamCycle, roles, contracts };
  }

  prepareSocietyRun(run: RunRecord, contractId: string): AssignmentContract {
    const contract = this.repo.getContract(contractId, run.tenantId);
    if (!contract) throw new OrganizationError(404, 'WORK_CONTRACT_INVALID', '社会分工契约不存在');
    if (contract.status !== 'proposed')
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '社会分工契约已被占用或关闭');
    if (contract.roleId !== run.organizationRoleId || contract.workOrderId !== run.workOrderId)
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色或工作单与分工契约不一致');
    const dependencies = contract.dependsOn.map(id => this.repo.getContract(id, run.tenantId));
    if (dependencies.some(item => !item || item.status !== 'delivered' || (item.delivery?.unfinished.length ?? 1) > 0))
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '分工依赖尚未成功交付');
    const role = this.repo.getRole(contract.roleId, run.tenantId);
    if (!role || role.employment !== 'active')
      throw new OrganizationError(409, 'ROLE_AUTHORITY_EXCEEDED', '社会分工角色不可用');
    const scopedRole = this.scopeRunToRole(run, role);
    const requestedTools = intersectTools(contract.allowedTools, scopedRole.authority.allowedTools);
    if (contract.allowedTools.length && scopedRole.authority.allowedTools.length
      && requestedTools.length !== new Set(contract.allowedTools).size)
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '社会合同扩大了角色工具权限');
    if (contract.allowedTools.length) run.toolNames = requestedTools;
    else if (scopedRole.authority.allowedTools.length)
      run.toolNames = intersectTools(run.toolNames, scopedRole.authority.allowedTools);
    run.cachePrefixHash = cachePrefixHash({
      tenantId: run.tenantId,
      workspace: run.authorization.workspace,
      projectId: this.repo.getWorkOrder(contract.workOrderId, run.tenantId)?.projectId ?? '',
      providerId: run.providerId,
      model: run.model,
      workOrderId: contract.workOrderId,
      materialVersions: [...(this.repo.getWorkOrder(contract.workOrderId, run.tenantId)?.materials ?? [])]
        .sort((left, right) => left.id.localeCompare(right.id)),
      ruleHash: createHash('sha256').update(JSON.stringify(run.ruleResolution ?? null)).digest('hex').slice(0, 24),
      toolVersions: [...new Set(run.toolNames ?? [])].sort(),
    });
    const updated = this.repo.updateContract(contract, { runId: run.id, status: 'active' }, contract.revision);
    if (contract.teamCycleId) {
      const cycle = this.repo.getTeamCycle(contract.teamCycleId, run.tenantId);
      if (cycle?.status === 'planned') this.repo.updateTeamCycle(cycle, { status: 'running' });
    }
    this.repo.appendLedger({
      id: randomUUID(), tenantId: run.tenantId, workOrderId: contract.workOrderId,
      contractId: contract.id, type: 'started', actorId: contract.roleId,
      summary: `开始执行：${contract.branchObjective}`, evidence: contract.evidenceInputs, createdAt: this.now(),
    });
    this.emit('work.contract.updated', { workOrderId: contract.workOrderId, contractId: contract.id, status: 'active', runId: run.id });
    return updated;
  }

  workOrderForRun(run: RunRecord): WorkOrder {
    const order = run.workOrderId ? this.repo.getWorkOrder(run.workOrderId, run.tenantId)
      : this.repo.workOrderByRun(run.rootId, run.tenantId) ?? this.repo.workOrderByRun(run.id, run.tenantId);
    if (!order) throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '任务没有关联工作单');
    return order;
  }

  isTeamTool(name: string): boolean {
    return TEAM_TOOL_NAMES.has(name);
  }

  teamEligible(run: RunRecord): boolean {
    if (run.parentId || run.depth > 0 || run.origin?.kind === 'society') return false;
    const cycle = run.teamCycleId ? this.repo.getTeamCycle(run.teamCycleId, run.tenantId) : undefined;
    return !!cycle && ['planned', 'running'].includes(cycle.status);
  }

  teamPlanningEligible(run: RunRecord): boolean {
    if (run.origin?.kind === 'society' || run.parentId || run.teamCycleId) return false;
    if (explicitTeamRequest(run.objective)) return true;
    const workItems = this.options.goalPlan?.currentPlan(run.tenantId, run.sessionId)?.workItems ?? [];
    return workItems.length >= 2 && workItems.length <= 5 && workItems.filter(item => item.dependsOn.length === 0).length >= 2;
  }

  authorizeTools(run: RunRecord, tools: import('../../../kernel/types').ToolDef[]): import('../../../kernel/types').ToolDef[] {
    const team = this.teamEligible(run);
    const planning = !team && this.teamPlanningEligible(run);
    const role = run.organizationRoleId ? this.repo.getRole(run.organizationRoleId, run.tenantId) : undefined;
    const allowedNames = intersectTools(run.toolNames, role?.authority.allowedTools);
    return tools.filter(tool => !TEAM_TOOL_NAMES.has(tool.name) || team)
      .filter(tool => !ORGANIZATION_ADVANCED_TOOLS.has(tool.name) || planning)
      .filter(tool => run.toolNames === undefined && !role?.authority.allowedTools.length || allowedNames.includes(tool.name))
      .filter(tool => tool.delegates || tool.sideEffect === 'none' || tool.sideEffect === 'read'
        || (!run.authorization.readOnly && !role?.authority.readOnly && (!run.authorization.artifactWritePaths || ['write_file', 'edit_file'].includes(tool.name))));
  }

  createTeam(run: RunRecord, input: TeamCreateInput): { teamCycle: TeamCycle; contracts: AssignmentContract[]; economics: TeamEconomics } {
    if (run.origin?.kind === 'society')
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '社会分工不能再次创建团队');
    if (run.parentId) throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '只有主任务可以组织团队');
    const workOrder = this.workOrderForRun(run);
    if (workOrder.status !== 'active') throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '工作单当前不可组队');
    if (input.assignments.length < 2 || input.assignments.length > 5)
      throw new OrganizationError(400, 'TEAM_NOT_ELIGIBLE', '团队需要 2 至 5 个可独立验收的分工契约');
    if (this.repo.listTeamCycles(workOrder.id, run.tenantId).some(cycle => !['completed', 'cancelled', 'dissolved'].includes(cycle.status)))
      throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '当前工作单已有组织周期');

    const objectives = new Set<string>();
    const artifacts = new Set<string>();
    const roots: string[] = [];
    const drafts = input.assignments.map((draft, index) => {
      const objective = bounded(draft.objective, 800, `分工 ${index + 1} 的目标`);
      if (objectives.has(objective.toLowerCase())) throw new OrganizationError(400, 'ASSIGNMENT_OVERLAP', '分工目标重复');
      objectives.add(objective.toLowerCase());
      const expectedArtifacts = [...new Set(draft.expectedArtifacts.map(item => bounded(item, 200, '预期产物')))];
      for (const artifact of expectedArtifacts) {
        const key = (contractArtifactPath(run.authorization.workspace, artifact) ?? artifact.replace(/\\/g, '/')).toLowerCase();
        if (artifacts.has(key)) throw new OrganizationError(400, 'ASSIGNMENT_OVERLAP', `产物范围重叠：${artifact}`);
        artifacts.add(key);
      }
      const acceptance = [...new Set(draft.acceptance.map(item => bounded(item, 300, '验收条件')))];
      if (!acceptance.length) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `分工 ${index + 1} 缺少验收条件`);
      if (draft.budgetUsd !== undefined && (!Number.isFinite(draft.budgetUsd) || draft.budgetUsd <= 0))
        throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `分工 ${index + 1} 预算必须为正数`);
      const dependsOn = [...new Set(draft.dependsOn ?? [])];
      if (!dependsOn.length) roots.push(objective);
      return { ...draft, objective, expectedArtifacts, acceptance, dependsOn };
    });
    if (roots.length < 2) throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '至少需要两个互不依赖的独立分支');
    const ids = new Set(drafts.map((_, index) => `assignment-${index + 1}`));
    for (const draft of drafts) {
      if (draft.dependsOn.some(id => !ids.has(id) || id === `assignment-${drafts.indexOf(draft) + 1}`))
        throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '分工依赖引用无效');
    }
    const authoritativeCost = this.teamCostEstimate(run, workOrder, drafts);
    const teamEstimateUsd = authoritativeCost.teamEstimateUsd;
    const available = this.options.store.runs.availableBudget(run);
    if (run.budgetPolicy === 'enforce' && available !== undefined && (teamEstimateUsd !== undefined && teamEstimateUsd > available + 1e-10
      || drafts.reduce((sum, item) => sum + (item.budgetUsd ?? 0), 0) > available + 1e-10))
      throw new OrganizationError(409, 'TEAM_BUDGET_INSUFFICIENT', '团队估算超过主任务可用硬预算');
    const humanRequested = explicitTeamRequest(run.objective);

    const now = this.now();
    const cycle: TeamCycle = {
      id: randomUUID(), tenantId: run.tenantId, workOrderId: workOrder.id,
      assignmentIds: [], soloEstimateUsd: authoritativeCost.singleAgentEstimateUsd,
      teamEstimateUsd, hardBudget: workOrder.budgetPolicy === 'enforce' && workOrder.budgetUsd !== undefined,
      reason: input.reason?.trim() || (humanRequested ? '人类明确要求组织执行' : '独立分支与可检查交付'),
      status: 'planned', revision: 0, createdAt: now, updatedAt: now,
    };
    const contracts: AssignmentContract[] = drafts.map((draft, index) => {
      const role = this.resolveRole(run, workOrder, draft, index);
      const requestedTools = draft.allowedTools ?? role.authority.allowedTools;
      if (run.toolNames && requestedTools.some(name => !run.toolNames!.includes(name)))
        throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色不能获得父任务之外的工具权限');
      if (role.authority.allowedTools.length
        && requestedTools.some(name => !role.authority.allowedTools.includes(name)))
        throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '分工不能扩大角色工具权限');
      return {
        id: randomUUID(), tenantId: run.tenantId, workOrderId: workOrder.id,
        teamCycleId: cycle.id, roleId: role.id, branchObjective: draft.objective,
        expectedArtifacts: draft.expectedArtifacts,
        acceptance: draft.acceptance.map((statement, acceptanceIndex) => ({ id: `acceptance-${acceptanceIndex + 1}`, statement })),
        evidenceInputs: draft.evidenceInputs ?? [],
        dependsOn: draft.dependsOn,
        budgetUsd: draft.budgetUsd ?? workOrder.budgetUsd, deadlineAt: workOrder.deadlineAt,
        allowedTools: intersectTools(requestedTools, role.authority.allowedTools, run.toolNames),
        status: 'proposed' as const, revision: 0, createdAt: now, updatedAt: now,
      };
    });
    for (const contract of contracts) {
      contract.dependsOn = contract.dependsOn.map(id => {
        const target = Number(id.replace('assignment-', '')) - 1;
        return contracts[target]?.id ?? id;
      });
    }
    validateSocietyDependencies(contracts);
    cycle.assignmentIds = contracts.map(contract => contract.id);
    this.repo.transaction(() => {
      this.repo.createTeamCycle(cycle);
      for (const contract of contracts) this.repo.createContract(contract);
      for (const contract of contracts) this.repo.appendLedger({
        id: randomUUID(), tenantId: run.tenantId, workOrderId: workOrder.id,
        contractId: contract.id, type: 'commitment', actorId: contract.roleId,
        summary: contract.branchObjective, evidence: contract.evidenceInputs, createdAt: this.now(),
      });
      this.options.store.runs.update(run, { teamCycleId: cycle.id }, 'team_created', {
        teamCycleId: cycle.id, assignments: contracts.map(contract => contract.id), teamEstimateUsd,
      });
    });
    const economics = this.economics(workOrder.id, run.tenantId);
    this.emit('work.contract.updated', { workOrderId: workOrder.id, teamCycleId: cycle.id, contracts: contracts.length });
    this.emit('organization.updated', { workOrderId: workOrder.id, teamCycleId: cycle.id });
    return { teamCycle: cycle, contracts, economics };
  }

  private teamCostEstimate(
    run: RunRecord,
    workOrder: WorkOrder,
    drafts: Array<AssignmentDraft & {
      objective: string;
      expectedArtifacts: string[];
      acceptance: string[];
      dependsOn: string[];
    }>,
  ): { singleAgentEstimateUsd?: number; teamEstimateUsd?: number } {
    const soloRoute = resolvePricedModel(this.options.store, run.providerId, run.model);
    if (!soloRoute) return {};
    const materialTokens = (run.materials ?? []).reduce((sum, material) =>
      sum + Math.ceil(Math.max(0, material.size) / 2), 0);
    const sharedText = [
      run.objective,
      ...(run.acceptance ?? []).map(item => JSON.stringify(item)),
      ...workOrder.acceptance.map(item => item.statement),
    ].join('\n');
    const branchText = drafts.map(item => [
      item.objective,
      ...item.expectedArtifacts,
      ...item.acceptance,
    ].join('\n')).join('\n');
    const solo = estimateModelWorkloadCost(this.options.store, {
      tenantId: run.tenantId,
      pricedModel: soloRoute,
      promptTokens: estimateTokens(sharedText) + estimateTokens(branchText) + materialTokens,
      outputTokens: Math.max(512, drafts.length * 512),
      fallbackCalls: 3,
    });

    let teamCostUsd = 0;
    for (const draft of drafts) {
      let route: PricedModel | undefined = soloRoute;
      if (draft.roleId) {
        const role = this.repo.getRole(draft.roleId, run.tenantId);
        if (!role || role.employment !== 'active')
          throw new OrganizationError(404, 'ROLE_NOT_FOUND', `角色不存在或不可用：${draft.roleId}`);
        if (role.modelPolicy.providerId
          && role.modelPolicy.providerId !== 'institution'
          && role.modelPolicy.model !== 'runtime-selected') {
          route = resolvePricedModel(
            this.options.store, role.modelPolicy.providerId, role.modelPolicy.model,
          );
        }
      }
      if (!route) return { singleAgentEstimateUsd: solo.costUsd };
      const estimate = estimateModelWorkloadCost(this.options.store, {
        tenantId: run.tenantId,
        pricedModel: route,
        promptTokens: estimateTokens(sharedText)
          + estimateTokens([draft.objective, ...draft.expectedArtifacts, ...draft.acceptance].join('\n'))
          + materialTokens,
        outputTokens: 512,
        fallbackCalls: 3,
      });
      teamCostUsd += estimate.costUsd;
    }
    const coordination = estimateModelWorkloadCost(this.options.store, {
      tenantId: run.tenantId,
      pricedModel: soloRoute,
      promptTokens: estimateTokens(sharedText) + estimateTokens(branchText),
      outputTokens: 128,
      fallbackCalls: 1,
    });
    teamCostUsd += coordination.costUsd;
    return {
      singleAgentEstimateUsd: solo.costUsd,
      teamEstimateUsd: Math.round(teamCostUsd * 1_000_000) / 1_000_000,
    };
  }

  private resolveRole(run: RunRecord, workOrder: WorkOrder, draft: AssignmentDraft, index: number): OrganizationRole {
    if (draft.roleId) {
      const role = this.repo.getRole(draft.roleId, run.tenantId);
      if (!role || role.employment !== 'active') throw new OrganizationError(404, 'ROLE_NOT_FOUND', `角色不存在或不可用：${draft.roleId}`);
      if (role.projectId && role.projectId !== workOrder.projectId)
        throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '角色不属于当前项目');
      return this.scopeRunToRole({ ...run }, role);
    }
    const name = bounded(draft.roleName ?? `临时角色 ${index + 1}`, 80, '角色名称');
    const now = this.now();
    const role: OrganizationRole = {
      id: randomUUID(), tenantId: run.tenantId, projectId: workOrder.projectId,
      name, responsibilities: [draft.objective], capabilities: draft.expectedArtifacts,
      authority: {
        workspace: run.authorization.workspace,
        readOnly: run.authorization.readOnly,
        profile: run.authorization.profile,
        allowedTools: draft.allowedTools ?? [],
      },
      modelPolicy: { providerId: run.providerId, model: run.model },
      persistent: false, employment: 'active', source: 'project',
      revision: 0, createdAt: now, updatedAt: now,
    };
    this.repo.createRole(role);
    return role;
  }

  prepareDelegation(parent: RunRecord, child: RunRecord, request: import('../../../kernel/run').ChildRunRequest, availableTools?: string[]): AssignmentContract {
    if (parent.origin?.kind === 'society')
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '社会分工不能再次委派角色');
    if (parent.parentId || parent.depth > 0)
      throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '团队分支不能继续委派角色');
    const workOrder = this.workOrderForRun(parent);
    if (!parent.teamCycleId) throw new OrganizationError(409, 'TEAM_NOT_ELIGIBLE', '任务没有获准组织执行');
    const cycle = this.repo.getTeamCycle(parent.teamCycleId, parent.tenantId);
    if (!cycle || cycle.workOrderId !== workOrder.id)
      throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '团队周期无效');
    if (!request.assignmentContractId)
      throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '每个委派必须指定分工契约');
    const contract = this.repo.getContract(request.assignmentContractId, parent.tenantId);
    if (!contract || contract.workOrderId !== workOrder.id || contract.teamCycleId !== cycle.id)
      throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '分工契约不属于当前工作单');
    if (contract.status !== 'proposed')
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '分工契约已被占用或关闭');
    const role = this.repo.getRole(contract.roleId, parent.tenantId);
    if (!role || role.employment !== 'active')
      throw new OrganizationError(409, 'ROLE_AUTHORITY_EXCEEDED', '分工角色不可用');
    const dependencies = contract.dependsOn.map(id => this.repo.getContract(id, parent.tenantId));
    if (dependencies.some(item => !item || item.status !== 'delivered' || (item.delivery?.unfinished.length ?? 1) > 0))
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '分工依赖尚未成功交付');
    const scopedRole = this.scopeRunToRole(child, role);
    const requested = [...new Set(request.allowedTools ?? contract.allowedTools)];
    if (requested.length && parent.toolNames && requested.some(name => !parent.toolNames!.includes(name)))
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '分工契约不能扩大父任务工具权限');
    if (requested.length && scopedRole.authority.allowedTools.length
      && requested.some(name => !scopedRole.authority.allowedTools.includes(name)))
      throw new OrganizationError(403, 'ROLE_AUTHORITY_EXCEEDED', '分工契约不能扩大角色工具权限');
    const permitted = (availableTools ?? intersectTools(child.toolNames, requested, scopedRole.authority.allowedTools, parent.toolNames)).filter(name => [request.allowedTools, contract.allowedTools, scopedRole.authority.allowedTools, parent.toolNames]
      .every(names => !names?.length || names.includes(name)));
    const paths = contract.expectedArtifacts.flatMap(path => contractArtifactPath(parent.authorization.workspace, path) ?? []);
    const writeTools = permitted.filter(name => name === 'write_file' || name === 'edit_file');
    const pathGrant = !parent.authorization.readOnly && !scopedRole.authority.readOnly && !parent.authorization.artifactWritePaths
      && paths.length > 0 && paths.length === contract.expectedArtifacts.length && writeTools.includes('write_file');
    child.toolNames = permitted.filter(name => child.toolNames === undefined || child.toolNames.includes(name));
    if (pathGrant) {
      child.authorization = { ...child.authorization, readOnly: false, artifactWritePaths: paths };
      child.toolNames = [...new Set([...child.toolNames, ...writeTools])];
    }
    const coordinatorArtifacts = !pathGrant && child.authorization.readOnly && contract.expectedArtifacts.length
      ? contract.expectedArtifacts : undefined;
    if (coordinatorArtifacts) {
      child.instructions = [child.instructions, `提交分析及完整文件内容给协调者。落盘由协调者负责：${coordinatorArtifacts.join('、')}。`].filter(Boolean).join('\n');
      const root = this.repo.contractsForRun(parent.id, parent.tenantId).find(item => item.id === parent.assignmentContractId);
      if (root) this.repo.updateContract(root, { expectedArtifacts: [...new Set([...root.expectedArtifacts, ...coordinatorArtifacts])] }, root.revision);
    }
    child.acceptance = taskCriteriaForContract({ ...contract, coordinatorArtifacts });
    child.workOrderId = workOrder.id;
    child.assignmentContractId = contract.id;
    child.organizationRoleId = role.id;
    child.teamCycleId = cycle.id;
    child.cachePrefixHash = cachePrefixHash({
      tenantId: parent.tenantId, workspace: parent.authorization.workspace,
      projectId: workOrder.projectId, providerId: child.providerId, model: child.model,
      workOrderId: workOrder.id, materialVersions: workOrder.materials,
      ruleHash: createHash('sha256').update(JSON.stringify(parent.ruleResolution ?? null)).digest('hex').slice(0, 24),
      toolVersions: [...requested].sort(),
    });
    this.repo.updateContract(contract, {
      runId: child.id, status: 'active',
      allowedTools: child.toolNames,
      coordinatorArtifacts,
    }, contract.revision);
    this.repo.appendLedger({
      id: randomUUID(), tenantId: child.tenantId, workOrderId: workOrder.id,
      contractId: contract.id, type: 'started', actorId: role.id,
      summary: `开始执行：${contract.branchObjective}`, evidence: contract.evidenceInputs, createdAt: this.now(),
    });
    return contract;
  }

  deliver(runId: string, tenantId: string, input: {
    summary: string;
    artifacts?: string[];
    evidence?: EvidenceRef[];
    unfinished?: string[];
  }): AssignmentContract {
    const contracts = this.repo.contractsForRun(runId, tenantId);
    const contract = contracts.find(item => item.status === 'active') ?? contracts[0];
    if (!contract) throw new OrganizationError(404, 'WORK_CONTRACT_INVALID', '任务没有分工契约');
    const run = this.options.store.runs.get(runId, tenantId);
    if (!run || !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '任务结束后才能交付契约');
    const artifacts = [...new Set((input.artifacts?.length ? input.artifacts : this.options.store.runs.artifacts(runId).map(item => item.ref)).filter(Boolean))];
    const expected = new Set(contract.expectedArtifacts.map(item => item.toLowerCase()));
    const missing = expected.size
      ? [...expected]
        .filter(item => !artifacts.some(artifact => artifactMatches(artifact, item)))
        .map(item => `缺少预期产物：${item}`)
      : [];
    const delivery: AssignmentDelivery = {
      summary: bounded(input.summary, 4000, '交付摘要'),
      artifacts,
      evidence: [...(input.evidence ?? []), ...evidenceOf([runId], this.options.store, tenantId)]
        .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index),
      unfinished: [...new Set([...(input.unfinished ?? []), ...missing, ...unfinishedForRun(run)])],
      costUsd: run.cost,
      usageKnown: run.usageStatus === 'reported',
    };
    const status: AssignmentContract['status'] = run.status === 'completed' && delivery.unfinished.length === 0
      ? 'delivered'
      : run.status === 'cancelled' || run.status === 'interrupted' ? 'cancelled' : 'failed';
    const updated = this.repo.updateContract(contract, { status, delivery }, contract.revision);
    this.repo.appendLedger({
      id: randomUUID(), tenantId, workOrderId: contract.workOrderId, contractId: contract.id,
      type: status === 'delivered' ? 'delivered' : 'exception', actorId: contract.roleId, summary: delivery.summary,
      evidence: delivery.evidence, createdAt: this.now(),
    });
    this.emit('work.contract.updated', { contractId: contract.id, status: updated.status });
    return updated;
  }

  private finalizeContract(run: RunRecord, contract: AssignmentContract): AssignmentContract {
    if (!['active', 'proposed'].includes(contract.status)) return contract;
    const artifacts = this.options.store.runs.artifacts(run.id).map(item => item.ref);
    const missing = contract.expectedArtifacts.filter(expected => !contract.coordinatorArtifacts?.includes(expected) &&
      !artifacts.some(artifact => artifactMatches(artifact, expected, !!run.authorization.artifactWritePaths)),
    );
    const delivery: AssignmentDelivery = {
      summary: (run.answer ?? run.error ?? `任务状态：${run.status}`).slice(0, 4000),
      artifacts,
      evidence: evidenceOf([run.id], this.options.store, run.tenantId),
      unfinished: [...new Set([...unfinishedForRun(run), ...missing.map(item => `缺少预期产物：${item}`)])],
      costUsd: run.cost,
      usageKnown: run.usageStatus === 'reported',
    };
    const status: AssignmentContract['status'] = run.status === 'completed' && delivery.unfinished.length === 0
      ? 'delivered'
      : run.status === 'interrupted' ? 'active' : run.status === 'cancelled' ? 'cancelled' : 'failed';
    const updated = this.repo.updateContract(contract, { delivery, status }, contract.revision);
    this.repo.appendLedger({
      id: randomUUID(), tenantId: run.tenantId, workOrderId: contract.workOrderId,
      contractId: contract.id, type: status === 'delivered' ? 'delivered' : 'exception',
      actorId: contract.roleId, summary: delivery.summary,
      evidence: delivery.evidence, createdAt: this.now(),
    });
    this.emit('work.contract.updated', { workOrderId: contract.workOrderId, contractId: contract.id, status });
    return updated;
  }

  deliveryGaps(run: RunRecord): string[] {
    const contract = run.assignmentContractId && this.repo.getContract(run.assignmentContractId, run.tenantId);
    if (!contract || contract.runId !== run.id) return [];
    const artifacts = this.options.store.runs.artifacts(run.id).map(item => item.ref);
    const missing = contract.expectedArtifacts.filter(path => !contract.coordinatorArtifacts?.includes(path) && !artifacts.some(ref => artifactMatches(ref, path, !!run.authorization.artifactWritePaths)))
      .map(path => `缺少预期产物：${path}`);
    if (run.parentId || run.origin?.kind === 'society' || !run.teamCycleId) return missing;
    const branches = this.repo.contracts(contract.workOrderId, run.tenantId)
      .filter(branch => branch.id !== contract.id && branch.teamCycleId === run.teamCycleId && branch.status !== 'collapsed');
    return [...missing, ...branches.filter(branch => branch.status !== 'delivered' || branch.delivery?.unfinished.length !== 0)
      .flatMap(branch => branch.delivery?.unfinished.length ? branch.delivery.unfinished : [`分工未交付：${branch.branchObjective}`])];
  }

  private executionUsage(runs: RunRecord[]) {
    const repo = this.options.store.runs;
    const byId = new Map<string, RunRecord>();
    const visit = (run: RunRecord) => {
      if (byId.has(run.id)) return;
      byId.set(run.id, run);
      repo.children(run.id, run.tenantId).forEach(visit);
    };
    runs.forEach(visit);
    const calls = new Map<string, ReturnType<typeof repo.modelCalls>[number]>();
    const roots = [...byId.values()].filter(run => !run.parentId || !byId.has(run.parentId));
    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0, tokensCached: 0, tokensCacheMiss: 0, cacheWriteTokens: 0 };
    let known = 0, unknown = 0;
    for (const run of byId.values()) {
      for (let offset = 0; ; offset += 100) {
        const page = repo.modelCalls(run.id, offset);
        page.forEach(call => calls.set(call.id, call));
        if (page.length < 100) break;
      }
    }
    for (const call of calls.values()) {
      totals.tokensIn += call.input ?? 0;
      totals.tokensOut += call.output ?? 0;
      totals.tokensCached += call.cachedInput ?? 0;
      totals.tokensCacheMiss += call.missInput ?? 0;
      totals.cacheWriteTokens += call.cacheWriteTokens ?? 0;
      if (call.cost === undefined) unknown++;
      else { totals.costUsd += call.cost; known++; }
    }
    // Older executions only persisted aggregate counters on the root.
    const accounted = new Set([...calls.values()].flatMap(call => [call.rootId, call.runId]));
    for (const run of roots.filter(run => !accounted.has(run.id))) {
      totals.tokensIn += run.tokensIn;
      totals.tokensOut += run.tokensOut;
      totals.tokensCached += run.tokensCached ?? 0;
      totals.tokensCacheMiss += run.tokensCacheMiss ?? 0;
      totals.cacheWriteTokens += run.cacheWriteTokens ?? 0;
      totals.costUsd += run.cost;
      if (run.usageStatus === 'reported') known++;
      else unknown++;
    }
    return { ...totals, usageKnown: known > 0 && unknown === 0, costStatus: (unknown ? known ? 'partial' : 'unknown' : known ? 'known' : 'unknown') as 'known' | 'partial' | 'unknown' };
  }

  finalizeRun(run: RunRecord): WorkReceipt | undefined {
    const contract = run.assignmentContractId
      ? this.repo.getContract(run.assignmentContractId, run.tenantId)
      : this.repo.contractsForRun(run.id, run.tenantId)[0];
    if (contract && contract.runId === run.id) this.finalizeContract(run, contract);

    const workOrder = run.workOrderId
      ? this.repo.getWorkOrder(run.workOrderId, run.tenantId)
      : this.repo.workOrderByRun(run.rootId, run.tenantId) ?? this.repo.workOrderByRun(run.id, run.tenantId);
    if (!workOrder) return undefined;
    if (run.parentId && workOrder.rootRunId !== run.id) return undefined;
    if (run.status === 'interrupted') return this.repo.receipt(workOrder.id, run.tenantId);
    const previous = this.repo.receipt(workOrder.id, run.tenantId);
    const humanReviewed = previous?.humanReviewedAt ?? (!!previous && this.repo.ledger(workOrder.id, run.tenantId)
      .some(entry => entry.type === 'reviewed' && entry.actorId === 'human'));
    if (humanReviewed && !run.reworkOfRunId) return run.parentId ? undefined : previous;

    let contracts = this.repo.contracts(workOrder.id, run.tenantId);
    if (run.reworkOfRunId) contracts = contracts.filter(item => item.runId === run.id || !!run.teamCycleId && item.teamCycleId === run.teamCycleId);
    const incomplete = contracts.some(item => ['proposed', 'active'].includes(item.status));
    const closingRootRun = workOrder.originKind === 'run' && (workOrder.rootRunId === run.id || !!run.reworkOfRunId);
    if (incomplete && !closingRootRun) return undefined;
    contracts = contracts.map(item => this.repo.getContract(item.id, run.tenantId) ?? item);
    const runs = [...new Map(contracts.flatMap(item =>
      item.runId ? [[item.runId, this.options.store.runs.get(item.runId, run.tenantId)] as const] : [],
    ).filter((entry): entry is [string, RunRecord] => !!entry[1])).values()];
    const acceptanceContracts = run.fallbackReason === 'ROLLBACK_TO_SOLO'
      ? contracts.filter(item => item.status !== 'collapsed')
      : contracts;
    const delivered = acceptanceContracts.filter(item => item.status === 'delivered');
    const unfinished = acceptanceContracts.flatMap(item => item.delivery?.unfinished ?? (
      item.status === 'delivered' ? [] : [`组织分支未完成：${item.branchObjective}`]
    ));
    const completed = acceptanceContracts.length > 0 && delivered.length === acceptanceContracts.length
      && delivered.every(item => (item.delivery?.unfinished.length ?? 1) === 0);
    const awaitingHumanAcceptance = completed && workOrder.originKind === 'society-task' && !previous?.humanAcceptedAt;
    const status: WorkOrder['status'] = awaitingHumanAcceptance
      ? 'awaiting_acceptance'
      : completed
        ? 'completed'
      : delivered.length ? 'partial'
        : contracts.length && contracts.every(item => ['cancelled', 'collapsed'].includes(item.status))
          ? 'cancelled' : 'failed';
    for (const cycle of this.repo.listTeamCycles(workOrder.id, run.tenantId)) {
      const members = contracts.filter(item => item.teamCycleId === cycle.id);
      if (!members.length) continue;
      const cycleDelivered = members.filter(item => item.status === 'delivered');
      const cycleComplete = cycleDelivered.length === members.length
        && cycleDelivered.every(item => (item.delivery?.unfinished.length ?? 1) === 0);
      const collapsed = run.fallbackReason === 'ROLLBACK_TO_SOLO';
      const cycleStatus: TeamCycle['status'] = cycleComplete
        ? 'completed'
        : cycleDelivered.length || collapsed ? 'partial'
          : members.every(item => ['cancelled', 'collapsed'].includes(item.status)) ? 'cancelled' : 'failed';
      if (cycle.status !== cycleStatus) this.repo.updateTeamCycle(cycle, { status: cycleStatus });
    }
    const artifacts = [...new Set(contracts.flatMap(item => item.delivery?.artifacts ?? []))];
    const evidence = contracts.flatMap(item => item.delivery?.evidence ?? [])
      .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index);
    const usage = this.executionUsage(runs);
    const receipt: WorkReceipt = {
      id: previous?.id ?? randomUUID(),
      tenantId: run.tenantId, workOrderId: workOrder.id, status,
      answer: run.reworkOfRunId ? run.answer ?? '' : rootAnswer(workOrder, run, contracts),
      artifacts,
      sources: evidence.filter(item => item.kind === 'artifact'),
      contributors: contracts.map(item => ({
        roleId: item.roleId, contractId: item.id,
        summary: item.delivery?.summary ?? item.branchObjective,
      })),
      ...usage,
      budgetTokens: workOrder.budgetTokens,
      tokenCompliance: workOrder.budgetTokens === undefined ? null : usage.tokensIn + usage.tokensOut <= workOrder.budgetTokens,
      cacheSavingsUsd: undefined,
      unfinished: [...new Set(unfinished)],
      exceptions: this.repo.exceptions(run.tenantId)
        .filter(item => item.workOrderId === workOrder.id && !['resolved', 'dismissed'].includes(item.status))
        .map(item => item.summary),
      humanAcceptedAt: run.reworkOfRunId ? undefined : previous?.humanAcceptedAt,
      createdAt: previous?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    if (workOrder.status !== status) this.repo.updateWorkOrder(workOrder, { status }, workOrder.revision);
    this.repo.saveReceipt(receipt);
    if (!previous || previous.status !== status) {
      this.repo.appendLedger({
        id: randomUUID(), tenantId: run.tenantId, workOrderId: workOrder.id,
        type: status === 'awaiting_acceptance' ? 'checkpoint' : 'closed',
        actorId: run.organizationRoleId ?? 'maharness',
        summary: status === 'awaiting_acceptance'
          ? '全部契约已交付，等待人工验收'
          : `工作单${status === 'completed' ? '完成' : `结束：${status}`}`,
        evidence: receipt.sources, createdAt: this.now(),
      });
    }
    this.emit('work.order.updated', { workOrderId: workOrder.id, status, receiptId: receipt.id });
    return receipt;
  }

  reviewWorkOrder(
    workOrderId: string,
    tenantId: string,
    outcome: 'completed' | 'failed',
    reason: string,
  ): WorkReceipt {
    const workOrder = this.repo.getWorkOrder(workOrderId, tenantId);
    const receipt = this.repo.receipt(workOrderId, tenantId);
    if (!workOrder || !receipt) throw new OrganizationError(404, 'RECEIPT_NOT_FOUND', '工作回执不存在');
    if (workOrder.status !== 'awaiting_acceptance' || receipt.status !== 'awaiting_acceptance') {
      throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '工作单当前不在人工验收状态');
    }
    if (outcome === 'completed' && receipt.unfinished.length > 0) {
      throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '仍有未完成项，不能通过人工验收');
    }
    const now = this.now();
    const summary = bounded(reason, 1000, '人工验收说明');
    const status: WorkOrder['status'] = outcome;
    return this.repo.transaction(() => {
      this.repo.updateWorkOrder(workOrder, { status }, workOrder.revision);
      const reviewed: WorkReceipt = {
        ...receipt,
        status,
        humanAcceptedAt: outcome === 'completed' ? now : receipt.humanAcceptedAt,
      humanReviewedAt: now,
        unfinished: outcome === 'failed'
          ? [...new Set([...receipt.unfinished, `人工验收未通过：${summary}`])]
          : receipt.unfinished,
        updatedAt: now,
      };
      this.repo.saveReceipt(reviewed);
      this.repo.appendLedger({
        id: randomUUID(), tenantId, workOrderId, type: 'reviewed', actorId: 'human',
        summary: `人工验收${outcome === 'completed' ? '通过' : '未通过'}：${summary}`,
        evidence: reviewed.sources, createdAt: now,
      });
      this.repo.appendSocietyAudit({
        id: randomUUID(),
        tenantId,
        taskId: workOrder.originId ?? workOrderId,
        scheduleId: this.repo.societyScheduleByWorkOrder(workOrderId, tenantId)?.id,
        workOrderId,
        action: outcome === 'completed' ? 'human_accepted' : 'human_rejected',
        actorId: 'human',
        reason: summary,
        details: {
          receiptStatus: status,
          humanAcceptedAt: reviewed.humanAcceptedAt,
          unfinished: reviewed.unfinished,
        },
        idempotencyKey: `human-review:${workOrderId}:${outcome}`,
        createdAt: now,
      });
      if (outcome === 'completed') {
        this.repo.appendLedger({
          id: randomUUID(), tenantId, workOrderId, type: 'closed', actorId: 'human',
          summary: '人工验收通过，工作单关闭', evidence: reviewed.sources, createdAt: now,
        });
      }
      this.emit('work.order.updated', { workOrderId, status, receiptId: reviewed.id });
      return reviewed;
    });
  }

  economics(workOrderId: string, tenantId: string): TeamEconomics {
    const order = this.repo.getWorkOrder(workOrderId, tenantId);
    if (!order) throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
    const cycles = this.repo.listTeamCycles(workOrderId, tenantId);
    const contracts = this.repo.contracts(workOrderId, tenantId);
    const runs = contracts.flatMap(contract => contract.runId ? [this.options.store.runs.get(contract.runId, tenantId)].filter((run): run is RunRecord => !!run) : []);
    const { costUsd: actualCostUsd, tokensIn, tokensOut, tokensCached: cachedInputTokens, tokensCacheMiss, cacheWriteTokens, usageKnown, costStatus } = this.executionUsage(runs);
    const actualTokens = tokensIn + tokensOut;
    const current = cycles.at(-1);
    const readSignatures = new Map<string, number>();
    let duplicateEvidenceReads = 0;
    for (const run of runs) {
      for (const call of this.options.store.runs.toolCalls(run.id)) {
        if (call.sideEffect !== 'read' || !['succeeded', 'failed', 'unknown'].includes(call.status)) continue;
        const signature = `${call.name}\0${call.argsSummary}`;
        const seen = readSignatures.get(signature) ?? 0;
        if (seen > 0) duplicateEvidenceReads++;
        readSignatures.set(signature, seen + 1);
      }
    }
    const coordinationRounds = contracts.reduce((sum, contract) => sum + Math.max(0, contract.dependsOn.length), 0);
    return {
      workOrderId,
      singleAgentEstimateUsd: current?.soloEstimateUsd ?? null,
      teamEstimateUsd: current?.teamEstimateUsd ?? null,
      actualCostUsd,
      costStatus,
      singleAgentEstimateTokens: current?.assignmentIds.length === 1 ? actualTokens : null,
      teamEstimateTokens: Math.max(0, order.budgetTokens ?? actualTokens),
      actualTokens,
      cachedInputTokens,
      tokensCacheMiss,
      cacheWriteTokens,
      cacheSavingsUsd: null,
      duplicateEvidenceReads,
      coordinationRounds,
      roi: usageKnown && current?.soloEstimateUsd && actualCostUsd <= current.soloEstimateUsd
        ? Math.round((current.soloEstimateUsd - actualCostUsd) / current.soloEstimateUsd * 1000) / 1000
        : null,
      usageKnown,
    };
  }

  scorecards(tenantId: string): RoleScorecard[] {
    return buildScorecards(this.projectionDeps(), tenantId);
  }

  wellbeing(tenantId: string, projectId?: string): RoleWellbeingSnapshot[] {
    return buildWellbeing(this.projectionDeps(), tenantId, projectId);
  }

  private projectionDeps() {
    return {
      store: this.options.store,
      repository: () => this.repo,
      ensureEvaluation: (tenantId: string) => this.ensureEvaluation(tenantId),
      executionUsage: (runs: RunRecord[]) => this.executionUsage(runs),
      now: () => this.now(),
    };
  }

  raiseException(input: {
    tenantId: string;
    workOrderId: string;
    contractId?: string;
    kind: ExceptionCase['kind'];
    summary: string;
    facts: string[];
    evidence?: EvidenceRef[];
    createdBy?: 'maharness' | 'ai';
  }): ExceptionCase {
    const order = this.repo.getWorkOrder(input.workOrderId, input.tenantId);
    if (!order) throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
    if (input.contractId && !this.repo.getContract(input.contractId, input.tenantId))
      throw new OrganizationError(404, 'WORK_CONTRACT_INVALID', '分工契约不存在');
    const requiresHuman = ['budget', 'authority', 'opinion-conflict'].includes(input.kind)
      || input.kind === 'ambiguity' && !order.acceptance.length;
    const now = this.now();
    const record: ExceptionCase = {
      id: randomUUID(), tenantId: input.tenantId, workOrderId: input.workOrderId,
      contractId: input.contractId, kind: input.kind,
      summary: bounded(input.summary, 2000, '异常摘要'),
      facts: input.facts.map(item => bounded(item, 1000, '异常事实')).slice(0, 20),
      evidence: input.evidence ?? [], createdBy: input.createdBy ?? 'ai',
      factRuling: requiresHuman ? '运行事实已记录，决定超出模型权限' : '运行事实可判定，允许沿现有权限自动恢复',
      requiresHuman,
      recovery: requiresHuman ? '等待人类决定权限、费用或价值取舍' : '按权限和预算重新执行或标记跳过',
      status: requiresHuman ? 'waiting_human' : 'auto_resolved',
      createdAt: now, updatedAt: now,
    };
    this.repo.createException(record);
    this.repo.appendLedger({
      id: randomUUID(), tenantId: record.tenantId, workOrderId: record.workOrderId,
      contractId: record.contractId, type: 'exception', actorId: record.createdBy,
      summary: record.summary, evidence: record.evidence, createdAt: now,
    });
    this.emit('work.exception.updated', { exceptionId: record.id, status: record.status });
    return record;
  }

  resolveException(id: string, tenantId: string, decision: string): ExceptionCase {
    const record = this.repo.getException(id, tenantId);
    if (!record) throw new OrganizationError(404, 'EXCEPTION_NOT_FOUND', '异常不存在');
    if (record.status === 'resolved' || record.status === 'dismissed') return record;
    return this.repo.updateException(record, { status: 'resolved', humanDecision: bounded(decision, 2000, '人工决定') });
  }

  detail(id: string, tenantId: string): OrganizationDetail {
    const workOrder = this.repo.getWorkOrder(id, tenantId);
    if (!workOrder) throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
    const contracts = this.repo.contracts(id, tenantId);
    const roles = [...new Set(contracts.map(contract => contract.roleId))]
      .flatMap(roleId => {
        const role = this.repo.getRole(roleId, tenantId);
        return role ? [role] : [];
      });
    return {
      workOrder,
      teamCycles: this.repo.listTeamCycles(id, tenantId),
      roles,
      contracts,
      ledger: this.repo.ledger(id, tenantId),
      societyAudits: this.repo.societyAudits(tenantId).filter(entry => entry.workOrderId === id),
      receipt: this.repo.receipt(id, tenantId),
      exceptions: this.repo.exceptions(tenantId).filter(item => item.workOrderId === id),
      economics: this.economics(id, tenantId),
      scorecards: this.scorecards(tenantId).filter(item => roles.some(role => role.id === item.roleId)),
      wellbeing: this.wellbeing(tenantId).filter(item => roles.some(role => role.id === item.roleId)),
    };
  }

  setTeamState(id: string, tenantId: string, action: 'pause' | 'resume' | 'dissolve'): { teamCycle: TeamCycle; runIds: string[] } {
    const cycle = this.repo.getTeamCycle(id, tenantId);
    if (!cycle) throw new OrganizationError(404, 'TEAM_NOT_FOUND', '团队周期不存在');
    if (action === 'resume' && !['paused', 'dissolved'].includes(cycle.status))
      throw new OrganizationError(409, 'TEAM_NOT_PAUSED', '团队当前无需恢复');
    if (action !== 'resume' && ['completed', 'cancelled', 'dissolved'].includes(cycle.status))
      throw new OrganizationError(409, 'TEAM_CLOSED', '团队已结束');
    const status = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'dissolved';
    this.repo.updateTeamCycle(cycle, { status });
    const contracts = this.repo.contracts(cycle.workOrderId, tenantId).filter(contract => contract.teamCycleId === id);
    const runIds = contracts.flatMap(contract => contract.runId && ['active', 'proposed'].includes(contract.status) ? [contract.runId] : []);
    if (action === 'dissolve') {
      for (const contract of contracts.filter(item => item.status === 'proposed')) {
        this.repo.updateContract(contract, { status: 'cancelled' }, contract.revision);
      }
    }
    this.emit('organization.updated', { teamCycleId: id, status });
    return { teamCycle: cycle, runIds };
  }

  collapseToSolo(run: RunRecord, reason: string): TeamCycle | undefined {
    if (!run.teamCycleId) return undefined;
    const cycle = this.repo.getTeamCycle(run.teamCycleId, run.tenantId);
    if (!cycle || ['completed', 'cancelled', 'dissolved'].includes(cycle.status)) return undefined;
    const contracts = this.repo.contracts(cycle.workOrderId, run.tenantId).filter(contract => contract.teamCycleId === cycle.id);
    const runs = contracts.flatMap(contract => {
      const child = contract.runId ? this.options.store.runs.get(contract.runId, run.tenantId) : undefined;
      return child ? [child] : [];
    });
    const unsuccessful = (contract: AssignmentContract) => ['failed', 'cancelled'].includes(contract.status)
      || runs.some(child => child.id === contract.runId && child.status === 'interrupted');
    const failed = contracts.filter(unsuccessful).length;
    const deliveredArtifacts = contracts.flatMap(contract => contract.delivery?.artifacts ?? []);
    const readSignatures = new Set<string>();
    let duplicateReads = 0;
    let rounds = 0;
    for (const child of runs) {
      const calls = this.options.store.runs.toolCalls(child.id);
      rounds += Math.max(calls.length, this.options.store.runs.modelCalls(child.id).length);
      for (const call of calls) {
        if (call.sideEffect !== 'read' || !['succeeded', 'failed', 'unknown'].includes(call.status)) continue;
        const signature = `${call.name}\0${call.argsSummary}`;
        if (readSignatures.has(signature)) duplicateReads++;
        readSignatures.add(signature);
      }
    }
    const workTerminal = contracts.every(contract =>
      ['delivered', 'failed', 'cancelled', 'collapsed'].includes(contract.status));
    const workOrder = this.repo.getWorkOrder(cycle.workOrderId, run.tenantId);
    const actualCost = runs.reduce((sum, child) => sum + child.cost, 0);
    const usageKnown = runs.length > 0 && runs.every(child => child.usageStatus === 'reported');
    const triggers = [
      failed >= 2 ? '连续两个分支失败' : '',
      failed > 0 && duplicateReads > 0 ? `重复读取同一证据 ${duplicateReads} 次` : '',
      workTerminal && deliveredArtifacts.length === 0 && rounds >= 2 ? '两轮协作未产生有效产物' : '',
      cycle.hardBudget && cycle.teamEstimateUsd !== undefined && usageKnown && actualCost > cycle.teamEstimateUsd && deliveredArtifacts.length === 0
        ? `团队费用已超过预估 ${actualCost.toFixed(6)} USD`
        : '',
    ].filter(Boolean);
    if (!triggers.length) return cycle;
    const collapseReason = triggers.join('；');
    this.repo.transaction(() => {
      for (const contract of contracts.filter(item => item.status === 'proposed' || unsuccessful(item)))
        this.repo.updateContract(contract, { status: 'collapsed' }, contract.revision);
      this.repo.updateTeamCycle(cycle, { status: 'partial' });
      this.options.store.runs.update(run, { fallbackReason: 'ROLLBACK_TO_SOLO' }, 'team_collapsed', {
        teamCycleId: cycle.id,
        reason: bounded(`${collapseReason}；${reason}`, 500, '回退原因'),
        retainedContracts: contracts.filter(item => item.status === 'delivered').map(item => item.id),
      });
      this.repo.appendLedger({
        id: randomUUID(), tenantId: run.tenantId, workOrderId: cycle.workOrderId,
        type: 'exception', actorId: 'maharness',
        summary: bounded(`团队连续无有效进展，回退单角色：${collapseReason}；${reason}`, 2000, '回退摘要'),
        evidence: [], createdAt: this.now(),
      });
      if (workOrder) {
        this.repo.appendSocietyAudit({
          id: createHash('sha256').update(`fallback-solo:${cycle.id}`).digest('hex'),
          tenantId: run.tenantId,
          taskId: workOrder.originId,
          workOrderId: cycle.workOrderId,
          action: 'fallback_solo',
          actorId: 'maharness',
          reason: bounded(`${collapseReason}；${reason}`, 1000, '回退原因'),
          details: {
            teamCycleId: cycle.id,
            collapsedContractIds: contracts.map(contract => contract.id),
            remainingBudgetUsd: this.options.store.runs.availableBudget(run),
            teamEstimateUsd: cycle.teamEstimateUsd,
          },
          idempotencyKey: `fallback-solo:${cycle.id}`,
          createdAt: this.now(),
        });
      }
    });
    this.emit('organization.updated', { teamCycleId: cycle.id, status: cycle.status, fallbackReason: 'ROLLBACK_TO_SOLO' });
    return cycle;
  }

  soloTakeoverContract(run: RunRecord, reason: string): ChildRunFallback {
    const workOrder = this.workOrderForRun(run);
    const contracts = this.repo.contracts(workOrder.id, run.tenantId);
    const root = contracts.find(contract =>
      contract.runId === run.id && !contract.teamCycleId && contract.status === 'active');
    if (!root)
      throw new OrganizationError(409, 'WORK_CONTRACT_INVALID', '团队回退后没有可接管的主角色契约');
    const role = this.repo.getRole(root.roleId, run.tenantId);
    if (!role || role.employment !== 'active')
      throw new OrganizationError(409, 'ROLE_AUTHORITY_EXCEEDED', '接管角色不可用');
    const teamContracts = contracts.filter(contract =>
      contract.teamCycleId && contract.teamCycleId === run.teamCycleId);
    const delivered = teamContracts.filter(contract => contract.status === 'delivered');
    const collapsed = teamContracts.filter(contract => contract.status === 'collapsed');
    const takeoverArtifacts = [...new Set(collapsed.flatMap(contract => contract.expectedArtifacts))];
    const takeoverAcceptance = collapsed.flatMap(contract => contract.acceptance);
    const mergedRoot = this.repo.updateContract(root, {
      expectedArtifacts: [...new Set([...root.expectedArtifacts, ...takeoverArtifacts])],
      acceptance: [...new Map([...root.acceptance, ...takeoverAcceptance]
        .map(item => [item.id, item] as const)).values()],
    }, root.revision);
    const completedEvidence = delivered.flatMap(contract => [
      ...(contract.delivery?.artifacts ?? []),
      ...(contract.delivery?.evidence ?? []).map(item => item.ref),
    ]);
    const unfinished = collapsed.flatMap(contract =>
      contract.delivery?.unfinished?.length
        ? contract.delivery.unfinished
        : [`${contract.branchObjective}：${contract.delivery?.summary ?? '团队未完成'}`],
    );
    const remainingBudgetUsd = this.options.store.runs.availableBudget(run);
    const handoff: ChildRunFallback = {
      kind: 'solo_takeover',
      runId: run.id,
      workOrderId: workOrder.id,
      ...(run.teamCycleId ? { teamCycleId: run.teamCycleId } : {}),
      contractId: mergedRoot.id,
      coordinatorRoleId: role.id,
      objective: run.objective,
      expectedArtifacts: mergedRoot.expectedArtifacts,
      acceptance: mergedRoot.acceptance.map(item => item.statement),
      completedEvidence: [...new Set(completedEvidence)].slice(0, 30),
      unfinished: [...new Set(unfinished)].slice(0, 30),
      ...(remainingBudgetUsd === undefined ? {} : { remainingBudgetUsd }),
      ...(run.budgetTokens === undefined
        ? {}
        : { remainingBudgetTokens: Math.max(0, run.budgetTokens - run.tokensIn - run.tokensOut) }),
      reason: bounded(reason, 1000, '接管原因'),
    };
    const summary = `团队回退后由单角色接管：${handoff.reason}`;
    this.repo.appendLedgerOnce({
      id: createHash('sha256').update([
        'solo-takeover', run.tenantId, workOrder.id, run.teamCycleId ?? '', mergedRoot.id,
      ].join('\0')).digest('hex'),
      tenantId: run.tenantId, workOrderId: workOrder.id, contractId: mergedRoot.id,
      type: 'handoff', actorId: role.id, summary,
      evidence: [
        ...delivered.flatMap(contract => contract.delivery?.evidence ?? []),
        ...collapsed.flatMap(contract => contract.delivery?.evidence ?? []),
      ].filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index),
      createdAt: this.now(),
    });
    this.emit('work.order.updated', {
      workOrderId: workOrder.id, contractId: mergedRoot.id, status: 'solo_takeover', actorId: role.id,
    });
    return handoff;
  }

  confirmPersistentRole(id: string, tenantId: string): OrganizationRole {
    const role = this.repo.getRole(id, tenantId);
    if (!role) throw new OrganizationError(404, 'ROLE_NOT_FOUND', '角色不存在');
    if (role.persistent) return role;
    return this.repo.updateRole(role, {
      projectId: '',
      persistent: true,
      source: 'human',
    }, role.revision);
  }

  reassign(id: string, tenantId: string, contractId: string, roleId: string): AssignmentContract {
    const cycle = this.repo.getTeamCycle(id, tenantId);
    if (!cycle) throw new OrganizationError(404, 'TEAM_NOT_FOUND', '团队周期不存在');
    const contract = this.repo.getContract(contractId, tenantId);
    if (!contract || contract.teamCycleId !== id) throw new OrganizationError(404, 'WORK_CONTRACT_INVALID', '分工契约不存在');
    if (!['proposed', 'failed'].includes(contract.status))
      throw new OrganizationError(409, 'WORK_LEDGER_CONFLICT', '运行中的契约不能直接改派；请先中止该分支');
    const role = this.repo.getRole(roleId, tenantId);
    if (!role || role.employment !== 'active') throw new OrganizationError(404, 'ROLE_NOT_FOUND', '目标角色不可用');
    return this.repo.updateContract(contract, { roleId: role.id, status: 'proposed', runId: undefined, delivery: undefined }, contract.revision);
  }

  createProposal(input: {
    tenantId: string;
    workOrderId: string;
    category: InstitutionProposal['category'];
    title: string;
    detail: string;
    evidence?: EvidenceRef[];
    impact?: InstitutionProposal['impact'];
  }): InstitutionProposal {
    if (!this.repo.getWorkOrder(input.workOrderId, input.tenantId))
      throw new OrganizationError(404, 'WORK_ORDER_NOT_FOUND', '工作单不存在');
    const now = this.now();
    const record: InstitutionProposal = {
      id: randomUUID(), tenantId: input.tenantId, workOrderId: input.workOrderId,
      category: input.category, title: bounded(input.title, 200, '提案标题'),
      detail: bounded(input.detail, 4000, '提案内容'), evidence: input.evidence ?? [],
      impact: input.impact ?? 'medium', status: 'pending', createdAt: now, updatedAt: now,
    };
    return this.repo.createProposal(record);
  }

  decideProposal(id: string, tenantId: string, accepted: boolean, decision: string): InstitutionProposal {
    const record = this.repo.proposals(tenantId).find(item => item.id === id);
    if (!record) throw new OrganizationError(404, 'PROPOSAL_NOT_FOUND', '制度提案不存在');
    return this.repo.updateProposal(record, accepted ? 'accepted' : 'rejected', bounded(decision, 2000, '人工决定'));
  }
}

export function isOrganizationError(error: unknown): error is OrganizationError {
  return error instanceof OrganizationError;
}
