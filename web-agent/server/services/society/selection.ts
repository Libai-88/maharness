import {
  OrganizationError,
  type InstitutionVersion,
  type OrganizationRepository,
  type OrganizationRole,
  type RoleSelectionScore,
  type SocietyDepartmentPolicy,
  type SocietyTask,
} from '../../organization-store';
import type { OrganizationService } from '../organization/service';
import { CAPABILITY_ALIASES, CAPABILITY_TOOL_HINTS, ROLE_SELECTION_WEIGHTS } from './policy';

function activeScheduleRoleIds(schedules: ReturnType<OrganizationRepository['societySchedules']>): string[] {
  return schedules.filter((item) => item.status === 'active').flatMap((item) => item.roleIds);
}

/** Pure-ish selection layer: deterministic six-factor scoring over persisted organization facts. */
export class SocietySelectionService {
  constructor(
    private readonly repo: OrganizationRepository,
    private readonly organization: OrganizationService,
  ) {}

  departmentForRole(role: OrganizationRole, departments: SocietyDepartmentPolicy[]): SocietyDepartmentPolicy | undefined {
    const capabilities = new Set(role.capabilities);
    return departments
      .filter((item) => item.enabled)
      .map((department) => ({
        department,
        fit: department.capabilities.filter((capability) => capabilities.has(capability)).length,
      }))
      .filter((item) => item.fit > 0)
      .sort((left, right) => right.fit - left.fit || left.department.priority - right.department.priority)[0]?.department;
  }

  departmentForText(text: string, departments: SocietyDepartmentPolicy[]): SocietyDepartmentPolicy {
    const enabled = departments.filter((item) => item.enabled).sort((left, right) => left.priority - right.priority);
    if (!enabled.length) throw new OrganizationError(409, 'DEPARTMENT_NOT_FOUND', '没有可用部门');
    const lowered = text.toLowerCase();
    return (
      enabled.find((department) =>
        department.capabilities.some(
          (capability) =>
            lowered.includes(capability.toLowerCase()) ||
            (CAPABILITY_ALIASES[capability] ?? []).some((alias) => lowered.includes(alias.toLowerCase())),
        ),
      ) ?? enabled[0]
    );
  }

  roleDepartment(role: OrganizationRole, departmentId: string, departments: SocietyDepartmentPolicy[]): boolean {
    return this.departmentForRole(role, departments)?.id === departmentId;
  }

  eligibleRoles(task: SocietyTask, institution: InstitutionVersion): OrganizationRole[] {
    const departments = institution.policies.departments;
    const departmentIds = [...new Set(task.branches.map((branch) => branch.departmentId ?? task.departmentId ?? ''))];
    return this.repo
      .listRoles(task.tenantId, undefined, true)
      .filter((role) => role.employment === 'active' && (role.projectId === '' || role.projectId === task.projectId))
      .filter((role) => departmentIds.some((id) => this.roleDepartment(role, id, departments)));
  }

  requiredCapabilities(task: SocietyTask, institution: InstitutionVersion): string[] {
    // Explicit capability declarations always win; keyword inference exists only
    // for tasks created before provenance was recorded.
    if (task.capabilitySource === 'explicit' && task.requiredCapabilities?.length) {
      return task.requiredCapabilities.slice(0, 8);
    }
    if (task.requiredCapabilities?.length) return task.requiredCapabilities.slice(0, 8);
    const departmentIds = new Set(task.branches.map((branch) => branch.departmentId ?? task.departmentId ?? '').filter(Boolean));
    const departmentCapabilities = institution.policies.departments
      .filter((department) => departmentIds.has(department.id))
      .flatMap((department) => department.capabilities);
    const text = [
      task.objective,
      ...task.acceptance,
      ...task.branches.flatMap((branch) => [branch.objective, ...branch.acceptance, ...branch.expectedArtifacts]),
    ]
      .join(' ')
      .toLowerCase();
    const matched = Object.entries(CAPABILITY_ALIASES)
      .filter(
        ([capability, aliases]) => text.includes(capability.toLowerCase()) || aliases.some((alias) => text.includes(alias.toLowerCase())),
      )
      .map(([capability]) => capability);
    return [...new Set(matched.length ? matched : departmentCapabilities)].slice(0, 8);
  }

  taskNeedsWrite(task: SocietyTask): boolean {
    if (task.needsWrite !== undefined) return task.needsWrite;
    if (task.capabilitySource === 'explicit') return false;
    const text = [
      task.objective,
      ...task.acceptance,
      ...task.branches.flatMap((branch) => [branch.objective, ...branch.expectedArtifacts, ...branch.acceptance]),
    ]
      .join(' ')
      .toLowerCase();
    return (
      task.branches.some((branch) => branch.expectedArtifacts.length > 0) ||
      /创建|生成|修改|导出|写入|整理|制作|转换|保存|create|generate|edit|write|export|convert|save/.test(text)
    );
  }

