import type { RunRecord } from '../../../kernel/run';
import type { Store } from '../../db';
import type { OrganizationService } from '../organization/service';
import type { SocietySelectionService } from './selection';
import { buildSocialObservations } from './health';
import type {
  AssignmentContract,
  InstitutionVersion,
  OrganizationRole,
  SocietyDepartmentPolicy,
  SocietySchedule,
  SocietyScheduleAssignment,
  SocietySnapshot,
  SocietyTask,
} from '../../organization-store';

export interface RunUsage {
  runs: RunRecord[];
  costUsd: number;
  tokens: number;
  cachedInputTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  usageKnown: boolean;
  cacheUsageKnown: boolean;
  cacheWriteKnown: boolean;
}

export interface DepartmentUsage {
  activeAssignments: number;
  reservedUsd: number;
  reservedTokens: number;
  spentUsd: number;
  spentTokens: number;
}

/**
 * Read-only snapshot projection.
 *
 * Deliberately separated from the scheduler: the snapshot only reads durable
 * facts and never advances a task, so it can be rebuilt for the UI without
 * touching state transitions.
 */
export interface SnapshotDeps {
  store: Store;
  repository(): Store['organization'];
  organization: OrganizationService;
  selection: SocietySelectionService;
  ensureInstitution(tenantId: string): InstitutionVersion;
  departmentForRole(role: OrganizationRole, departments: SocietyDepartmentPolicy[]): SocietyDepartmentPolicy | undefined;
  runUsage(schedule: SocietySchedule, tenantId: string): RunUsage;
  departmentUsage(schedules: SocietySchedule[], tenantId: string, departments: SocietyDepartmentPolicy[]): Map<string, DepartmentUsage>;
  assignmentDepartmentId(schedule: SocietySchedule, assignment: SocietyScheduleAssignment, departments: SocietyDepartmentPolicy[]): string;
  contractDepartmentId(
    schedule: SocietySchedule,
    contract: AssignmentContract,
    assignment: SocietyScheduleAssignment | undefined,
    departments: SocietyDepartmentPolicy[],
    task: SocietyTask | undefined,
  ): string;
}

