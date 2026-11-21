import { randomUUID } from 'node:crypto';
import { RUN_TERMINAL, type RunRecord } from '../../../kernel/run';
import type { Store } from '../../db';
import {
  OrganizationError,
  type AssignmentContract,
  type InstitutionVersion,
  type SocietyExperimentMeasurement,
  type SocietyPairedExperiment,
  type SocietyTask,
} from '../../organization-store';
import type { SocietySelectionService } from './selection';
import { bounded } from './policy';
import type { CreateSocietyTaskInput, SocietyEconomicsEstimate } from './types';

/**
 * Paired solo/team net-benefit experiments.
 *
 * Kept out of the scheduler so the experiment lifecycle (create → measure →
 * persist) can be read without walking the tick state machine.
 */
export interface ExperimentDeps {
  store: Store;
  repository(): Store['organization'];
  selection: SocietySelectionService;
  ensureInstitution(tenantId: string): InstitutionVersion;
  estimate(task: SocietyTask): SocietyEconomicsEstimate;
  createTask(input: CreateSocietyTaskInput): SocietyTask;
  teamCostEligible(objective: string, estimate: SocietyEconomicsEstimate): boolean;
  now(): number;
  emit(type: string, data: Record<string, unknown>): void;
}

export function experimentDecision(
  deps: ExperimentDeps,
  taskId: string,
  tenantId: string,
): { task: SocietyTask; estimate: SocietyEconomicsEstimate; selected: 'solo' | 'team' | 'queue'; reason: string } {
  const task = deps.repository().getSocietyTask(taskId, tenantId);
  if (!task) throw new OrganizationError(404, 'SOCIETY_TASK_NOT_FOUND', '社会任务不存在');
  const institution = deps.ensureInstitution(tenantId);
  const estimate = deps.estimate(task);
  const team = task.branches.length >= 2
    && deps.teamCostEligible(task.objective, estimate)
    && estimate.marginalNetBenefitUsd >= institution.policies.minNetBenefitUsd
    && estimate.team.netBenefitUsd > 0;
  const selected = team ? 'team' : estimate.single.netBenefitUsd > institution.policies.minNetBenefitUsd ? 'solo' : 'queue';
  return {
    task, estimate, selected,
    reason: selected === 'team' ? '团队净收益超过单角色并满足独立分支门槛'
      : selected === 'solo' ? '团队净收益不足，保持单角色执行'
        : '两种方案净收益均不足，排队或等待人类重新估价',
  };
}

export function createPairedExperiment(
  deps: ExperimentDeps,
  input: CreateSocietyTaskInput,
): { solo: SocietyTask; team: SocietyTask; experiment: SocietyPairedExperiment } {
  if (!input.branches || input.branches.length < 2)
    throw new OrganizationError(400, 'SOCIETY_EXPERIMENT_INVALID', '配对实验至少需要两个独立团队分支');
  const institution = deps.ensureInstitution(input.tenantId);
  const objective = bounded(input.objective, 2000, '任务目标');
  const departmentId = input.departmentId
    ?? deps.selection.departmentForText(objective, institution.policies.departments).id;
  const plannedArtifacts = [...new Set(input.branches.flatMap(branch => branch.expectedArtifacts ?? []))];
  const acceptance = [...new Set([
    ...(input.acceptance ?? []),
    ...input.branches.flatMap(branch => branch.acceptance ?? []),
  ])];
  let solo: SocietyTask | undefined;
  try {
    solo = deps.createTask({
      ...input,
      departmentId,
      branches: [{
        objective,
        acceptance,
        expectedArtifacts: plannedArtifacts,
        departmentId,
      }],
      economics: undefined,
      evidenceExperimentId: undefined,
    });
    const team = deps.createTask(input);
    const now = deps.now();
    const experiment: SocietyPairedExperiment = {
      id: randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId ?? '',
      objective,
      valueUsd: solo.valueUsd,
      status: 'running',
      soloTaskId: solo.id,
      teamTaskId: team.id,
      formula: 'net = value * completion * (1 - artifactRisk) + latencyBenefit - actualCost; unmeasured latencyBenefit stays zero',
      reason: '等待单角色与团队两条真实 Run 结束',
      createdAt: now,
      updatedAt: now,
    };
    deps.repository().transaction(() => {
      deps.repository().updateSocietyTask(solo!, {
        experiment: {
          id: experiment.id, variant: 'solo', peerTaskId: team.id,
          snapshot: structuredClone(experiment),
        },
      });
      deps.repository().updateSocietyTask(team, {
        experiment: {
          id: experiment.id, variant: 'team', peerTaskId: solo!.id,
          snapshot: structuredClone(experiment),
        },
      });
    });
    deps.emit('organization.society.experiment.updated', {
      experimentId: experiment.id, status: experiment.status,
      soloTaskId: solo.id, teamTaskId: team.id,
    });
    return {
      solo: deps.repository().getSocietyTask(solo.id, input.tenantId)!,
      team: deps.repository().getSocietyTask(team.id, input.tenantId)!,
      experiment,
    };
  } catch (error) {
    if (solo) deps.repository().updateSocietyTask(solo, {
      status: 'cancelled', lastSchedulingReason: '配对实验创建失败',
    });
    throw error;
  }
}