  rankRoles(
    task: SocietyTask,
    institution: InstitutionVersion,
  ): {
    requiredCapabilities: string[];
    candidates: RoleSelectionScore[];
  } {
    const activeRoles = activeScheduleRoleIds(this.repo.societySchedules(task.tenantId, 1000));
    const scorecards = this.organization.scorecards(task.tenantId);
    const evaluation = this.organization.ensureEvaluation(task.tenantId);
    const evaluationWeights = evaluation.record.rankingWeights;
    const selectionWeights = institution.policies.roleSelectionWeights ?? ROLE_SELECTION_WEIGHTS;
    const relations = this.repo.roleRelations(task.tenantId);
    const requiredCapabilities = this.requiredCapabilities(task, institution);
    const needsWrite = this.taskNeedsWrite(task);
    const candidates = this.eligibleRoles(task, institution)
      .map((role) => {
        const capabilityFit = requiredCapabilities.length
          ? requiredCapabilities.filter((capability) => role.capabilities.includes(capability)).length / requiredCapabilities.length
          : 0.5;
        const memories = this.repo.roleMemories(task.tenantId, role.id, 20);
        const memoryHits = requiredCapabilities.filter((capability) => {
          const terms = [capability, ...(CAPABILITY_ALIASES[capability] ?? [])];
          return memories.some((memory) => terms.some((term) => memory.summary.toLowerCase().includes(term.toLowerCase())));
        }).length;
        const memoryRelevance = requiredCapabilities.length ? memoryHits / requiredCapabilities.length : 0;
        const allowedTools = role.authority.allowedTools.map((tool) => tool.toLowerCase());
        const toolHints = [...new Set(requiredCapabilities.flatMap((capability) => CAPABILITY_TOOL_HINTS[capability] ?? []))];
        const toolReadiness =
          allowedTools.length === 0
            ? 1
            : toolHints.length === 0
              ? 0.5
              : toolHints.filter((hint) => allowedTools.some((tool) => tool.includes(hint))).length / toolHints.length;
        const roleRelations = relations.filter((relation) => relation.fromRoleId === role.id || relation.toRoleId === role.id);
        const collaborationHealth = roleRelations.length
          ? roleRelations.reduce((sum, relation) => sum + relation.score, 0) / roleRelations.length
          : 0.5;
        const scorecard = scorecards.find((item) => item.roleId === role.id);
        const historyReliability =
          scorecard && scorecard.sampleSize >= evaluation.record.lowConfidenceSamples
            ? (scorecard.acceptanceRate ?? 0) * evaluationWeights.acceptance +
              (scorecard.budgetCompliance ?? 0) * evaluationWeights.budget +
              (scorecard.evidenceCompleteness ?? 0) * evaluationWeights.evidence
            : 0.5;
        const activeAssignments = activeRoles.filter((id) => id === role.id).length;
        const loadBalance = Math.max(0, 1 - activeAssignments / Math.max(1, institution.policies.welfareMaxActiveAssignments));
        const score =
          capabilityFit * selectionWeights.capability +
          memoryRelevance * selectionWeights.memory +
          toolReadiness * selectionWeights.tools +
          collaborationHealth * selectionWeights.collaboration +
          historyReliability * selectionWeights.history +
          loadBalance * selectionWeights.load;
        const blockedReason =
          needsWrite && role.authority.readOnly
            ? '角色只读权限不覆盖写入任务'
            : toolReadiness === 0
              ? '角色工具权限不覆盖任务能力'
              : undefined;
        return {
          roleId: role.id,
          score: Math.round(score * 1000) / 1000,
          capabilityFit: Math.round(capabilityFit * 1000) / 1000,
          memoryRelevance: Math.round(memoryRelevance * 1000) / 1000,
          toolReadiness: Math.round(toolReadiness * 1000) / 1000,
          collaborationHealth: Math.round(collaborationHealth * 1000) / 1000,
          historyReliability: Math.round(historyReliability * 1000) / 1000,
          loadBalance: Math.round(loadBalance * 1000) / 1000,
          activeAssignments,
          eligible: !blockedReason,
          reason: `能力=${capabilityFit.toFixed(2)} 记忆=${memoryRelevance.toFixed(2)} 工具=${toolReadiness.toFixed(2)} 协作=${collaborationHealth.toFixed(2)} 履历=${historyReliability.toFixed(2)} 负载=${loadBalance.toFixed(2)}`,
          ...(blockedReason ? { blockedReason } : {}),
        };
      })
      .sort(
        (left, right) =>
          Number(right.eligible) - Number(left.eligible) ||
          right.score - left.score ||
          left.activeAssignments - right.activeAssignments ||
          left.roleId.localeCompare(right.roleId),
      );
    return { requiredCapabilities, candidates };
  }

  rankedRoles(task: SocietyTask, institution: InstitutionVersion, exclude: Set<string> = new Set()): OrganizationRole[] {
    const eligible = this.eligibleRoles(task, institution).filter((role) => !exclude.has(role.id));
    const eligibleIds = new Set(eligible.map((role) => role.id));
    return this.rankRoles(task, institution)
      .candidates.filter((score) => score.eligible && eligibleIds.has(score.roleId))
      .map((score) => eligible.find((role) => role.id === score.roleId)!);
  }
}