export function buildSocietySnapshot(deps: SnapshotDeps, tenantId: string, projectId?: string): SocietySnapshot {
  const repo = deps.repository();
  const institution = deps.ensureInstitution(tenantId);
  const tasks = repo.societyTasks(tenantId, projectId, 1000);
  const schedules = repo.societySchedules(tenantId, 1000);
  const roles = repo.listRoles(tenantId, undefined, true)
    .filter(role => !projectId || role.projectId === '' || role.projectId === projectId);
  const relations = repo.roleRelations(tenantId);
  const organization = deps.organization;
  const scorecards = organization.scorecards(tenantId);
  const wellbeing = organization.wellbeing(tenantId, projectId);
  const evaluation = organization.evaluationHistory(tenantId);
  const active = schedules.filter(schedule => schedule.status === 'active');
  const usageBySchedule = new Map(schedules.map(schedule => [schedule.id, deps.runUsage(schedule, tenantId)]));
  const departmentUsage = deps.departmentUsage(schedules, tenantId, institution.policies.departments);
  const roleLoads = new Map<string, number>();
  for (const schedule of active) for (const roleId of schedule.roleIds)
    roleLoads.set(roleId, (roleLoads.get(roleId) ?? 0) + 1);
  const departments = institution.policies.departments.map(department => {
    const usage = departmentUsage.get(department.id);
    const reservedUsd = usage?.reservedUsd ?? 0;
    const spentUsd = usage?.spentUsd ?? 0;
    const reservedTokens = usage?.reservedTokens ?? 0;
    const spentTokens = usage?.spentTokens ?? 0;
    return {
      ...department,
      queued: tasks.filter(task => task.departmentId === department.id && task.status === 'queued').length,
      active: usage?.activeAssignments ?? 0,
      reservedUsd,
      spentUsd,
      quotaRemainingUsd: Math.max(0, department.quotaUsd - reservedUsd - spentUsd),
      reservedTokens,
      spentTokens,
      quotaRemainingTokens: Math.max(0, department.quotaTokens - reservedTokens - spentTokens),
      roleIds: roles.filter(role => deps.selection.roleDepartment(role, department.id, institution.policies.departments)).map(role => role.id),
    };
  });
  const societyReservedUsd = [...departmentUsage.values()]
    .reduce((sum, usage) => sum + usage.reservedUsd, 0);
  const societySpentUsd = [...departmentUsage.values()]
    .reduce((sum, usage) => sum + usage.spentUsd, 0);
  const societyReservedTokens = [...departmentUsage.values()]
    .reduce((sum, usage) => sum + usage.reservedTokens, 0);
  const societySpentTokens = [...departmentUsage.values()]
    .reduce((sum, usage) => sum + usage.spentTokens, 0);
  const sharedRefs = tasks.flatMap(task => task.materials.map(material => `${material.id}:${material.version}`));
  const reusedRefs = [...new Set(sharedRefs)].filter(ref => sharedRefs.filter(item => item === ref).length > 1).length;
  const loads = roles.map(role => roleLoads.get(role.id) ?? 0);
  const meanLoad = loads.length ? loads.reduce((sum, load) => sum + load, 0) / loads.length : 0;
  const variance = loads.length ? loads.reduce((sum, load) => sum + (load - meanLoad) ** 2, 0) / loads.length : 0;
  const loadBalance = loads.length ? Math.max(0, 1 - Math.sqrt(variance) / Math.max(1, meanLoad)) : null;
  const welfare = roles.length
    ? roles.reduce((sum, role) => sum + Math.max(0, 1 - (roleLoads.get(role.id) ?? 0) / institution.policies.welfareMaxActiveAssignments), 0) / roles.length
    : null;
  const unresolved = repo.exceptions(tenantId).filter(item => !['resolved', 'dismissed', 'auto_resolved'].includes(item.status));
  const budgetUtilization = institution.policies.societyBudgetUsd > 0
    ? Math.min(1, (societyReservedUsd + societySpentUsd) / institution.policies.societyBudgetUsd) : 1;
  const collaborationHealth = relations.length
    ? relations.reduce((sum, relation) => sum + relation.score, 0) / relations.length : null;
  const observations = buildSocialObservations({
    loadBalance,
    welfare,
    exceptionHealth: unresolved.length ? Math.max(0, 1 - unresolved.length / 10) : 1,
    budgetUtilization,
    collaborationHealth,
    sampleSize: relations.length,
    roleCount: roles.length,
    unresolvedExceptions: unresolved.length,
    reservedUsd: societyReservedUsd,
    spentUsd: societySpentUsd,
    budgetUsd: institution.policies.societyBudgetUsd,
  });
  const bottlenecks: SocietySnapshot['bottlenecks'] = [];
  for (const department of departments) {
    if (department.queued > department.maxConcurrent * 2)
      bottlenecks.push({ departmentId: department.id, kind: 'queue', count: department.queued, detail: '排队任务超过并发容量的两倍' });
    if (department.active >= department.maxConcurrent)
      bottlenecks.push({ departmentId: department.id, kind: 'load', count: department.active, detail: '部门并发容量已满' });
    if (department.quotaRemainingUsd <= department.quotaUsd * 0.2)
      bottlenecks.push({ departmentId: department.id, kind: 'budget', count: 1, detail: '部门可用配额低于 20%' });
  }
  for (const role of roles) {
    if ((roleLoads.get(role.id) ?? 0) >= institution.policies.welfareMaxActiveAssignments)
      bottlenecks.push({ departmentId: deps.departmentForRole(role, institution.policies.departments)?.id ?? '', kind: 'welfare', count: roleLoads.get(role.id) ?? 0, detail: `${role.name} 已达到福利负载上限` });
  }
  const allSocietyRuns = [...new Map(schedules.flatMap(schedule => usageBySchedule.get(schedule.id)?.runs ?? [])
    .map(run => [run.id, run])).values()];
  let duplicateEvidenceReads = 0;
  const readSignatures = new Map<string, number>();
  for (const run of allSocietyRuns) for (const call of deps.store.runs.toolCalls(run.id)) {
    if (call.sideEffect !== 'read' || !['succeeded', 'failed', 'unknown'].includes(call.status)) continue;
    const signature = `${call.name}\0${call.argsSummary}`;
    const seen = readSignatures.get(signature) ?? 0;
    if (seen) duplicateEvidenceReads++;
    readSignatures.set(signature, seen + 1);
  }
  const roleBudgets = roles.map(role => {
    const runs = schedules.flatMap(schedule => {
      const contracts = (schedule.contractIds ?? [])
        .map(id => repo.getContract(id, tenantId))
        .filter((contract): contract is AssignmentContract => contract?.roleId === role.id && !!contract.runId);
      return contracts.flatMap(contract => {
        const run = deps.store.runs.get(contract.runId!, tenantId);
        return run ? [run] : [];
      });
    });
    return {
      roleId: role.id,
      budgetLimitUsd: role.budgetLimitUsd,
      budgetLimitTokens: role.budgetLimitTokens,
      costUsd: runs.reduce((sum, run) => sum + run.cost, 0),
      tokens: runs.reduce((sum, run) => sum + run.tokensIn + run.tokensOut, 0),
      cachedInputTokens: runs.reduce((sum, run) => sum + (run.tokensCached ?? 0), 0),
      activeAssignments: roleLoads.get(role.id) ?? 0,
    };
  });
  const cacheUsageKnown = allSocietyRuns.length > 0 && allSocietyRuns.every(run =>
    run.usageStatus === 'reported'
    && run.tokensCached !== undefined
    && run.tokensCacheMiss !== undefined);
  const cachedInputTokens = cacheUsageKnown
    ? allSocietyRuns.reduce((sum, run) => sum + (run.tokensCached ?? 0), 0) : 0;
  const cacheMissTokens = cacheUsageKnown
    ? allSocietyRuns.reduce((sum, run) => sum + (run.tokensCacheMiss ?? 0), 0) : 0;
  const cacheWriteUsageKnown = schedules.length > 0
    && schedules.every(schedule => usageBySchedule.get(schedule.id)!.cacheWriteKnown);
  const cacheWriteTokens = cacheWriteUsageKnown
    ? allSocietyRuns.reduce((sum, run) => sum + (run.cacheWriteTokens ?? 0), 0) : 0;
  return {
    schemaVersion: 1, institution, departments, roles,
    roleLife: roles.map(role => ({
      roleId: role.id,
      versions: repo.organizationVersions('role', tenantId, role.id, 50),
      versionAudits: repo.organizationVersionAudits('role', tenantId, role.id, 50),
      memories: repo.roleMemories(tenantId, role.id, 50),
      relations: relations.filter(relation => relation.fromRoleId === role.id || relation.toRoleId === role.id),
      scorecard: scorecards.find(item => item.roleId === role.id),
      wellbeing: wellbeing.find(item => item.roleId === role.id),
    })),
    tasks, schedules,
    audits: repo.societyAudits(tenantId),
    institutionAudits: repo.institutionAudits(tenantId),
    evaluation: evaluation.active,
    evaluationAudits: evaluation.audits,
    network: {
      nodes: roles.map(role => ({
        roleId: role.id,
        departmentId: deps.departmentForRole(role, institution.policies.departments)?.id,
        load: roleLoads.get(role.id) ?? 0,
      })),
      edges: relations,
    },
    bottlenecks, observations,
    economics: {
      societyBudgetUsd: institution.policies.societyBudgetUsd,
      societyTokenBudget: institution.policies.societyTokenBudget,
      societyReservedUsd, societySpentUsd,
      societyReservedTokens, societySpentTokens,
      departmentBudgets: departments.map(department => ({
        departmentId: department.id, quotaUsd: department.quotaUsd,
        reservedUsd: department.reservedUsd, spentUsd: department.spentUsd,
        remainingUsd: department.quotaRemainingUsd,
        quotaTokens: department.quotaTokens, reservedTokens: department.reservedTokens,
        spentTokens: department.spentTokens, remainingTokens: department.quotaRemainingTokens,
      })),
      roleBudgets,
      taskLedger: tasks.map(task => {
        const taskSchedules = schedules.filter(schedule => schedule.taskId === task.id);
        const taskCacheUsageKnown = taskSchedules.length > 0
          && taskSchedules.every(schedule => usageBySchedule.get(schedule.id)!.cacheUsageKnown);
        const taskCacheWriteKnown = taskSchedules.length > 0
          && taskSchedules.every(schedule => usageBySchedule.get(schedule.id)!.cacheWriteKnown);
        return {
          taskId: task.id, maxBudgetUsd: task.maxBudgetUsd, maxBudgetTokens: task.maxBudgetTokens,
          estimatedCostUsd: taskSchedules[0]?.estimates.teamCostUsd ?? 0,
          estimatedTokens: taskSchedules[0]?.estimates.teamTokens ?? 0,
          actualCostUsd: taskSchedules.reduce((sum, schedule) => sum + usageBySchedule.get(schedule.id)!.costUsd, 0),
          actualTokens: taskSchedules.reduce((sum, schedule) => sum + usageBySchedule.get(schedule.id)!.tokens, 0),
          cachedInputTokens: taskCacheUsageKnown
            ? taskSchedules.reduce((sum, schedule) => sum + usageBySchedule.get(schedule.id)!.cachedInputTokens, 0)
            : 0,
          cacheMissInputTokens: taskCacheUsageKnown
            ? taskSchedules.reduce((sum, schedule) => sum + usageBySchedule.get(schedule.id)!.cacheMissTokens, 0)
            : 0,
          cacheWriteTokens: taskCacheWriteKnown
            ? taskSchedules.reduce((sum, schedule) => sum + usageBySchedule.get(schedule.id)!.cacheWriteTokens, 0)
            : 0,
          cacheUsageStatus: taskCacheUsageKnown ? 'known' as const : 'unknown' as const,
          cacheWriteUsageStatus: taskCacheWriteKnown ? 'known' as const : 'unknown' as const,
          valueUsd: task.valueUsd, status: task.status,
        };
      }),
      cachedInputTokens,
      cacheMissInputTokens: cacheMissTokens,
      cacheWriteTokens,
      cacheSavingsUsd: null,
      cacheHitRate: cacheUsageKnown && cachedInputTokens + cacheMissTokens > 0
        ? cachedInputTokens / (cachedInputTokens + cacheMissTokens) : null,
      cacheUsageStatus: cacheUsageKnown ? 'known' : 'unknown',
      cacheWriteUsageStatus: cacheWriteUsageKnown ? 'known' : 'unknown',
      duplicateEvidenceReads,
      compression: {
        sharedMemoryRefs: new Set(sharedRefs).size,
        reusedRefs,
        officialTokenCount: allSocietyRuns.reduce((sum, run) => sum + run.tokensIn + run.tokensOut, 0),
      },
    },
    scheduling: {
      decisions: schedules,
      queue: tasks.filter(task => task.status === 'queued'),
      waitingApproval: tasks.filter(task => task.status === 'waiting_approval'),
      activeTeams: active.filter(schedule => schedule.mode === 'team'),
    },
  };
}