export function pairedExperiment(
  deps: ExperimentDeps,
  experimentId: string,
  tenantId: string,
): SocietyPairedExperiment {
  const matching = deps.repository().societyTasks(tenantId, undefined, 1000)
    .filter(task => task.experiment?.id === experimentId);
  if (matching.length !== 2)
    throw new OrganizationError(404, 'SOCIETY_EXPERIMENT_NOT_FOUND', '配对净收益实验不存在');
  return structuredClone(matching[0]!.experiment!.snapshot);
}

export function measurePairedExperiment(
  deps: ExperimentDeps,
  experimentId: string,
  tenantId: string,
): SocietyPairedExperiment {
  const matching = deps.repository().societyTasks(tenantId, undefined, 1000)
    .filter(task => task.experiment?.id === experimentId);
  const solo = matching.find(task => task.experiment?.variant === 'solo');
  const team = matching.find(task => task.experiment?.variant === 'team');
  if (!solo || !team)
    throw new OrganizationError(404, 'SOCIETY_EXPERIMENT_NOT_FOUND', '配对净收益实验不存在');
  const soloMeasurement = experimentMeasurement(deps, solo);
  const teamMeasurement = experimentMeasurement(deps, team);
  const terminal = [soloMeasurement, teamMeasurement]
    .every(item => ['awaiting_acceptance', 'completed', 'failed', 'cancelled'].includes(item.status));
  if (!terminal) {
    const reason = '单角色或团队 Run 尚未结束';
    const running: SocietyPairedExperiment = {
      ...solo.experiment!.snapshot,
      status: 'running', reason, updatedAt: deps.now(),
    };
    persistExperiment(deps, solo, team, running);
    return structuredClone(running);
  }
  const usageKnown = soloMeasurement.usageKnown && teamMeasurement.usageKnown;
  const net = (measurement: SocietyExperimentMeasurement): number =>
    Math.round((solo.valueUsd * measurement.quality * (1 - measurement.risk) - measurement.costUsd) * 1e6) / 1e6;
  const soloNet = net(soloMeasurement);
  const teamNet = net(teamMeasurement);
  const measured: SocietyPairedExperiment = {
    ...solo.experiment!.snapshot,
    status: usageKnown ? 'measured' : 'inconclusive',
    measurements: {
      solo: soloMeasurement,
      team: {
        ...teamMeasurement,
        coordinationCostUsd: Math.max(0, Math.round((teamMeasurement.costUsd - soloMeasurement.costUsd) * 1e6) / 1e6),
        coordinationTokens: Math.max(0, teamMeasurement.tokens - soloMeasurement.tokens),
      },
    },
    netBenefitUsd: {
      solo: soloNet,
      team: teamNet,
      marginal: Math.round((teamNet - soloNet) * 1e6) / 1e6,
    },
    reason: usageKnown
      ? '两条真实 Run 的验收、产物、成本、耗时与风险事实均已记录'
      : '两条真实 Run 已结束，但 Provider usage 不完整，净收益只能标记为不确定',
    updatedAt: deps.now(),
  };
  persistExperiment(deps, solo, team, measured);
  deps.emit('organization.society.experiment.updated', {
    experimentId: measured.id,
    status: measured.status,
    marginalNetBenefitUsd: measured.netBenefitUsd?.marginal,
  });
  return structuredClone(measured);
}

