import { createHash, randomUUID } from 'node:crypto';
import { RUN_TERMINAL, type RunRecord } from '../../../kernel/run';
import { estimateTokens } from '../../../kernel/tokens';
import type { Store } from '../../db';
import { estimateModelWorkloadCost, firstPricedModel, resolvePricedModel, type PricedModel } from '../../model-cost-estimator';
import { OrganizationService, explicitTeamRequest } from '../organization/service';
import { SocietySelectionService } from './selection';
import { buildSocietySnapshot, type DepartmentUsage, type RunUsage } from './snapshot';
import {
  ensureInstitution as ensureInstitutionImpl,
  rollbackInstitution as rollbackInstitutionImpl,
  updateInstitution as updateInstitutionImpl,
} from './institutions';
import { teamCostEligible as teamCostEligibleImpl } from './types';

export type {
  CreateSocietyTaskInput,
  SocietyEconomicsEstimate,
  SocietyTickAllResult,
  SocietyTickResult,
} from './types';
import {
  OrganizationError,
  type AssignmentContract,
  type EvidenceRef,
  type InstitutionPolicies,
  type InstitutionVersion,
  type OrganizationRole,
  type SocietyDepartmentPolicy,
  type SocietyPairedExperiment,
  type SocietySchedule,
  type SocietyScheduleAssignment,
  type SocietyScheduleSelection,
  type SocietySnapshot,
  type SocietyTask,
  type SocietyTaskBranch,
  type SocietyAuditEntry,
} from '../../organization-store';
import { ROLE_SELECTION_WEIGHTS, bounded, money, ratio, tokenCount, validDepartmentId } from './policy';
import {
  createPairedExperiment as createPairedExperimentImpl,
  experimentDecision,
  measurePairedExperiment as measurePairedExperimentImpl,
  pairedExperiment as pairedExperimentImpl,
} from './experiments';
import type { CreateSocietyTaskInput, SocietyEconomicsEstimate, SocietyRunRuntime, SocietyTickAllResult, SocietyTickResult } from './types';
import { SOCIETY_LIST_LIMIT, dependencyIndexes } from './branch-graph';
export class SocietyService {
  private readonly organization: OrganizationService;
  private readonly selection: SocietySelectionService;
  private runs?: SocietyRunRuntime;
  private readonly advancing = new Set<string>();
  private readonly watchedRuns = new Map<string, () => void>();

  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: Store;
      emit?: (type: string, data: Record<string, unknown>) => void;
      organization?: OrganizationService;
      runs?: SocietyRunRuntime;
      runtimeAuthority?: ConstructorParameters<typeof OrganizationService>[0]['runtimeAuthority'];
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.organization =
      options.organization ??
      new OrganizationService({
        store: options.store,
        emit: options.emit,
        ...(options.runtimeAuthority ? { runtimeAuthority: options.runtimeAuthority } : {}),
        now: this.now,
      });
    this.selection = new SocietySelectionService(this.repository(), this.organization);
    this.runs = options.runs;
  }

  attachRunService(runs: SocietyRunRuntime): void {
    this.runs = runs;
  }

  private repository() {
    return this.options.store.organization;
  }

  /**
   * Record a reviewed relation only when a human actually reviewed the delivery.
   * `score` 1 = accepted review, 0 = rejected review; every pair gets the same
   * evidence-backed event rather than a fabricated collaboration number.
   */
  private recordReviewedRelations(tenantId: string, roleIds: string[], evidence: EvidenceRef[], score: 0 | 1, now: number): void {
    const unique = [...new Set(roleIds)];
    if (unique.length < 2) return;
    for (const fromRoleId of unique)
      for (const toRoleId of unique) {
        if (fromRoleId === toRoleId) continue;
        this.repository().upsertRoleRelation({
          id: randomUUID(),
          tenantId,
          fromRoleId,
          toRoleId,
          kind: 'reviewed',
          score,
          evidence: evidence.slice(0, 5),
          updatedAt: now,
        });
      }
  }

  private appendAudit(
    task: SocietyTask,
    action: SocietyAuditEntry['action'],
    reason: string,
    details: Record<string, unknown>,
    idempotencyKey: string,
    actorId = 'maharness',
  ): void {
    const schedule = task.scheduleId
      ? this.repository().getSocietySchedule(task.scheduleId, task.tenantId)
      : this.repository().getSocietySchedule(idempotencyKey.replace(/^[^:]+:/, ''), task.tenantId);
    this.repository().appendSocietyAudit({
      id: randomUUID(),
      tenantId: task.tenantId,
      taskId: task.id,
      ...(schedule ? { scheduleId: schedule.id } : {}),
      ...(schedule?.workOrderId ? { workOrderId: schedule.workOrderId } : {}),
      action,
      actorId,
      reason: reason.slice(0, 500),
      details,
      idempotencyKey,
      createdAt: this.now(),
    });
  }

  private assignmentDepartmentId(
    schedule: SocietySchedule,
    assignment: SocietyScheduleAssignment,
    departments: SocietyDepartmentPolicy[],
  ): string {
    if (assignment.departmentId) return assignment.departmentId;
    const role = this.repository().getRole(assignment.roleId, schedule.tenantId);
    return (role ? this.departmentForRole(role, departments)?.id : undefined) ?? schedule.departmentId;
  }

  private contractDepartmentId(
    schedule: SocietySchedule,
    contract: AssignmentContract,
    assignment: SocietyScheduleAssignment | undefined,
    departments: SocietyDepartmentPolicy[],
    task: SocietyTask | undefined,
  ): string {
    if (contract.departmentId) return contract.departmentId;
    if (assignment) return this.assignmentDepartmentId(schedule, assignment, departments);
    const branch =
      task?.branches.find((item) => item.objective === contract.branchObjective) ??
      task?.branches.find(
        (item) =>
          contract.expectedArtifacts.length > 0 &&
          contract.expectedArtifacts.every((artifact) => item.expectedArtifacts.includes(artifact)),
      );
    if (branch?.departmentId) return branch.departmentId;
    const role = this.repository().getRole(contract.roleId, schedule.tenantId);
    return (role ? this.departmentForRole(role, departments)?.id : undefined) ?? schedule.departmentId;
  }

  private departmentUsage(
    schedules: SocietySchedule[],
    tenantId: string,
    departments: SocietyDepartmentPolicy[],
  ): Map<string, DepartmentUsage> {
    const result = new Map<string, DepartmentUsage>();
    const usage = (departmentId: string): DepartmentUsage => {
      let current = result.get(departmentId);
      if (!current) {
        current = {
          activeAssignments: 0,
          reservedUsd: 0,
          reservedTokens: 0,
          spentUsd: 0,
          spentTokens: 0,
        };
        result.set(departmentId, current);
      }
      return current;
    };

    for (const schedule of schedules) {
      const assignments = new Map(schedule.assignments.map((assignment) => [assignment.contractId, assignment]));
      const task = this.repository().getSocietyTask(schedule.taskId, tenantId);
      const contracts = new Map<string, AssignmentContract>();
      for (const contractId of schedule.contractIds ?? []) {
        const contract = this.repository().getContract(contractId, tenantId);
        if (contract) contracts.set(contract.id, contract);
      }
      if (schedule.workOrderId) {
        for (const contract of this.repository().contracts(schedule.workOrderId, tenantId)) contracts.set(contract.id, contract);
      }

      if (schedule.status === 'active') {
        for (const contract of contracts.values()) {
          if (!['proposed', 'active'].includes(contract.status)) continue;
          const assignment =
            assignments.get(contract.id) ?? schedule.assignments.find((item) => !item.contractId && item.roleId === contract.roleId);
          const departmentId = this.contractDepartmentId(schedule, contract, assignment, departments, task);
          const runId = contract.runId ?? assignment?.runId;
          const run = runId ? this.options.store.runs.get(runId, tenantId) : undefined;
          const branchBudgetUsd =
            assignment?.cognitiveTier === 'utility'
              ? 0
              : (contract.budgetUsd ?? schedule.estimates.teamCostUsd / Math.max(1, schedule.assignments.length));
          const branchBudgetTokens = contract.budgetTokens ?? assignment?.budgetTokens ?? 0;
          const target = usage(departmentId);
          target.activeAssignments += 1;
          target.reservedUsd += Math.max(0, branchBudgetUsd - (run?.cost ?? 0));
          target.reservedTokens += Math.max(0, branchBudgetTokens - (run ? run.tokensIn + run.tokensOut : 0));
        }
        for (const assignment of schedule.assignments.filter((item) => !item.contractId || !contracts.has(item.contractId))) {
          const departmentId = this.assignmentDepartmentId(schedule, assignment, departments);
          const run = assignment.runId ? this.options.store.runs.get(assignment.runId, tenantId) : undefined;
          const branchBudgetUsd =
            assignment.cognitiveTier === 'utility' ? 0 : schedule.estimates.teamCostUsd / Math.max(1, schedule.assignments.length);
          const target = usage(departmentId);
          target.activeAssignments += 1;
          target.reservedUsd += Math.max(0, branchBudgetUsd - (run?.cost ?? 0));
          target.reservedTokens += Math.max(0, assignment.budgetTokens - (run ? run.tokensIn + run.tokensOut : 0));
        }
      }

      const countedRuns = new Set<string>();
      for (const contract of contracts.values()) {
        if (!contract.runId || countedRuns.has(contract.runId)) continue;
        const run = this.options.store.runs.get(contract.runId, tenantId);
        if (!run) continue;
        const assignment =
          assignments.get(contract.id) ?? schedule.assignments.find((item) => !item.contractId && item.roleId === contract.roleId);
        const departmentId = this.contractDepartmentId(schedule, contract, assignment, departments, task);
        const target = usage(departmentId);
        target.spentUsd += run.cost;
        target.spentTokens += run.tokensIn + run.tokensOut;
        countedRuns.add(run.id);
      }
      for (const runId of schedule.runIds ?? []) {
        if (countedRuns.has(runId)) continue;
        const run = this.options.store.runs.get(runId, tenantId);
        if (!run) continue;
        const assignment = schedule.assignments.find((item) => item.runId === runId);
        const departmentId = assignment ? this.assignmentDepartmentId(schedule, assignment, departments) : schedule.departmentId;
        const target = usage(departmentId);
        target.spentUsd += run.cost;
        target.spentTokens += run.tokensIn + run.tokensOut;
        countedRuns.add(runId);
      }
    }
    return result;
  }

  private teamCostEligible(objective: string, estimate: SocietyEconomicsEstimate): boolean {
    return teamCostEligibleImpl(objective, estimate, explicitTeamRequest);
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.options.emit?.(type, data);
  }

  ensureInstitution(tenantId: string): InstitutionVersion {
    return ensureInstitutionImpl(this.institutionDeps(), tenantId);
  }

  departmentForRole(role: OrganizationRole, departments: SocietyDepartmentPolicy[]): SocietyDepartmentPolicy | undefined {
    return this.selection.departmentForRole(role, departments);
  }

  updateInstitution(tenantId: string, input: Partial<InstitutionPolicies> & { reason: string }): InstitutionVersion {
    return updateInstitutionImpl(this.institutionDeps(), tenantId, input);
  }

  rollbackInstitution(tenantId: string, version: number, reason: string): InstitutionVersion {
    return rollbackInstitutionImpl(this.institutionDeps(), tenantId, version, reason);
  }

  private institutionDeps() {
    return {
      store: this.options.store,
      repository: () => this.repository(),
      organization: this.organization,
      now: () => this.now(),
      emit: (type: string, data: Record<string, unknown>) => this.emit(type, data),
    };
  }

  createTask(input: CreateSocietyTaskInput): SocietyTask {
    const institution = this.ensureInstitution(input.tenantId);
    const objective = bounded(input.objective, 2000, '任务目标');
    if (input.evidenceExperimentId) {
      const evidence = this.pairedExperiment(input.evidenceExperimentId, input.tenantId);
      if (evidence.status !== 'measured') throw new OrganizationError(409, 'SOCIETY_EXPERIMENT_INCOMPLETE', '配对净收益实验尚未完成');
    }
    const departmentId = input.departmentId
      ? validDepartmentId(input.departmentId)
      : this.selection.departmentForText(objective, institution.policies.departments).id;
    const department = institution.policies.departments.find((item) => item.id === departmentId && item.enabled);
    if (!department) throw new OrganizationError(404, 'DEPARTMENT_NOT_FOUND', '部门不存在或已停用');
    const queued = this.repository()
      .societyTasks(input.tenantId, input.projectId, SOCIETY_LIST_LIMIT)
      .filter((item) => item.departmentId === departmentId && ['queued', 'waiting_approval'].includes(item.status));
    if (queued.length >= institution.policies.maxQueuedPerDepartment)
      throw new OrganizationError(409, 'SOCIETY_QUEUE_LIMIT', '该部门排队任务已达到上限，先完成或取消现有任务');
    const maxBudgetUsd = money(input.maxBudgetUsd, '任务预算');
    const maxBudgetTokens =
      input.maxBudgetTokens === undefined
        ? Math.max(1_000, Math.ceil(maxBudgetUsd * 10_000))
        : tokenCount(input.maxBudgetTokens, '任务 token 预算');
    const requiresApproval = maxBudgetUsd >= institution.policies.highSpendApprovalUsd;
    const branches: SocietyTaskBranch[] = (
      input.branches?.length
        ? input.branches
        : [
            {
              objective,
              acceptance: input.acceptance ?? [],
              expectedArtifacts: [],
              departmentId,
            },
          ]
    )
      .slice(0, 5)
      .map((branch) => ({
        objective: bounded(branch.objective, 800, '分支目标'),
        acceptance: (branch.acceptance ?? []).map((item) => bounded(item, 300, '验收条件')).slice(0, 10),
        expectedArtifacts: (branch.expectedArtifacts ?? []).map((item) => bounded(item, 200, '预期产物')).slice(0, 10),
        departmentId: branch.departmentId ? validDepartmentId(branch.departmentId) : departmentId,
        dependsOn: [...new Set(branch.dependsOn ?? [])].slice(0, 4),
        ...(branch.maxBudgetTokens === undefined ? {} : { maxBudgetTokens: tokenCount(branch.maxBudgetTokens, '分支 token 预算') }),
      }));
    for (const branch of branches) {
      if (!institution.policies.departments.some((item) => item.id === branch.departmentId && item.enabled))
        throw new OrganizationError(404, 'DEPARTMENT_NOT_FOUND', `分支部门不存在或已停用：${branch.departmentId}`);
    }
    const declaredTokens = branches.reduce((sum, branch) => sum + (branch.maxBudgetTokens ?? 0), 0);
    if (declaredTokens > maxBudgetTokens)
      throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '分支 token 预算之和不能超过任务 token 预算');
    const unspecified = branches.filter((branch) => branch.maxBudgetTokens === undefined);
    if (declaredTokens > 0 && unspecified.length) {
      const remaining = maxBudgetTokens - declaredTokens;
      if (remaining < unspecified.length)
        throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '分支 token 预算未给未指定分支留下额度');
      const each = Math.floor(remaining / unspecified.length);
      unspecified.forEach((branch, index) => {
        branch.maxBudgetTokens = each + (index === unspecified.length - 1 ? remaining % unspecified.length : 0);
      });
    }
    dependencyIndexes(branches);
    const now = this.now();
    const record: SocietyTask = {
      id: randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId ?? '',
      objective,
      acceptance: (input.acceptance ?? []).map((item) => bounded(item, 300, '验收条件')).slice(0, 10),
      materials: (input.materials ?? []).map(({ id, version }) => ({ id, version })).slice(0, 10),
      valueUsd: money(input.valueUsd, '任务价值'),
      maxBudgetUsd,
      maxBudgetTokens,
      priority: Math.max(1, Math.min(5, Math.trunc(Number(input.priority ?? 3)))),
      departmentId,
      ...(input.requiredCapabilities?.length
        ? {
            requiredCapabilities: [...new Set(input.requiredCapabilities.map((item) => bounded(item, 80, '任务能力')))].slice(0, 20),
          }
        : {}),
      ...(input.needsWrite === undefined ? {} : { needsWrite: input.needsWrite }),
      capabilitySource: input.requiredCapabilities?.length ? 'explicit' : 'legacy_heuristic',
      teamMode: input.teamMode ?? 'auto',
      ...(input.economics
        ? {
            economics: {
              qualityGain: ratio(input.economics.qualityGain, '团队质量增益'),
              riskReduction: ratio(input.economics.riskReduction, '团队风险下降'),
              latencyGainMs: tokenCount(input.economics.latencyGainMs ?? 0, '团队时延收益', true),
              latencyBenefitUsd: money(input.economics.latencyBenefitUsd ?? 0, '团队时延价值', true),
            },
          }
        : {}),
      branches,
      ...(input.evidenceExperimentId ? { evidenceExperimentId: bounded(input.evidenceExperimentId, 64, '实验证据 ID') } : {}),
      approval: requiresApproval ? 'pending' : 'not_required',
      status: requiresApproval ? 'waiting_approval' : 'queued',
      lastSchedulingReason: requiresApproval ? '等待人类批准高额任务' : '等待制度调度',
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.repository().transaction(() => {
      this.repository().createSocietyTask(record);
      this.appendAudit(
        record,
        'queued',
        record.lastSchedulingReason ?? '等待制度调度',
        {
          status: record.status,
          approval: record.approval,
          departmentId: record.departmentId,
          valueUsd: record.valueUsd,
          maxBudgetUsd: record.maxBudgetUsd,
          maxBudgetTokens: record.maxBudgetTokens,
          branchCount: record.branches.length,
        },
        `queued:${record.id}:created`,
      );
    });
    this.emit('organization.society.task.updated', { taskId: record.id, status: record.status });
    return record;
  }

  approveTask(taskId: string, tenantId: string, approved: boolean): SocietyTask {
    const task = this.repository().getSocietyTask(taskId, tenantId);
    if (!task) throw new OrganizationError(404, 'SOCIETY_TASK_NOT_FOUND', '社会任务不存在');
    if (task.status !== 'waiting_approval') throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '任务当前不需要审批');
    return this.repository().updateSocietyTask(task, {
      approval: approved ? 'approved' : 'rejected',
      status: approved ? 'queued' : 'cancelled',
      lastSchedulingReason: approved ? '人类已批准高额任务，等待制度调度' : '人类拒绝高额任务',
    });
  }

  private resourceUsage(
    task: SocietyTask,
    schedules: SocietySchedule[],
    institution: InstitutionVersion,
  ): {
    departmentActive: Map<string, number>;
    departmentCommittedUsd: Map<string, number>;
    departmentCommittedTokens: Map<string, number>;
    societyCommittedUsd: number;
    societyCommittedTokens: number;
    roleLoads: Map<string, number>;
    roleBudgetBlocked: Set<string>;
  } {
    const active = schedules.filter((schedule) => schedule.status === 'active');
    const eligibleRoles = this.selection.eligibleRoles(task, institution);
    const relevantRoles = new Set(eligibleRoles.map((role) => role.id));
    const roleLoads = new Map<string, number>();
    const roleSpend = new Map<string, number>();
    const roleTokenSpend = new Map<string, number>();
    for (const schedule of schedules) {
      for (const assignment of schedule.assignments) {
        const contract = assignment.contractId ? this.repository().getContract(assignment.contractId, task.tenantId) : undefined;
        const run = contract?.runId ? this.options.store.runs.get(contract.runId, task.tenantId) : undefined;
        const estimatedCost = schedule.estimates.teamCostUsd / Math.max(1, schedule.roleIds.length);
        const estimatedTokens = (schedule.estimates.teamTokens ?? task.maxBudgetTokens) / Math.max(1, schedule.roleIds.length);
        roleSpend.set(assignment.roleId, (roleSpend.get(assignment.roleId) ?? 0) + (run?.cost ?? estimatedCost));
        roleTokenSpend.set(
          assignment.roleId,
          (roleTokenSpend.get(assignment.roleId) ?? 0) + (run ? run.tokensIn + run.tokensOut : estimatedTokens),
        );
      }
    }
    for (const schedule of active)
      for (const assignment of schedule.assignments)
        if (relevantRoles.has(assignment.roleId)) roleLoads.set(assignment.roleId, (roleLoads.get(assignment.roleId) ?? 0) + 1);
    const estimatedPerRole = Math.max(0, task.maxBudgetUsd * 0.8) / Math.max(1, task.branches.length);
    const estimatedPerRoleTokens = Math.max(0, task.maxBudgetTokens) / Math.max(1, task.branches.length);
    const roleBudgetBlocked = new Set(
      eligibleRoles
        .filter(
          (role) =>
            (role.budgetLimitUsd !== undefined && (roleSpend.get(role.id) ?? 0) + estimatedPerRole > role.budgetLimitUsd) ||
            (role.budgetLimitTokens !== undefined && (roleTokenSpend.get(role.id) ?? 0) + estimatedPerRoleTokens > role.budgetLimitTokens),
        )
        .map((role) => role.id),
    );
    const departmentUsage = this.departmentUsage(schedules, task.tenantId, institution.policies.departments);
    return {
      departmentActive: new Map([...departmentUsage].map(([id, usage]) => [id, usage.activeAssignments])),
      departmentCommittedUsd: new Map([...departmentUsage].map(([id, usage]) => [id, usage.reservedUsd + usage.spentUsd])),
      departmentCommittedTokens: new Map([...departmentUsage].map(([id, usage]) => [id, usage.reservedTokens + usage.spentTokens])),
      societyCommittedUsd: [...departmentUsage.values()].reduce((sum, usage) => sum + usage.reservedUsd + usage.spentUsd, 0),
      societyCommittedTokens: [...departmentUsage.values()].reduce((sum, usage) => sum + usage.reservedTokens + usage.spentTokens, 0),
      roleLoads,
      roleBudgetBlocked,
    };
  }

  estimate(task: SocietyTask): SocietyEconomicsEstimate {
    const institution = this.ensureInstitution(task.tenantId);
    const roles = this.selection.rankedRoles(task, institution);
    const branchCount = task.branches.length;
    const teamSize = Math.min(institution.policies.maxTeamSize, Math.max(2, branchCount));
    const dependencies = dependencyIndexes(task.branches);
    const independent =
      branchCount >= 2 &&
      dependencies.filter((items) => items.length === 0).length >= 2 &&
      task.branches.every((branch) => branch.acceptance.length > 0);
    const materialTokens = task.materials.reduce((sum, ref) => {
      const size = this.options.store.materials.sizeForTenant(ref, task.tenantId);
      return sum + (size === undefined ? 0 : Math.ceil(size / 2));
    }, 0);
    const taskText = [
      task.objective,
      ...task.acceptance,
      ...task.branches.flatMap((branch) => [branch.objective, ...branch.acceptance, ...branch.expectedArtifacts]),
    ].join('\n');
    const sharedText = task.objective + '\n' + task.acceptance.join('\n');
    const runtimeRoute = firstPricedModel(this.options.store);
    const branchRoutes = task.branches.map((_branch, index): PricedModel | undefined => {
      const role = roles[index];
      if (
        !role ||
        !role.modelPolicy.providerId ||
        role.modelPolicy.providerId === 'institution' ||
        role.modelPolicy.model === 'runtime-selected'
      )
        return runtimeRoute;
      return resolvePricedModel(this.options.store, role.modelPolicy.providerId, role.modelPolicy.model);
    });
    const pricingRefs = [
      ...new Set([
        ...(runtimeRoute ? [`${runtimeRoute.providerId}@${runtimeRoute.model}`] : []),
        ...branchRoutes.filter((route): route is PricedModel => Boolean(route)).map((route) => `${route.providerId}@${route.model}`),
      ]),
    ];
    let costSource: SocietyEconomicsEstimate['costSource'] = 'configured';
    let soloCostUsd = task.maxBudgetUsd;
    let soloTokens = task.maxBudgetTokens;
    let teamCostUsd = task.maxBudgetUsd;
    let teamTokens = task.maxBudgetTokens;
    let coordinationCostUsd = 0;
    let coordinationTokens = 0;
    if (runtimeRoute && branchRoutes.every((route): route is PricedModel => Boolean(route))) {
      const soloEstimate = estimateModelWorkloadCost(this.options.store, {
        tenantId: task.tenantId,
        pricedModel: runtimeRoute,
        promptTokens: estimateTokens(taskText) + materialTokens,
        outputTokens: Math.max(512, task.branches.length * 512),
        fallbackCalls: 3,
      });
      soloCostUsd = soloEstimate.costUsd;
      soloTokens = soloEstimate.tokens;
      let teamEstimateCost = 0;
      let teamEstimateTokens = 0;
      let historical = false;
      for (let index = 0; index < task.branches.length; index += 1) {
        const branch = task.branches[index]!;
        const estimate = estimateModelWorkloadCost(this.options.store, {
          tenantId: task.tenantId,
          pricedModel: branchRoutes[index]!,
          promptTokens:
            estimateTokens(sharedText) +
            estimateTokens([branch.objective, ...branch.acceptance, ...branch.expectedArtifacts].join('\n')) +
            materialTokens,
          outputTokens: 512,
          fallbackCalls: 3,
        });
        teamEstimateCost += estimate.costUsd;
        teamEstimateTokens += estimate.tokens;
        historical ||= estimate.source === 'historical';
      }
      const coordination = estimateModelWorkloadCost(this.options.store, {
        tenantId: task.tenantId,
        pricedModel: runtimeRoute,
        promptTokens: estimateTokens(sharedText + '\n' + taskText),
        outputTokens: Math.max(128, roles.length * 64),
        fallbackCalls: 1,
      });
      coordinationCostUsd = independent ? coordination.costUsd : 0;
      coordinationTokens = independent ? Math.max(1, coordination.tokens) : 0;
      teamCostUsd = Math.round((teamEstimateCost + coordinationCostUsd) * 1_000_000) / 1_000_000;
      teamTokens = teamEstimateTokens + coordinationTokens;
      costSource = historical || soloEstimate.source === 'historical' ? 'historical' : 'configured';
    } else {
      costSource = 'unavailable';
      coordinationCostUsd = 0;
      coordinationTokens = 0;
    }
    const soloQuality = 1;
    const evidence = task.economics;
    const teamQuality = independent && roles.length >= 2 ? soloQuality + (evidence?.qualityGain ?? 0) : soloQuality;
    const latencyGainMs = independent && roles.length >= 2 ? (evidence?.latencyGainMs ?? 0) : 0;
    const latencyBenefitUsd = independent && roles.length >= 2 ? (evidence?.latencyBenefitUsd ?? 0) : 0;
    const riskReduction = independent && roles.length >= 2 ? (evidence?.riskReduction ?? 0) : 0;
    const soloNetBenefitUsd = task.valueUsd - soloCostUsd;
    const teamBenefitUsd = task.valueUsd * (teamQuality + riskReduction) + latencyBenefitUsd;
    const teamNetBenefitUsd = teamBenefitUsd - teamCostUsd - coordinationCostUsd;
    const roleFitPenalty = roles.length < teamSize ? Math.max(0, task.valueUsd * 0.05) : 0;
    const adjustedTeamNet = teamNetBenefitUsd - roleFitPenalty;
    return {
      costSource,
      pricingRefs,
      single: {
        costUsd: soloCostUsd,
        tokens: soloTokens,
        quality: soloQuality,
        latencyMs: branchCount * 2_000,
        risk: 0.12,
        netBenefitUsd: Math.round(soloNetBenefitUsd * 1e6) / 1e6,
      },
      team: {
        costUsd: teamCostUsd,
        coordinationCostUsd,
        tokens: teamTokens,
        coordinationTokens,
        quality: teamQuality,
        latencyGainMs,
        riskReduction,
        netBenefitUsd: Math.round(adjustedTeamNet * 1e6) / 1e6,
      },
      marginalNetBenefitUsd: Math.round((adjustedTeamNet - soloNetBenefitUsd) * 1e6) / 1e6,
      formula: 'net = value * (quality + riskReduction) + latencyBenefit - estimatedCost - coordinationCost; unmeasured gains stay zero',
    };
  }

  private teamRolesForBranches(task: SocietyTask, available: OrganizationRole[], institution: InstitutionVersion): OrganizationRole[] {
    if (task.branches.length > institution.policies.maxTeamSize) return [];
    const selected: OrganizationRole[] = [];
    for (const branch of task.branches) {
      const role = available.find(
        (candidate) =>
          !selected.some((item) => item.id === candidate.id) &&
          this.selection.roleDepartment(candidate, branch.departmentId ?? task.departmentId ?? '', institution.policies.departments),
      );
      if (!role) return [];
      selected.push(role);
    }
    return selected;
  }

  private teamRoutingCompatible(roles: OrganizationRole[]): boolean {
    const pinned = roles
      .map((role) => ({
        providerId: role.modelPolicy.providerId,
        model: role.modelPolicy.model,
      }))
      .filter((policy) => Boolean(policy.providerId) && policy.providerId !== 'institution' && policy.model !== 'runtime-selected');
    if (!pinned.length) return true;
    if (new Set(pinned.map((policy) => `${policy.providerId}\0${policy.model}`)).size > 1) return false;
    return Boolean(resolvePricedModel(this.options.store, pinned[0]!.providerId, pinned[0]!.model));
  }

  private queue(task: SocietyTask, reason: string): SocietyTask {
    let result!: SocietyTask;
    this.repository().transaction(() => {
      result = this.repository().updateSocietyTask(task, {
        status: task.approval === 'pending' ? 'waiting_approval' : 'queued',
        scheduleId: undefined,
        lastSchedulingReason: bounded(reason, 500, '调度原因'),
      });
      this.appendAudit(
        result,
        'queued',
        result.lastSchedulingReason!,
        {
          status: result.status,
          approval: result.approval,
          departmentId: result.departmentId,
          revision: result.revision,
        },
        `queued:${result.id}:${createHash('sha256')
          .update(result.lastSchedulingReason ?? '')
          .digest('hex')
          .slice(0, 16)}`,
      );
    });
    this.emit('organization.society.task.queued', { taskId: task.id, reason });
    return result;
  }

  tick(tenantId: string, projectId?: string): SocietyTickResult {
    const institution = this.ensureInstitution(tenantId);
    const decisions: SocietySchedule[] = [];
    for (const active of this.repository()
      .societySchedules(tenantId, SOCIETY_LIST_LIMIT)
      .filter((schedule) => schedule.status === 'active')) {
      const task = this.repository().getSocietyTask(active.taskId, tenantId);
      if (!task || (projectId && task.projectId !== projectId)) continue;
      try {
        this.advanceSchedule(active.id, tenantId);
      } catch (error) {
        this.failSchedule(task, active, error instanceof Error ? error.message : String(error));
      }
    }
    const tasks = this.repository()
      .societyTasks(tenantId, projectId, SOCIETY_LIST_LIMIT)
      .filter((task) => ['queued', 'waiting_approval'].includes(task.status))
      .sort((left, right) => right.priority - left.priority || right.valueUsd - left.valueUsd || left.createdAt - right.createdAt);
    for (const task of tasks) {
      if (task.approval === 'pending') {
        if (task.status !== 'waiting_approval') this.queue(task, '等待人类批准高额任务');
        continue;
      }
      if (task.approval === 'rejected' || task.status === 'cancelled') continue;
      const department = institution.policies.departments.find((item) => item.id === task.departmentId && item.enabled);
      if (!department) {
        this.queue(task, '部门不可用');
        continue;
      }
      const schedules = this.repository().societySchedules(tenantId, SOCIETY_LIST_LIMIT);
      const usage = this.resourceUsage(task, schedules, institution);
      const ranking = this.selection.rankRoles(task, institution);
      const roleById = new Map(this.selection.eligibleRoles(task, institution).map((role) => [role.id, role]));
      const roles = ranking.candidates
        .filter((score) => score.eligible)
        .map((score) => roleById.get(score.roleId))
        .filter((role): role is OrganizationRole => Boolean(role));
      const wellbeing = this.organization.wellbeing(tenantId, projectId);
      const contextBlocked = new Set(wellbeing.filter((item) => item.contextPressure === 'high').map((item) => item.roleId));
      const failureBlocked = new Set(
        wellbeing
          .filter((item) => item.failureBackoffUntil !== undefined && item.failureBackoffUntil > this.now())
          .map((item) => item.roleId),
      );
      const waitingBlocked = new Set(wellbeing.filter((item) => item.waitingApproval > 0).map((item) => item.roleId));
      const available = roles.filter(
        (role) =>
          !usage.roleBudgetBlocked.has(role.id) &&
          !contextBlocked.has(role.id) &&
          !failureBlocked.has(role.id) &&
          !waitingBlocked.has(role.id) &&
          (usage.roleLoads.get(role.id) ?? 0) < institution.policies.welfareMaxActiveAssignments,
      );
      if (!available.length) {
        const permissionBlocked = ranking.candidates.filter((score) => !score.eligible);
        this.queue(
          task,
          permissionBlocked.length
            ? (permissionBlocked[0]!.blockedReason ?? '角色权限不覆盖任务能力')
            : usage.roleBudgetBlocked.size
              ? '角色预算不足'
              : failureBlocked.size
                ? '角色连续失败，处于退避恢复期'
                : waitingBlocked.size
                  ? '角色正在等待审批，保持休眠'
                  : contextBlocked.size
                    ? '角色上下文压力过高，等待压缩、拆分或回退单角色'
                    : '角色负载达到福利上限',
        );
        continue;
      }
      const economics = this.estimate(task);
      const plannedArtifacts = new Set(
        task.branches.flatMap((branch) => branch.expectedArtifacts.map((item) => item.trim().toLowerCase())).filter(Boolean),
      );
      const independentBranches =
        task.branches.length >= 2 &&
        plannedArtifacts.size >= task.branches.length &&
        task.branches.every((branch) => branch.acceptance.length > 0);
      const evidenceExperiment = task.evidenceExperimentId ? this.pairedExperiment(task.evidenceExperimentId, task.tenantId) : undefined;
      const evidenceMarginal = evidenceExperiment?.status === 'measured' ? evidenceExperiment.netBenefitUsd?.marginal : undefined;
      const evidenceFallbackReason = evidenceExperiment
        ? evidenceMarginal === undefined
          ? '配对净收益实验缺少可核对结果，保持单角色'
          : evidenceMarginal < institution.policies.minNetBenefitUsd
            ? `配对实测边际净收益 ${evidenceMarginal} USD 未达到门槛，保持单角色`
            : undefined
        : undefined;
      let teamFallbackReason: string | undefined = evidenceFallbackReason;
      let teamRoles =
        independentBranches && available.length >= Math.min(2, task.branches.length)
          ? this.teamRolesForBranches(task, available, institution)
          : [];
      if (teamRoles.length > 1 && !this.teamRoutingCompatible(teamRoles)) {
        teamFallbackReason = '团队角色模型、tokenizer 或价格口径不可比，保持单角色';
        teamRoles = [];
      }
      const teamEligible =
        teamRoles.length > 1 &&
        !evidenceFallbackReason &&
        economics.costSource !== 'unavailable' &&
        economics.team.costUsd <= task.maxBudgetUsd + 1e-10 &&
        economics.team.tokens <= task.maxBudgetTokens &&
        this.teamCostEligible(task.objective, economics) &&
        economics.marginalNetBenefitUsd >= institution.policies.minNetBenefitUsd &&
        economics.team.netBenefitUsd > economics.single.netBenefitUsd;
      if (!teamFallbackReason) {
        teamFallbackReason =
          economics.costSource === 'unavailable'
            ? '当前模型价格未配置，无法证明团队净收益，保持单角色'
            : economics.team.costUsd > task.maxBudgetUsd + 1e-10
              ? '服务端团队成本估算超过任务硬预算，保持单角色'
              : economics.team.tokens > task.maxBudgetTokens
                ? '服务端团队 token 估算超过任务硬预算，保持单角色'
                : !this.teamCostEligible(task.objective, economics)
                  ? '团队估算高于单角色方案，保持单角色'
                  : undefined;
      }
      if (!teamEligible && teamRoles.length) teamRoles = [];
      const soloRole =
        available.find((role) => this.selection.roleDepartment(role, task.departmentId ?? '', institution.policies.departments)) ??
        available[0];
      const selected = teamRoles.length === task.branches.length ? teamRoles : [soloRole];
      const useTeam = teamRoles.length > 1;
      if (!teamEligible && economics.single.netBenefitUsd <= institution.policies.minNetBenefitUsd) {
        this.queue(task, '单角色净收益不足，等待人类重新估价或缩小预算');
        continue;
      }
      const assignments = useTeam
        ? task.branches.map((branch, index) => {
            const role = selected[index]!;
            const fallbackTokens = Math.max(1, Math.floor(task.maxBudgetTokens / task.branches.length));
            const cognitiveTier =
              index === 0 ? ('decision' as const) : branch.expectedArtifacts.length === 0 ? ('utility' as const) : ('execution' as const);
            return {
              roleId: role.id,
              departmentId:
                this.departmentForRole(role, institution.policies.departments)?.id ??
                branch.departmentId ??
                task.departmentId ??
                department.id,
              branchObjective: branch.objective,
              expectedArtifacts: branch.expectedArtifacts,
              acceptance: branch.acceptance,
              cognitiveTier,
              routingStrategy: institution.policies.cognitiveRouting[cognitiveTier],
              dependsOn: branch.dependsOn ?? [],
              budgetTokens: branch.maxBudgetTokens ?? fallbackTokens,
              providerId: cognitiveTier === 'decision' ? '' : role.modelPolicy.providerId,
              model: cognitiveTier === 'decision' ? 'runtime-selected' : role.modelPolicy.model,
              ...(cognitiveTier === 'decision' || !role.modelPolicy.providerId ? { fallbackReason: '该认知层由制度路由到当前主模型' } : {}),
            };
          })
        : [
            {
              roleId: selected[0]!.id,
              departmentId:
                this.departmentForRole(selected[0]!, institution.policies.departments)?.id ?? task.departmentId ?? department.id,
              branchObjective: task.objective,
              expectedArtifacts: [...new Set(task.branches.flatMap((branch) => branch.expectedArtifacts))],
              acceptance: [...new Set([...task.acceptance, ...task.branches.flatMap((branch) => branch.acceptance)])],
              cognitiveTier: 'decision' as const,
              routingStrategy: institution.policies.cognitiveRouting.decision,
              dependsOn: [],
              budgetTokens: task.maxBudgetTokens,
              providerId: selected[0]!.modelPolicy.providerId,
              model: selected[0]!.modelPolicy.model,
              ...(selected[0]!.modelPolicy.providerId ? {} : { fallbackReason: '角色未固定模型，由运行时使用当前可用主模型' }),
            },
          ];
      const selectedIds = new Set(selected.map((role) => role.id));
      const selection: SocietyScheduleSelection = {
        policyVersion: institution.version,
        requiredCapabilities: ranking.requiredCapabilities,
        weights: { ...(institution.policies.roleSelectionWeights ?? ROLE_SELECTION_WEIGHTS) },
        chosenRoleIds: [...selectedIds],
        candidates: ranking.candidates.map((candidate) => {
          const blockedReason =
            candidate.blockedReason ??
            (usage.roleBudgetBlocked.has(candidate.roleId) ? '角色预算不足' : undefined) ??
            (failureBlocked.has(candidate.roleId) ? '角色连续失败，处于退避恢复期' : undefined) ??
            (waitingBlocked.has(candidate.roleId) ? '角色正在等待审批，保持休眠' : undefined) ??
            (contextBlocked.has(candidate.roleId)
              ? '角色上下文压力过高'
              : (usage.roleLoads.get(candidate.roleId) ?? 0) >= institution.policies.welfareMaxActiveAssignments
                ? '角色负载达到福利上限'
                : undefined);
          return {
            ...candidate,
            eligible: candidate.eligible && !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
          };
        }),
      };
      const requestedByDepartment = new Map<string, { active: number; usd: number; tokens: number }>();
      const branchBudgetUsd = task.maxBudgetUsd / Math.max(1, assignments.length);
      for (const assignment of assignments) {
        const departmentId = assignment.departmentId!;
        const requested = requestedByDepartment.get(departmentId) ?? { active: 0, usd: 0, tokens: 0 };
        requested.active += 1;
        requested.usd += assignment.cognitiveTier === 'utility' ? 0 : branchBudgetUsd;
        requested.tokens += assignment.budgetTokens;
        requestedByDepartment.set(departmentId, requested);
      }
      let blockedReason: string | undefined;
      for (const [departmentId, requested] of requestedByDepartment) {
        const policy = institution.policies.departments.find((item) => item.id === departmentId && item.enabled);
        if (!policy) {
          blockedReason = `部门不可用：${departmentId}`;
          break;
        }
        if ((usage.departmentActive.get(departmentId) ?? 0) + requested.active > policy.maxConcurrent) {
          blockedReason = '部门并发已满';
          break;
        }
        if ((usage.departmentCommittedUsd.get(departmentId) ?? 0) + requested.usd > policy.quotaUsd) {
          blockedReason = '部门预算配额不足';
          break;
        }
        if ((usage.departmentCommittedTokens.get(departmentId) ?? 0) + requested.tokens > policy.quotaTokens) {
          blockedReason = '部门 token 配额不足';
          break;
        }
      }
      if (blockedReason) {
        this.queue(task, blockedReason);
        continue;
      }
      if (usage.societyCommittedUsd + task.maxBudgetUsd > institution.policies.societyBudgetUsd) {
        this.queue(task, '社会总预算不足');
        continue;
      }
      if (usage.societyCommittedTokens + task.maxBudgetTokens > institution.policies.societyTokenBudget) {
        this.queue(task, '社会 token 总预算不足');
        continue;
      }
      const now = this.now();
      const schedule: SocietySchedule = {
        id: randomUUID(),
        tenantId,
        taskId: task.id,
        trigger: 'institution',
        institutionVersion: institution.version,
        departmentId: department.id,
        contractIds: [],
        runIds: [],
        mode: useTeam ? 'team' : 'solo',
        roleIds: selected.map((role) => role.id),
        assignments,
        formula: economics.formula,
        estimates: {
          soloCostUsd: economics.single.costUsd,
          teamCostUsd: useTeam ? economics.team.costUsd : economics.single.costUsd,
          coordinationCostUsd: useTeam ? economics.team.coordinationCostUsd : 0,
          soloNetBenefitUsd: economics.single.netBenefitUsd,
          teamNetBenefitUsd: economics.team.netBenefitUsd,
          marginalNetBenefitUsd: economics.marginalNetBenefitUsd,
          qualityGain: economics.team.quality - economics.single.quality,
          latencyGainMs: economics.team.latencyGainMs,
          riskReduction: economics.team.riskReduction,
          soloTokens: economics.single.tokens,
          teamTokens: useTeam ? economics.team.tokens : economics.single.tokens,
          coordinationTokens: useTeam ? economics.team.coordinationTokens : 0,
          roi: economics.team.costUsd > 0 ? Math.round((economics.team.netBenefitUsd / economics.team.costUsd) * 1000) / 1000 : null,
        },
        sharedMemoryRefs: task.materials.map((material) => ({
          id: `material:${material.id}:${material.version}`,
          kind: 'material',
          ref: material.id,
          version: material.version,
        })),
        selection,
        reason: useTeam
          ? '独立分支净收益超过单角色门槛，建立短周期组织'
          : (teamFallbackReason ?? '单角色即可完成或团队净收益不足，保持单角色执行'),
        status: 'active',
        createdAt: now,
      };
      this.repository().transaction(() => {
        this.repository().createSocietySchedule(schedule);
        this.repository().updateSocietyTask(task, {
          status: 'scheduled',
          scheduleId: schedule.id,
          lastSchedulingReason: schedule.reason,
        });
        this.appendAudit(
          { ...task, status: 'scheduled', scheduleId: schedule.id },
          'scheduled',
          schedule.reason,
          {
            institutionVersion: institution.version,
            mode: schedule.mode,
            roleIds: schedule.roleIds,
            selectedByDepartment: schedule.assignments.map((assignment) => ({
              roleId: assignment.roleId,
              departmentId: assignment.departmentId,
            })),
            excludedCandidates:
              schedule.selection?.candidates
                .filter((candidate) => !candidate.eligible)
                .map((candidate) => ({
                  roleId: candidate.roleId,
                  score: candidate.score,
                  blockedReason: candidate.blockedReason ?? 'unknown',
                })) ?? [],
            estimates: schedule.estimates,
            fallbackReason: useTeam ? undefined : teamFallbackReason,
          },
          `scheduled:${schedule.id}`,
        );
        for (const roleId of schedule.roleIds) {
          this.repository().appendRoleMemory({
            id: randomUUID(),
            tenantId,
            roleId,
            kind: 'schedule',
            summary: `${schedule.mode === 'team' ? '加入短周期团队' : '接受单角色任务'}：${task.objective}`,
            scheduleId: schedule.id,
            evidence: schedule.sharedMemoryRefs,
            createdAt: now,
          });
        }
        // Relation scores come from real handoff/review/conflict events only.
        // Scheduling two roles into one team is not evidence of collaboration quality.
      });
      let executed = schedule;
      try {
        executed = this.launchSchedule(task, schedule);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.terminateSchedule(task, schedule, reason);
      }
      decisions.push(executed);
      this.emit('organization.society.scheduled', {
        taskId: task.id,
        scheduleId: executed.id,
        mode: executed.mode,
        roleIds: executed.roleIds,
        marginalNetBenefitUsd: executed.estimates.marginalNetBenefitUsd,
        workOrderId: executed.workOrderId,
        runIds: executed.runIds,
      });
    }
    return {
      decisions,
      queued: this.repository()
        .societyTasks(tenantId, projectId, SOCIETY_LIST_LIMIT)
        .filter((task) => task.status === 'queued').length,
      waitingApproval: this.repository()
        .societyTasks(tenantId, projectId, SOCIETY_LIST_LIMIT)
        .filter((task) => task.status === 'waiting_approval').length,
      snapshot: this.snapshot(tenantId, projectId),
    };
  }

  tickAll(): SocietyTickAllResult {
    const result: SocietyTickAllResult = {
      tenants: 0,
      decisions: [],
      queued: 0,
      waitingApproval: 0,
      failed: [],
    };
    for (const tenant of this.options.store.listTenants()) {
      const pending = this.repository()
        .societyTasks(tenant.id, undefined, SOCIETY_LIST_LIMIT)
        .some((task) => task.status === 'queued' || task.status === 'waiting_approval');
      const recoverable = this.repository()
        .societySchedules(tenant.id, SOCIETY_LIST_LIMIT)
        .some((schedule) => schedule.status === 'active');
      if (!pending && !recoverable) continue;
      result.tenants += 1;
      try {
        const tick = this.tick(tenant.id);
        result.decisions.push(...tick.decisions);
        result.queued += tick.queued;
        result.waitingApproval += tick.waitingApproval;
      } catch (error) {
        result.failed.push({
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private runUsage(schedule: SocietySchedule, tenantId: string): RunUsage {
    const contractRunIds = (schedule.contractIds ?? []).flatMap((id) => {
      const contract = this.repository().getContract(id, tenantId);
      return contract?.runId ? [contract.runId] : [];
    });
    const runs = [...new Set([...(schedule.runIds ?? []), ...contractRunIds])]
      .map((runId) => this.options.store.runs.get(runId, tenantId))
      .filter((run): run is RunRecord => !!run);
    return {
      runs,
      costUsd: runs.reduce((sum, run) => sum + run.cost, 0),
      tokens: runs.reduce((sum, run) => sum + run.tokensIn + run.tokensOut, 0),
      cachedInputTokens: runs.reduce((sum, run) => sum + (run.tokensCached ?? 0), 0),
      cacheMissTokens: runs.reduce((sum, run) => sum + (run.tokensCacheMiss ?? 0), 0),
      cacheWriteTokens: runs.reduce((sum, run) => sum + (run.cacheWriteTokens ?? 0), 0),
      usageKnown: runs.length > 0 && runs.every((run) => run.usageStatus === 'reported'),
      cacheUsageKnown:
        runs.length > 0 &&
        runs.every((run) => run.usageStatus === 'reported' && run.tokensCached !== undefined && run.tokensCacheMiss !== undefined),
      cacheWriteKnown: runs.length > 0 && runs.every((run) => run.usageStatus === 'reported' && run.cacheWriteTokens !== undefined),
    };
  }

  private contractDelivery(run: RunRecord): void {
    if (run.status === 'interrupted' && run.origin?.kind === 'society') return;
    const active = this.repository()
      .contractsForRun(run.id, run.tenantId)
      .find((contract) => contract.status === 'active');
    if (active) {
      this.organization.deliver(run.id, run.tenantId, {
        summary: (run.answer ?? run.error ?? `任务状态：${run.status}`).slice(0, 4000),
      });
    }
    this.organization.finalizeRun(run);
  }

  private watchRun(runId: string, tenantId: string, scheduleId: string): void {
    if (!this.runs || this.watchedRuns.has(runId)) return;
    let stop = () => {};
    const inspect = () => {
      let latest: RunRecord;
      try {
        latest = this.runs!.get(runId, tenantId);
      } catch {
        return;
      }
      if (!RUN_TERMINAL.has(latest.status)) return;
      if (latest.status === 'interrupted' && latest.origin?.kind === 'society') return;
      stop();
      this.watchedRuns.delete(runId);
      this.contractDelivery(latest);
      if (this.repository().getSocietySchedule(scheduleId, tenantId)?.status === 'active') this.advanceSchedule(scheduleId, tenantId);
    };
    stop = this.runs.subscribe(runId, inspect);
    this.watchedRuns.set(runId, stop);
    inspect();
  }

  private stopWatching(runIds: Iterable<string>): void {
    for (const runId of runIds) {
      this.watchedRuns.get(runId)?.();
      this.watchedRuns.delete(runId);
    }
  }

  private failSchedule(task: SocietyTask, schedule: SocietySchedule, reason: string, allowFallback = true): void {
    const currentSchedule = this.repository().getSocietySchedule(schedule.id, task.tenantId);
    const currentTask = this.repository().getSocietyTask(task.id, task.tenantId);
    if (!currentSchedule || !currentTask || currentSchedule.status !== 'active') return;
    if (allowFallback && currentSchedule.mode === 'team' && this.collapseTeamToSolo(currentTask, currentSchedule, reason)) return;
    this.terminateSchedule(currentTask, currentSchedule, reason);
  }

  private terminateSchedule(task: SocietyTask, schedule: SocietySchedule, reason: string): void {
    this.stopWatching(schedule.runIds ?? []);
    const runIds = new Set(schedule.runIds ?? []);
    const contracts = (schedule.contractIds ?? [])
      .map((id) => this.repository().getContract(id, task.tenantId))
      .filter((item): item is AssignmentContract => !!item);
    const evidence = contracts
      .flatMap((contract) => contract.delivery?.evidence ?? contract.evidenceInputs)
      .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
    const roleIds = new Set([...schedule.roleIds, ...contracts.map((contract) => contract.roleId)]);
    for (const contractId of schedule.contractIds ?? []) {
      const contract = this.repository().getContract(contractId, task.tenantId);
      if (contract?.runId) runIds.add(contract.runId);
      if (contract?.status === 'proposed')
        this.repository().updateContract(
          contract,
          {
            status: 'failed',
            delivery: {
              summary: reason.slice(0, 4000),
              artifacts: [],
              evidence: contract.evidenceInputs,
              unfinished: [reason],
              costUsd: 0,
              usageKnown: true,
            },
          },
          contract.revision,
        );
    }
    for (const runId of runIds) {
      const run = this.options.store.runs.get(runId, task.tenantId);
      if (run && !RUN_TERMINAL.has(run.status)) this.runs?.cancel(runId, task.tenantId);
    }
    const now = this.now();
    this.repository().transaction(() => {
      for (const roleId of roleIds) {
        const recorded = this.repository()
          .roleMemories(task.tenantId, roleId, 50)
          .some((memory) => memory.kind === 'failure' && memory.scheduleId === schedule.id);
        if (!recorded)
          this.repository().appendRoleMemory({
            id: randomUUID(),
            tenantId: task.tenantId,
            roleId,
            kind: 'failure',
            summary: `任务执行失败：${reason}`.slice(0, 1000),
            scheduleId: schedule.id,
            workOrderId: schedule.workOrderId,
            evidence,
            createdAt: now,
          });
      }
      this.repository().updateSocietySchedule(schedule, {
        status: 'failed',
        releasedAt: now,
        reason: reason.slice(0, 500),
      });
      if (!['completed', 'cancelled', 'failed'].includes(task.status))
        this.repository().updateSocietyTask(task, {
          status: 'failed',
          lastSchedulingReason: `真实执行未通过：${reason}`.slice(0, 500),
        });
      this.appendAudit(
        { ...task, status: 'failed', scheduleId: schedule.id },
        'release_failed',
        reason,
        {
          previousStatus: schedule.status,
          status: 'failed',
          runIds: [...runIds],
          roleIds: [...roleIds],
          artifacts: contracts.flatMap((contract) => contract.delivery?.artifacts ?? []),
          evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, ref: item.ref })),
        },
        `release_failed:${schedule.id}`,
      );
    });
    this.emit('organization.society.failed', {
      taskId: task.id,
      scheduleId: schedule.id,
      reason,
      workOrderId: schedule.workOrderId,
      runIds: [...runIds],
    });
  }

  private collapseTeamToSolo(task: SocietyTask, schedule: SocietySchedule, reason: string): boolean {
    if (!this.runs || !schedule.workOrderId) return false;
    const institution = this.ensureInstitution(task.tenantId);
    const workOrder = this.repository().getWorkOrder(schedule.workOrderId, task.tenantId);
    if (!workOrder) return false;
    const contracts = (schedule.contractIds ?? [])
      .map((id) => this.repository().getContract(id, task.tenantId))
      .filter((item): item is AssignmentContract => !!item);
    const delivered = contracts.filter((contract) => contract.status === 'delivered');
    const coordinator =
      schedule.assignments
        .map((assignment) => this.repository().getRole(assignment.roleId, task.tenantId))
        .find((role): role is OrganizationRole => !!role && role.employment === 'active') ??
      this.selection.rankedRoles(task, institution).find((role) => role.employment === 'active');
    if (!coordinator) return false;
    const coordinatorDepartmentId = this.departmentForRole(coordinator, institution.policies.departments)?.id ?? schedule.departmentId;
    const usage = this.runUsage(schedule, task.tenantId);
    const remainingTokens = task.maxBudgetTokens - usage.tokens;
    const remainingUsd = Math.round((task.maxBudgetUsd - usage.costUsd) * 1_000_000) / 1_000_000;
    if (remainingTokens < 1 || remainingUsd <= 0) return false;
    const coordinatorDepartment = institution.policies.departments.find((item) => item.id === coordinatorDepartmentId && item.enabled);
    if (!coordinatorDepartment) return false;
    const allUsage = this.departmentUsage(
      this.repository().societySchedules(task.tenantId, SOCIETY_LIST_LIMIT),
      task.tenantId,
      institution.policies.departments,
    ).get(coordinatorDepartmentId);
    const currentUsage = this.departmentUsage([schedule], task.tenantId, institution.policies.departments).get(coordinatorDepartmentId);
    const otherCommittedUsd = Math.max(
      0,
      (allUsage?.reservedUsd ?? 0) + (allUsage?.spentUsd ?? 0) - (currentUsage?.reservedUsd ?? 0) - (currentUsage?.spentUsd ?? 0),
    );
    const otherCommittedTokens = Math.max(
      0,
      (allUsage?.reservedTokens ?? 0) +
        (allUsage?.spentTokens ?? 0) -
        (currentUsage?.reservedTokens ?? 0) -
        (currentUsage?.spentTokens ?? 0),
    );
    if (Math.max(0, (allUsage?.activeAssignments ?? 0) - (currentUsage?.activeAssignments ?? 0)) + 1 > coordinatorDepartment.maxConcurrent)
      return false;
    if (otherCommittedUsd + (currentUsage?.spentUsd ?? 0) + remainingUsd > coordinatorDepartment.quotaUsd) return false;
    if (otherCommittedTokens + (currentUsage?.spentTokens ?? 0) + remainingTokens > coordinatorDepartment.quotaTokens) return false;

    const artifacts = [...new Set(delivered.flatMap((contract) => contract.delivery?.artifacts ?? []))];
    const retainedExpected = new Set(
      delivered.flatMap((contract) => contract.expectedArtifacts).map((path) => path.replace(/\\/g, '/').toLowerCase()),
    );
    const expectedArtifacts = [
      ...new Set([
        ...contracts.filter((contract) => contract.status !== 'delivered').flatMap((contract) => contract.expectedArtifacts),
        ...task.branches
          .flatMap((branch) => branch.expectedArtifacts)
          .filter((path) => !retainedExpected.has(path.replace(/\\/g, '/').toLowerCase())),
      ]),
    ];
    const evidence = [
      ...schedule.sharedMemoryRefs,
      ...contracts.flatMap((contract) => contract.delivery?.evidence ?? contract.evidenceInputs),
      ...artifacts.map((ref) => ({ id: `artifact:${ref}`, kind: 'artifact', ref })),
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
    const acceptance = [
      ...new Set([
        ...task.acceptance,
        ...contracts.flatMap((contract) => contract.acceptance.map((item) => item.statement)),
        ...task.branches.flatMap((branch) => branch.acceptance),
      ]),
    ];
    const completed = delivered.map((contract) => `${contract.branchObjective}：${contract.delivery?.summary ?? '已交付'}`).join('；');
    const branchObjective =
      `团队执行受阻，请作为协调角色继续完成原任务。原目标：${task.objective}` +
      (completed ? `。已完成分工：${completed}` : '') +
      `。未完成原因：${reason}`;
    const fallbackAssignment: SocietyScheduleAssignment = {
      roleId: coordinator.id,
      departmentId: coordinatorDepartmentId,
      branchObjective: branchObjective.slice(0, 2000),
      expectedArtifacts,
      acceptance,
      cognitiveTier: 'decision',
      routingStrategy: institution.policies.cognitiveRouting.decision,
      dependsOn: [],
      budgetTokens: remainingTokens,
      providerId: '',
      model: 'runtime-selected',
      fallbackReason: 'ROLLBACK_TO_SOLO',
    };
    const now = this.now();
    const fallbackContract: AssignmentContract = {
      id: randomUUID(),
      tenantId: task.tenantId,
      workOrderId: schedule.workOrderId,
      roleId: coordinator.id,
      departmentId: coordinatorDepartmentId,
      branchObjective: fallbackAssignment.branchObjective,
      expectedArtifacts,
      acceptance: acceptance.map((statement, index) => ({
        id: `fallback-acceptance-${index + 1}`,
        statement,
      })),
      evidenceInputs: evidence,
      dependsOn: [],
      budgetUsd: remainingUsd,
      budgetTokens: remainingTokens,
      deadlineAt: workOrder.deadlineAt,
      allowedTools: coordinator.authority.allowedTools,
      status: 'proposed',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    fallbackAssignment.contractId = fallbackContract.id;
    this.stopWatching(schedule.runIds ?? []);

    this.repository().transaction(() => {
      for (const contract of contracts) {
        if (contract.status === 'delivered') continue;
        const run = contract.runId ? this.options.store.runs.get(contract.runId, task.tenantId) : undefined;
        this.repository().updateContract(
          contract,
          {
            status: 'collapsed',
            delivery: {
              summary: contract.delivery?.summary ?? `团队回退：${reason}`.slice(0, 4000),
              artifacts: contract.delivery?.artifacts ?? (run ? this.options.store.runs.artifacts(run.id).map((item) => item.ref) : []),
              evidence: contract.delivery?.evidence ?? contract.evidenceInputs,
              unfinished: contract.delivery?.unfinished ?? [reason],
              costUsd: contract.delivery?.costUsd ?? run?.cost ?? 0,
              usageKnown: contract.delivery?.usageKnown ?? run?.usageStatus === 'reported',
            },
          },
          contract.revision,
        );
        this.repository().appendRoleMemory({
          id: randomUUID(),
          tenantId: task.tenantId,
          roleId: contract.roleId,
          kind: 'failure',
          summary: `团队执行未完成：${reason}`.slice(0, 1000),
          scheduleId: schedule.id,
          workOrderId: schedule.workOrderId,
          evidence: contract.delivery?.evidence ?? contract.evidenceInputs,
          createdAt: now,
        });
      }
      this.repository().createContract(fallbackContract);
      this.repository().appendLedger({
        id: randomUUID(),
        tenantId: task.tenantId,
        workOrderId: workOrder.id,
        contractId: fallbackContract.id,
        type: 'handoff',
        actorId: coordinator.id,
        summary: `团队回退单角色协调交付：${reason}`.slice(0, 1000),
        evidence,
        createdAt: now,
      });
      this.repository().updateSocietySchedule(schedule, {
        mode: 'solo',
        roleIds: [coordinator.id],
        assignments: [fallbackAssignment],
        contractIds: [fallbackContract.id],
        reason: `团队失败后回退单角色：${reason}`.slice(0, 500),
        estimates: {
          ...schedule.estimates,
          soloCostUsd: remainingUsd,
          soloTokens: remainingTokens,
          teamCostUsd: Math.round((usage.costUsd + remainingUsd) * 1_000_000) / 1_000_000,
          teamTokens: usage.tokens + remainingTokens,
        },
      });
      if (schedule.teamCycleId) {
        const cycle = this.repository().getTeamCycle(schedule.teamCycleId, task.tenantId);
        if (cycle && !['completed', 'cancelled', 'dissolved'].includes(cycle.status))
          this.repository().updateTeamCycle(cycle, { status: 'partial' });
      }
      this.repository().updateSocietyTask(task, {
        status: 'scheduled',
        lastSchedulingReason: `团队失败，已回退单角色：${reason}`.slice(0, 500),
      });
      this.appendAudit(
        { ...task, status: 'scheduled', scheduleId: schedule.id },
        'fallback_solo',
        reason,
        {
          previousMode: 'team',
          mode: 'solo',
          coordinatorRoleId: coordinator.id,
          retainedContracts: delivered.map((contract) => contract.id),
          collapsedContracts: contracts.filter((contract) => contract.status !== 'delivered').map((contract) => contract.id),
          fallbackContractId: fallbackContract.id,
          remainingBudgetUsd: remainingUsd,
          remainingBudgetTokens: remainingTokens,
          evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, ref: item.ref })),
        },
        `fallback_solo:${schedule.id}:${fallbackContract.id}`,
      );
    });

    for (const runId of schedule.runIds ?? []) {
      const run = this.options.store.runs.get(runId, task.tenantId);
      if (run && run.status !== 'stopping' && !RUN_TERMINAL.has(run.status)) this.runs.cancel(runId, task.tenantId);
    }

    let fallbackSchedule = this.repository().getSocietySchedule(schedule.id, task.tenantId)!;
    try {
      const run = this.runs.startSocietyAssignment({
        task,
        schedule: fallbackSchedule,
        role: coordinator,
        contract: fallbackContract,
        assignment: fallbackAssignment,
      });
      this.options.store.runs.update(run, { fallbackReason: 'ROLLBACK_TO_SOLO' }, 'team_collapsed', {
        teamCycleId: schedule.teamCycleId,
        reason: reason.slice(0, 500),
        retainedContracts: delivered.map((contract) => contract.id),
      });
      fallbackAssignment.runId = run.id;
      fallbackSchedule = this.repository().updateSocietySchedule(fallbackSchedule, {
        assignments: [fallbackAssignment],
        runIds: [...new Set([...(fallbackSchedule.runIds ?? []), run.id])],
      });
      this.watchRun(run.id, task.tenantId, fallbackSchedule.id);
      this.emit('organization.society.fallback', {
        taskId: task.id,
        scheduleId: schedule.id,
        roleId: coordinator.id,
        runId: run.id,
        reason,
        retainedContracts: delivered.map((contract) => contract.id),
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      this.terminateSchedule(task, fallbackSchedule, `团队回退单角色启动失败：${failure}`);
    }
    return true;
  }

  private launchSchedule(task: SocietyTask, schedule: SocietySchedule): SocietySchedule {
    return this.advanceSchedule(schedule.id, task.tenantId).schedule ?? schedule;
  }

  private advanceSchedule(scheduleId: string, tenantId: string): { task?: SocietyTask; schedule?: SocietySchedule } {
    if (!this.runs) throw new OrganizationError(503, 'SOCIETY_RUNTIME_UNAVAILABLE', '社会执行运行时尚未连接');
    if (this.advancing.has(scheduleId)) {
      return {
        task: this.repository().getSocietySchedule(scheduleId, tenantId)?.taskId
          ? this.repository().getSocietyTask(this.repository().getSocietySchedule(scheduleId, tenantId)!.taskId, tenantId)
          : undefined,
        schedule: this.repository().getSocietySchedule(scheduleId, tenantId),
      };
    }
    this.advancing.add(scheduleId);
    try {
      let schedule = this.repository().getSocietySchedule(scheduleId, tenantId);
      if (!schedule || schedule.status !== 'active') return { schedule };
      const task = this.repository().getSocietyTask(schedule.taskId, tenantId);
      if (!task) {
        this.repository().updateSocietySchedule(schedule, {
          status: 'failed',
          reason: '社会任务不存在',
          releasedAt: this.now(),
        });
        return { schedule };
      }
      const plan = this.organization.createSocietyExecution(task, schedule);
      if (plan.contracts.length !== schedule.assignments.length) {
        this.failSchedule(task, schedule, '分工契约数量与调度计划不一致');
        return {
          task: this.repository().getSocietyTask(task.id, tenantId),
          schedule: this.repository().getSocietySchedule(schedule.id, tenantId),
        };
      }
      let contracts = plan.contracts;
      const assignments = schedule.assignments.map((assignment, index) => ({
        ...assignment,
        contractId: contracts[index].id,
        runId: contracts[index].runId ?? assignment.runId,
      }));
      schedule = this.repository().updateSocietySchedule(schedule, {
        workOrderId: plan.workOrder.id,
        teamCycleId: plan.teamCycle?.id,
        contractIds: contracts.map((contract) => contract.id),
        runIds: [...new Set(contracts.flatMap((contract) => (contract.runId ? [contract.runId] : [])))],
        assignments,
      });

      contracts = schedule.contractIds.map((id) => this.repository().getContract(id, tenantId)!);
      for (const contract of contracts) {
        if (contract.status !== 'active' || !contract.runId) continue;
        const run = this.options.store.runs.get(contract.runId, tenantId);
        if (!run) {
          this.repository().updateContract(
            contract,
            {
              status: 'failed',
              delivery: {
                summary: '契约记录了不存在的 Run',
                artifacts: [],
                evidence: contract.evidenceInputs,
                unfinished: ['运行记录缺失'],
                costUsd: 0,
                usageKnown: true,
              },
            },
            contract.revision,
          );
          continue;
        }
        if (run.status === 'interrupted' && run.origin?.kind === 'society' && this.runs.resume) {
          try {
            const resumed = this.runs.resume(run.id, tenantId);
            if (RUN_TERMINAL.has(resumed.status)) this.contractDelivery(resumed);
            else this.watchRun(resumed.id, tenantId, schedule.id);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.options.store.runs.update(run, {
              error: `社会任务恢复失败：${reason}`,
            });
            const failed = this.options.store.runs.get(run.id, tenantId) ?? run;
            this.contractDelivery(failed);
          }
        } else if (RUN_TERMINAL.has(run.status)) {
          this.contractDelivery(run);
        } else {
          this.watchRun(run.id, tenantId, schedule.id);
        }
      }

      contracts = schedule.contractIds.map((id) => this.repository().getContract(id, tenantId)!);
      for (let index = 0; index < contracts.length; index += 1) {
        const contract = contracts[index];
        if (contract.status !== 'proposed') continue;
        const dependencies = contract.dependsOn
          .map((id) => this.repository().getContract(id, tenantId))
          .filter((item): item is AssignmentContract => !!item);
        if (
          dependencies.some(
            (item) =>
              ['failed', 'cancelled'].includes(item.status) || (item.status === 'delivered' && (item.delivery?.unfinished.length ?? 1) > 0),
          )
        ) {
          this.repository().updateContract(
            contract,
            {
              status: 'failed',
              delivery: {
                summary: '上游分工未成功交付',
                artifacts: [],
                evidence: contract.evidenceInputs,
                unfinished: ['上游分工未完成'],
                costUsd: 0,
                usageKnown: true,
              },
            },
            contract.revision,
          );
          continue;
        }
        if (dependencies.some((item) => item.status !== 'delivered' || (item.delivery?.unfinished.length ?? 1) > 0)) continue;
        const role = this.repository().getRole(contract.roleId, tenantId);
        if (!role || role.employment !== 'active') {
          this.repository().updateContract(contract, { status: 'failed' }, contract.revision);
          this.failSchedule(task, schedule, `社会角色不可用：${contract.roleId}`);
          break;
        }
        try {
          const run = this.runs.startSocietyAssignment({
            task,
            schedule,
            role,
            contract,
            assignment: schedule.assignments[index],
          });
          schedule.assignments[index] = { ...schedule.assignments[index], runId: run.id };
          schedule = this.repository().updateSocietySchedule(schedule, {
            runIds: [...new Set([...(schedule.runIds ?? []), run.id])],
            assignments: schedule.assignments,
          });
          this.watchRun(run.id, tenantId, schedule.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.repository().updateContract(contract, { status: 'failed' }, contract.revision);
          this.failSchedule(task, schedule, `启动分工失败：${reason}`);
          break;
        }
      }

      contracts = schedule.contractIds.map((id) => this.repository().getContract(id, tenantId)!);
      if (contracts.every((contract) => ['delivered', 'failed', 'cancelled'].includes(contract.status))) {
        return this.settleSchedule(schedule.id, tenantId);
      }
      return {
        task: this.repository().getSocietyTask(task.id, tenantId),
        schedule: this.repository().getSocietySchedule(schedule.id, tenantId),
      };
    } finally {
      this.advancing.delete(scheduleId);
    }
  }

  settleSchedule(scheduleId: string, tenantId: string): { task?: SocietyTask; schedule?: SocietySchedule } {
    const schedule = this.repository().getSocietySchedule(scheduleId, tenantId);
    if (!schedule || schedule.status !== 'active' || !schedule.workOrderId) return { schedule };
    const contracts = (schedule.contractIds ?? [])
      .map((id) => this.repository().getContract(id, tenantId))
      .filter((item): item is AssignmentContract => !!item);
    if (!contracts.length || contracts.some((contract) => ['proposed', 'active'].includes(contract.status))) return { schedule };
    const delivered = contracts.filter((contract) => contract.status === 'delivered' && (contract.delivery?.unfinished.length ?? 1) === 0);
    const completed = delivered.length === contracts.length;
    const task = this.repository().getSocietyTask(schedule.taskId, tenantId);
    if (!task) return { schedule };
    if (!completed) {
      this.failSchedule(task, schedule, '至少一个真实契约没有完成交付');
      return {
        task: this.repository().getSocietyTask(task.id, tenantId),
        schedule: this.repository().getSocietySchedule(schedule.id, tenantId),
      };
    }
    const evidence = contracts
      .flatMap((contract) => contract.delivery?.evidence ?? [])
      .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
    const now = this.now();
    this.repository().transaction(() => {
      this.repository().updateSocietySchedule(schedule, { status: 'completed', releasedAt: now });
      this.repository().updateSocietyTask(task, {
        status: 'awaiting_acceptance',
        lastSchedulingReason: '全部真实分工已交付，等待人类验收',
      });
      this.appendAudit(
        { ...task, status: 'awaiting_acceptance', scheduleId: schedule.id },
        'release_completed',
        '全部真实分工已交付，等待人类验收',
        {
          previousStatus: schedule.status,
          status: 'completed',
          runIds: schedule.runIds ?? [],
          roleIds: schedule.roleIds,
          artifacts: contracts.flatMap((contract) => contract.delivery?.artifacts ?? []),
          evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, ref: item.ref })),
          deliveredContracts: contracts.map((contract) => contract.id),
        },
        `release_completed:${schedule.id}`,
      );
      for (const contract of contracts)
        this.repository().appendRoleMemory({
          id: randomUUID(),
          tenantId,
          roleId: contract.roleId,
          kind: 'submission',
          summary: `提交待验收：${contract.delivery?.summary ?? contract.branchObjective}`.slice(0, 1000),
          scheduleId: schedule.id,
          workOrderId: schedule.workOrderId,
          evidence: contract.delivery?.evidence ?? [],
          createdAt: now,
        });
      // Completion alone does not prove good collaboration: record the event kind
      // without a fabricated high score; scoring stays evidence-driven.
    });
    this.emit('organization.society.released', {
      taskId: task.id,
      scheduleId: schedule.id,
      outcome: 'completed',
      workOrderId: schedule.workOrderId,
      runIds: schedule.runIds ?? [],
    });
    return {
      task: this.repository().getSocietyTask(task.id, tenantId),
      schedule: this.repository().getSocietySchedule(schedule.id, tenantId),
    };
  }

  releaseTask(
    taskId: string,
    tenantId: string,
    outcome: 'completed' | 'failed',
    summary: string,
  ): { task: SocietyTask; schedule: SocietySchedule } {
    let task = this.repository().getSocietyTask(taskId, tenantId);
    if (!task) throw new OrganizationError(404, 'SOCIETY_TASK_NOT_FOUND', '社会任务不存在');
    if (!task.scheduleId) throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '任务尚未建立调度');
    const schedule = this.repository().getSocietySchedule(task.scheduleId, tenantId);
    if (!schedule) throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '任务调度不存在');
    if (!schedule.workOrderId) throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '任务调度没有关联工作单');
    const reason = bounded(summary, 1000, '释放原因');
    const currentTask = task;
    if (outcome === 'completed') {
      if (task.status !== 'awaiting_acceptance' || schedule.status !== 'completed')
        throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '真实分工全部交付后才能完成人工验收');
      const contracts = (schedule.contractIds ?? [])
        .map((id) => this.repository().getContract(id, tenantId))
        .filter((item): item is AssignmentContract => !!item);
      if (
        !contracts.length ||
        contracts.some((contract) => contract.status !== 'delivered' || (contract.delivery?.unfinished.length ?? 1) > 0)
      )
        throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '分工交付事实不完整，不能标记完成');
      const now = this.now();
      const acceptanceEvidence = contracts
        .flatMap((contract) => contract.delivery?.evidence ?? [])
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
      this.repository().transaction(() => {
        this.organization.reviewWorkOrder(schedule.workOrderId!, tenantId, 'completed', reason);
        task = this.repository().updateSocietyTask(currentTask, {
          status: 'completed',
          lastSchedulingReason: `人类验收：${reason}`,
        });
        for (const contract of contracts)
          this.repository().appendRoleMemory({
            id: randomUUID(),
            tenantId,
            roleId: contract.roleId,
            kind: 'delivery',
            summary: `人工验收通过：${contract.delivery?.summary ?? contract.branchObjective}`.slice(0, 1000),
            scheduleId: schedule.id,
            workOrderId: schedule.workOrderId,
            evidence: contract.delivery?.evidence ?? [],
            createdAt: now,
          });
        // Human acceptance is a real review event between the delivered roles, so
        // it is the only place a positive relation score is justified.
        this.recordReviewedRelations(tenantId, schedule.roleIds, acceptanceEvidence, 1, now);
      });
    } else if (task.status === 'awaiting_acceptance') {
      const contracts = (schedule.contractIds ?? [])
        .map((id) => this.repository().getContract(id, tenantId))
        .filter((item): item is AssignmentContract => !!item);
      const now = this.now();
      this.repository().transaction(() => {
        this.organization.reviewWorkOrder(schedule.workOrderId!, tenantId, 'failed', reason);
        task = this.repository().updateSocietyTask(currentTask, {
          status: 'failed',
          lastSchedulingReason: `人类拒绝验收：${reason}`,
        });
        this.repository().updateSocietySchedule(schedule, {
          status: 'failed',
          reason: `人类拒绝验收：${reason}`.slice(0, 500),
          releasedAt: now,
        });
        for (const contract of contracts)
          this.repository().appendRoleMemory({
            id: randomUUID(),
            tenantId,
            roleId: contract.roleId,
            kind: 'failure',
            summary: `人工拒绝验收：${reason}`.slice(0, 1000),
            scheduleId: schedule.id,
            workOrderId: schedule.workOrderId,
            evidence: contract.delivery?.evidence ?? contract.evidenceInputs,
            createdAt: now,
          });
        // Human rejection is a real review event: record the negative review
        // outcome for the delivered roles, without inventing pairwise conflicts.
        this.recordReviewedRelations(
          tenantId,
          contracts.map((contract) => contract.roleId),
          contracts.flatMap((contract) => contract.delivery?.evidence ?? contract.evidenceInputs),
          0,
          now,
        );
      });
    } else if (schedule.status === 'active') {
      this.failSchedule(task, schedule, `人类终止：${reason}`, false);
      task = this.repository().getSocietyTask(task.id, tenantId)!;
    } else if (!['failed', 'cancelled'].includes(task.status)) {
      throw new OrganizationError(409, 'SOCIETY_TASK_STATE', '当前任务状态不能改为失败');
    }
    return {
      task,
      schedule: this.repository().getSocietySchedule(schedule.id, tenantId)!,
    };
  }

  snapshot(tenantId: string, projectId?: string): SocietySnapshot {
    return buildSocietySnapshot(
      {
        store: this.options.store,
        repository: () => this.repository(),
        organization: this.organization,
        selection: this.selection,
        ensureInstitution: (tenantId) => this.ensureInstitution(tenantId),
        departmentForRole: (role, departments) => this.departmentForRole(role, departments),
        runUsage: (schedule, tenantId) => this.runUsage(schedule, tenantId),
        departmentUsage: (schedules, tenantId, departments) => this.departmentUsage(schedules, tenantId, departments),
        assignmentDepartmentId: (schedule, assignment, departments) => this.assignmentDepartmentId(schedule, assignment, departments),
        contractDepartmentId: (schedule, contract, assignment, departments, task) =>
          this.contractDepartmentId(schedule, contract, assignment, departments, task),
      },
      tenantId,
      projectId,
    );
  }

  experiment(
    taskId: string,
    tenantId: string,
  ): {
    task: SocietyTask;
    estimate: SocietyEconomicsEstimate;
    selected: 'solo' | 'team' | 'queue';
    reason: string;
  } {
    return experimentDecision(this.experimentDeps(), taskId, tenantId);
  }

  createPairedExperiment(input: CreateSocietyTaskInput): {
    solo: SocietyTask;
    team: SocietyTask;
    experiment: SocietyPairedExperiment;
  } {
    return createPairedExperimentImpl(this.experimentDeps(), input);
  }

  pairedExperiment(experimentId: string, tenantId: string): SocietyPairedExperiment {
    return pairedExperimentImpl(this.experimentDeps(), experimentId, tenantId);
  }

  measurePairedExperiment(experimentId: string, tenantId: string): SocietyPairedExperiment {
    return measurePairedExperimentImpl(this.experimentDeps(), experimentId, tenantId);
  }

  private experimentDeps() {
    return {
      store: this.options.store,
      repository: () => this.repository(),
      selection: this.selection,
      ensureInstitution: (tenantId: string) => this.ensureInstitution(tenantId),
      estimate: (task: SocietyTask) => this.estimate(task),
      createTask: (input: CreateSocietyTaskInput) => this.createTask(input),
      teamCostEligible: (objective: string, estimate: SocietyEconomicsEstimate) => this.teamCostEligible(objective, estimate),
      now: () => this.now(),
      emit: (type: string, data: Record<string, unknown>) => this.emit(type, data),
    };
  }

  roleLife(tenantId: string, roleId: string): SocietySnapshot['roleLife'][number] {
    const role = this.repository().getRole(roleId, tenantId);
    if (!role) throw new OrganizationError(404, 'ROLE_NOT_FOUND', '角色不存在');
    const organization = this.organization;
    return {
      roleId,
      versions: this.repository().organizationVersions('role', tenantId, roleId),
      versionAudits: this.repository().organizationVersionAudits('role', tenantId, roleId),
      memories: this.repository().roleMemories(tenantId, roleId),
      relations: this.repository().roleRelations(tenantId, roleId),
      scorecard: organization.scorecards(tenantId).find((item) => item.roleId === roleId),
      wellbeing: organization.wellbeing(tenantId).find((item) => item.roleId === roleId),
    };
  }
}