export function experimentMeasurement(deps: ExperimentDeps, task: SocietyTask): SocietyExperimentMeasurement {
  const repo = deps.repository();
  const schedule = task.scheduleId
    ? repo.getSocietySchedule(task.scheduleId, task.tenantId)
    : repo.societySchedules(task.tenantId, 1000).find(item => item.taskId === task.id);
  if (!schedule) {
    return {
      taskId: task.id, runIds: [], status: task.status, completed: false,
      quality: 0, artifactCoverage: 0, latencyMs: 0, risk: 1,
      costUsd: 0, tokens: 0, coordinationCostUsd: 0, coordinationTokens: 0,
      usageKnown: false,
    };
  }
  const contracts = (schedule.contractIds ?? [])
    .map(id => repo.getContract(id, task.tenantId))
    .filter((contract): contract is AssignmentContract => !!contract);
  const runIds = [...new Set([
    ...(schedule.runIds ?? []),
    ...contracts.flatMap(contract => contract.runId ? [contract.runId] : []),
  ])];
  const runs = runIds
    .map(runId => deps.store.runs.get(runId, task.tenantId))
    .filter((run): run is RunRecord => !!run);
  const terminal = runs.length > 0 && runs.every(run => RUN_TERMINAL.has(run.status));
  if (!terminal || ['queued', 'waiting_approval', 'scheduled'].includes(task.status)) {
    return {
      taskId: task.id, scheduleId: schedule.id, runIds, status: task.status, completed: false,
      quality: 0, artifactCoverage: 0, latencyMs: 0, risk: 1,
      costUsd: 0, tokens: 0, coordinationCostUsd: 0, coordinationTokens: 0,
      usageKnown: false,
    };
  }
  const completed = ['awaiting_acceptance', 'completed'].includes(task.status);
  const completion = contracts.length
    ? contracts.filter(contract => contract.status === 'delivered').length / contracts.length
    : completed ? 1 : 0;
  const expected = [...new Set(task.branches.flatMap(branch => branch.expectedArtifacts))];
  const artifacts = runs.flatMap(run => deps.store.runs.artifacts(run.id).map(item => item.ref.replace(/\\/g, '/').toLowerCase()));
  const artifactCoverage = expected.length
    ? expected.filter(ref => {
      const normalized = ref.replace(/\\/g, '/').toLowerCase();
      return artifacts.some(artifact => artifact.includes(normalized));
    }).length / expected.length
    : completion;
  const startedAt = Math.min(task.createdAt, ...runs.map(run => run.createdAt));
  const finishedAt = Math.max(task.updatedAt, ...runs.map(run => run.updatedAt));
  return {
    taskId: task.id,
    scheduleId: schedule.id,
    runIds,
    status: task.status,
    completed,
    quality: Math.round(completion * 1e6) / 1e6,
    artifactCoverage: Math.round(artifactCoverage * 1e6) / 1e6,
    latencyMs: Math.max(0, finishedAt - startedAt),
    risk: Math.round((1 - artifactCoverage) * 1e6) / 1e6,
    costUsd: Math.round(runs.reduce((sum, run) => sum + run.cost, 0) * 1e6) / 1e6,
    tokens: runs.reduce((sum, run) => sum + run.tokensIn + run.tokensOut, 0),
    coordinationCostUsd: 0,
    coordinationTokens: 0,
    usageKnown: runs.length > 0 && runs.every(run => run.usageStatus === 'reported'),
  };
}

function persistExperiment(
  deps: ExperimentDeps,
  solo: SocietyTask,
  team: SocietyTask,
  experiment: SocietyPairedExperiment,
): void {
  deps.repository().transaction(() => {
    deps.repository().updateSocietyTask(solo, {
      experiment: { ...solo.experiment!, snapshot: structuredClone(experiment) },
    });
    deps.repository().updateSocietyTask(team, {
      experiment: { ...team.experiment!, snapshot: structuredClone(experiment) },
    });
  });
}
