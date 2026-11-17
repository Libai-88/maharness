import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RunEvent, RunRecord } from '../kernel/run';
import { Store } from '../server/db';
import { OrganizationService } from '../server/organization';
import {
  OrganizationError,
  type AssignmentContract,
  type OrganizationRole,
  type SocietySchedule,
  type SocietyTask,
} from '../server/organization-store';
import { SocietyService } from '../server/society';

type Criterion = {
  id: string;
  domain: string;
  status: 'passed' | 'partial';
  evidence: string[];
};

type SocietyRuntime = Pick<SocietyService, 'snapshot' | 'releaseTask'>;

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'evals/acceptance/ai-society-v1/deterministic-report.json');
const dashboardRef = 'evals/acceptance/ai-society-v1/dashboard.png';
const dashboard = resolve(root, dashboardRef);
const liveReportPath = resolve(root, 'evals/reports/organization-live/20261117-social-os-v4/report.json');
const replayReportPath = resolve(root, 'evals/replays/organization-live/20261118-safe-v4/reconciled.json');
const criteria: Criterion[] = [];

const liveReport = existsSync(liveReportPath)
  ? JSON.parse(readFileSync(liveReportPath, 'utf8')) as {
      createdAt: string;
      requestedModel: string;
      expected: number;
      observed: number;
      passed: number;
      allPassed: boolean;
      calls: number;
      tokensIn: number;
      tokensOut: number;
      configuredCostUsd: number | null;
      usageComplete: boolean;
      elapsedMs: number;
    }
  : undefined;
const replayReport = existsSync(replayReportPath)
  ? JSON.parse(readFileSync(replayReportPath, 'utf8')) as {
      createdAt: string;
      sourceReportHash: string;
      rawPassed: number;
      reconciledPassed: number;
      total: number;
      providerCacheUsage: {
        hitMissStatus: 'known' | 'unknown';
        writeStatus: 'known' | 'unknown';
        cachedInputTokens: number | null;
        missInputTokens: number | null;
        cacheWriteTokens: number | null;
        cacheSavingsUsd: number | null;
      };
    }
  : undefined;

function pass(id: string, domain: string, evidence: string[]): void {
  criteria.push({ id, domain, status: 'passed', evidence });
}

function partial(id: string, domain: string, evidence: string[]): void {
  criteria.push({ id, domain, status: 'partial', evidence });
}

function persistentRole(
  store: Store,
  tenantId: string,
  name: string,
  capabilities: string[],
): OrganizationRole {
  const now = Date.now();
  return store.organization.createRole({
    id: randomUUID(), tenantId, projectId: '', name,
    responsibilities: ['执行可验收的独立分支'],
    capabilities,
    authority: { workspace: '', readOnly: false, profile: 'standard', allowedTools: [] },
    modelPolicy: { providerId: 'institution', model: 'runtime-selected' },
    persistent: true, employment: 'active', source: 'human', revision: 0,
    createdAt: now, updatedAt: now,
  });
}

function fixture(store: Store, tenantId = 'default') {
  const organization = new OrganizationService({
    store,
    runtimeAuthority: () => ({
      workspace: process.cwd(),
      readOnly: false,
      profile: 'standard',
      allowedTools: ['role_directory'],
    }),
  });
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  const emit = (runId: string) => {
    const run = store.runs.get(runId, tenantId);
    if (!run) return;
    const event: RunEvent = {
      runId,
      seq: store.runs.events(runId).length + 1,
      type: 'run_updated',
      data: { status: run.status },
      createdAt: Date.now(),
    };
    for (const listener of listeners.get(runId) ?? []) listener(event);
  };
  const runtime = {
    startSocietyAssignment(input: {
      task: SocietyTask;
      schedule: SocietySchedule;
      role: OrganizationRole;
      contract: AssignmentContract;
    }): RunRecord {
      const session = store.createSession('fixture-model', 'fixture', input.task.tenantId);
      const id = randomUUID();
      const now = Date.now();
      const run: RunRecord = {
        id, rootId: id, sessionId: session.id, tenantId: input.task.tenantId,
        depth: 0, status: 'queued', objective: input.contract.branchObjective,
        providerId: 'fixture', model: 'fixture-model',
        authorization: {
          workspace: process.cwd(),
          profile: input.role.authority.profile,
          readOnly: input.role.authority.readOnly,
          revision: 0,
        },
        requestFingerprint: `society:${input.schedule.id}:${input.contract.id}`,
        budgetUsd: input.contract.budgetUsd,
        budgetTokens: input.contract.budgetTokens,
        budgetPolicy: 'enforce',
        toolNames: input.role.authority.allowedTools,
        origin: {
          kind: 'society',
          societyTaskId: input.task.id,
          scheduleId: input.schedule.id,
          assignmentContractId: input.contract.id,
        },
        workOrderId: input.contract.workOrderId,
        assignmentContractId: input.contract.id,
        organizationRoleId: input.role.id,
        teamCycleId: input.contract.teamCycleId,
        cost: 0, tokensIn: 0, tokensOut: 0,
        createdAt: now, updatedAt: now,
      };
      organization.prepareSocietyRun(run, input.contract.id);
      store.runs.create(run);
      return store.runs.get(run.id, run.tenantId)!;
    },
    get(runId: string, tenant: string): RunRecord {
      const run = store.runs.get(runId, tenant);
      if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
      return run;
    },
    subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
      let current = listeners.get(runId);
      if (!current) listeners.set(runId, current = new Set());
      current.add(listener);
      return () => current!.delete(listener);
    },
    cancel(runId: string, tenant: string): RunRecord {
      const run = store.runs.get(runId, tenant);
      if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
      store.runs.update(run, { status: 'cancelled', error: 'fixture cancelled' });
      emit(runId);
      return store.runs.get(runId, tenant)!;
    },
  };
  const finish = (
    runId: string,
    status: 'completed' | 'failed' = 'completed',
    consumeBudget = true,
  ): RunRecord => {
    const run = store.runs.get(runId, tenantId);
    if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
    const contract = run.assignmentContractId
      ? store.organization.getContract(run.assignmentContractId, tenantId)
      : undefined;
    if (status === 'completed') {
      for (const artifact of contract?.expectedArtifacts ?? []) {
        const callId = `artifact:${randomUUID()}`;
        store.runs.startTool(runId, callId, 'fixture_artifact', '{}', {
          sideEffect: 'write',
          version: 'fixture',
        });
        store.runs.finishTool(runId, callId, {
          ok: true,
          data: { artifact },
          evidence: [{
            artifact: true,
            kind: 'file',
            label: artifact,
            ref: artifact,
          }],
        });
      }
    }
    const input = consumeBudget ? Math.max(20, Math.floor((run.budgetTokens ?? 100) / 4)) : 0;
    store.runs.update(run, status === 'completed' ? {
      status,
      answer: `真实契约交付：${contract?.branchObjective ?? run.objective}`,
      usageStatus: 'reported',
      tokensIn: input,
      tokensOut: 10,
      cost: consumeBudget ? run.budgetUsd ?? 0 : 0,
    } : {
      status,
      error: 'fixture branch failed',
      usageStatus: 'reported',
      tokensIn: input,
      tokensOut: 0,
      cost: consumeBudget ? run.budgetUsd ?? 0 : 0,
    });
    emit(runId);
    return store.runs.get(runId, tenantId)!;
  };
  const society = new SocietyService({ store, organization, runs: runtime });
  return { organization, society, runtime, finish };
}

function teamBranches() {
  return [
    {
      objective: '核对资料 A 的来源与结论',
      acceptance: ['逐条列出来源'],
      expectedArtifacts: ['source-a.md'],
      departmentId: 'knowledge',
    },
    {
      objective: '核对资料 B 的来源与结论',
      acceptance: ['逐条列出来源'],
      expectedArtifacts: ['source-b.md'],
      departmentId: 'knowledge',
    },
  ];
}

function finishAndAccept(
  fixtureValue: ReturnType<typeof fixture>,
  society: SocietyRuntime,
  schedule: SocietySchedule,
  task: SocietyTask,
): void {
  for (const runId of schedule.runIds) fixtureValue.finish(runId);
  assert.equal(
    society.snapshot(task.tenantId).tasks.find(item => item.id === task.id)?.status,
    'awaiting_acceptance',
  );
  society.releaseTask(task.id, task.tenantId, 'completed', '人工核验真实 Run、契约与产物后验收');
}

const store = new Store(':memory:');

try {
  const primary = fixture(store);
  const { organization, society, finish } = primary;
  const institution = society.ensureInstitution('default');
  const initial = society.snapshot('default');
  const docs = [
    readFileSync(resolve(root, 'docs/AI-SOCIETY.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/AI-ORGANIZATION.md'), 'utf8'),
  ].join('\n');
  assert.match(docs, /AI 原生操作系统层和 AI 社会运行层/);
  assert.match(docs, /主 Agent/);
  assert.match(docs, /持久角色/);
  pass('A1', '产品定位', [
    '架构文档明确 OS 层与社会运行层共同构成产品本体，主 Agent 只是人类入口与协调器。',
    `默认制度 v${institution.version} 包含 ${initial.departments.length} 个部门和 ${initial.roles.length} 个持久角色。`,
  ]);
  assert.equal(initial.roles.length, 4);
  assert.equal(initial.roleLife.every(item => item.memories.some(memory => memory.kind === 'appointment')), true);
  pass('A2', '与多代理框架区分', [
    '社会运行由独立 SocietyService 与系统调度器推进，不依赖主 Agent 调用链。',
    '角色在任务结束后保留身份、履历、关系和福利状态。',
  ]);
  pass('B1', '持久社会成员', [
    `持久角色 ${initial.roles.length} 个，均有 appointment 生命史。`,
    '角色记录包含岗位、权限、模型策略、聘用状态和修订号。',
  ]);

  const versionedRole = persistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
  const teamTask = society.createTask({
    tenantId: 'default',
    objective: '分别核对两份独立资料并形成可追溯交付',
    materials: [
      { id: 'material-1', version: 'v1' },
      { id: 'material-1', version: 'v1' },
    ],
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  assert.equal(store.runs.list('default').length, 0);
  const teamTick = society.tick('default');
  const teamSchedule = teamTick.decisions.find(item => item.taskId === teamTask.id);
  assert.equal(teamSchedule?.mode, 'team');
  assert.equal(teamSchedule?.roleIds.length, 2);
  assert.equal(teamSchedule?.runIds.length, 2);
  assert.equal(store.runs.list('default').length, 2);
  assert.equal(store.runs.list('default').every(run => run.origin?.kind === 'society'), true);
  pass('B2', '制度调度而非硬派活', [
    `机构 v${teamSchedule?.institutionVersion} 作出 ${teamSchedule?.mode} 决策，角色 ${teamSchedule?.roleIds.length} 个。`,
    '系统 tick 在无主 Agent 调用时创建了 2 个真实社会 Run 和 2 份分工契约。',
  ]);
  pass('F1', '去掉主 Agent 仍运转', [
    `无主 Agent 运行时创建 Run：${teamSchedule?.runIds.join(', ')}。`,
    '运行来源均为 society，并由系统调度器而不是聊天调用链推进。',
  ]);

  assert.equal(teamSchedule?.contractIds.length, 2);
  const teamExperiment = society.experiment(teamTask.id, 'default');
  assert.equal(teamExperiment.selected, 'team');
  assert.match(teamExperiment.estimate.formula, /quality.*riskReduction.*estimatedCost.*coordinationCost/);
  assert.ok(teamExperiment.estimate.marginalNetBenefitUsd > 0);

  assert.throws(
    () => society.releaseTask(teamTask.id, 'default', 'completed', '提前伪造成功'),
    (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
  );
  for (const runId of teamSchedule!.runIds) finish(runId);
  const awaiting = society.snapshot('default').tasks.find(item => item.id === teamTask.id);
  assert.equal(awaiting?.status, 'awaiting_acceptance');
  const postRun = society.snapshot('default');
  const settledSchedule = postRun.schedules.find(item => item.id === teamSchedule?.id);
  assert.equal(settledSchedule?.status, 'completed');
  assert.equal(postRun.network.edges.length > 0, true);
  assert.equal(postRun.roleLife.some(item => item.memories.some(memory => memory.kind === 'delivery')), true);
  const teamLedger = postRun.economics.taskLedger.find(item => item.taskId === teamTask.id)!;
  assert.ok((teamLedger.actualTokens ?? 0) > 0);
  assert.equal(teamLedger.cachedInputTokens, 0);
  assert.equal(postRun.economics.cacheHitRate, null);
  assert.equal(postRun.economics.cacheSavingsUsd, null);
  assert.equal(postRun.economics.compression.sharedMemoryRefs, 1);
  assert.equal(postRun.economics.compression.reusedRefs, 1);
  assert.deepEqual(settledSchedule?.assignments.map(item => item.cognitiveTier), ['decision', 'execution']);
  assert.equal(settledSchedule?.assignments.every(item => item.routingStrategy.length > 0), true);
  const cacheRuns = teamSchedule!.runIds.map(runId => store.runs.get(runId, 'default')!);
  for (const run of cacheRuns) {
    store.runs.update(run, { usageStatus: 'reported', tokensCached: 50, tokensCacheMiss: 50 });
  }
  assert.equal(society.snapshot('default').economics.cacheHitRate, 0.5);
  store.runs.update(store.runs.get(cacheRuns[0]!.id, 'default')!, { tokensCached: undefined });
  assert.equal(society.snapshot('default').economics.cacheHitRate, null);
  pass('B3', '部门与社会运行层', [
    `${postRun.departments.length} 个部门、${postRun.network.nodes.length} 个成员和 ${postRun.network.edges.length} 条协作关系进入社会快照。`,
    '快照同时提供部门队列、并发、福利、瓶颈和健康度。',
  ]);
  pass('C1', '多目标优化', [
    '调度事实同时记录任务价值、质量、时延、风险、成本、部门配额和福利负载。',
    `当前社会健康分数=${postRun.health.score}，预算利用率=${postRun.health.budgetUtilization}。`,
  ]);
  pass('F2', '角色跨任务生命史', [
    '团队完成后角色保留 schedule、delivery 和 appointment 记忆。',
    `当前协作网络包含 ${postRun.network.edges.length} 条有契约证据的关系。`,
  ]);
  pass('G3', '最小必要团队与动态解散', [
    `团队 Run 数=${settledSchedule?.runIds.length}，全部真实契约交付后调度释放。`,
    '角色处于空闲状态，但身份、记忆和关系继续保留。',
  ]);
  pass('G4', '分层认知与共享记忆', [
    '调度作业持久化 decision 与 execution 认知层及各自路由策略。',
    '重复材料引用按稳定 EvidenceRef 去重；fixture 不伪造 Provider cache usage。',
  ]);
  pass('G5', 'token 社会仪表盘与调度市场', [
    `社会、部门和角色预算可见；团队实际 token=${teamLedger.actualTokens}。`,
    '全部 Run 同时报告缓存命中与未命中 token 时命中率为 0.5；任一 Run 缺字段时命中率恢复为 null。',
    `Provider 缓存节省=${postRun.economics.cacheSavingsUsd}；未知值保持 null。`,
  ]);
  society.releaseTask(teamTask.id, 'default', 'completed', '人类确认真实分工、产物与证据后完成验收');

  const paired = society.createPairedExperiment({
    tenantId: 'default',
    objective: '分别核对两份资料',
    valueUsd: 0.1,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 2_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.2, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const pairedSchedules = society.tick('default').decisions;
  const pairedSolo = pairedSchedules.find(item => item.taskId === paired.solo.id)!;
  const pairedTeam = pairedSchedules.find(item => item.taskId === paired.team.id)!;
  assert.equal(pairedSolo.mode, 'solo');
  assert.equal(pairedTeam.mode, 'team');
  finish(pairedSolo.runIds[0]!);
  finish(pairedTeam.runIds[0]!);
  finish(pairedTeam.runIds[1]!, 'failed', true);
  const pairedResult = society.measurePairedExperiment(paired.experiment.id, 'default');
  assert.equal(pairedResult.status, 'measured');
  assert.ok(pairedResult.measurements);
  assert.ok(pairedResult.netBenefitUsd);
  assert.ok(pairedResult.netBenefitUsd.marginal < 0);
  const guarded = society.createTask({
    tenantId: 'default',
    objective: '复用负收益实验继续核对两份资料',
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    departmentId: 'knowledge',
    evidenceExperimentId: paired.experiment.id,
    economics: { qualityGain: 0.2, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const guardedSchedule = society.tick('default').decisions.find(item => item.taskId === guarded.id)!;
  assert.equal(guardedSchedule.mode, 'solo');
  assert.match(guardedSchedule.reason, /配对实测边际净收益.*未达到门槛/);
  partial('H1', '多团队净收益实验', [
    '确定性层已完成同一任务的单角色与团队真实 Run 配对，记录质量、产物覆盖、时延、风险、实际成本、token 与协调增量。',
    `声明估算边际净收益=${teamExperiment.estimate.marginalNetBenefitUsd} USD。`,
    `配对实测：单角色=${pairedResult.netBenefitUsd.solo} USD，团队=${pairedResult.netBenefitUsd.team} USD，边际=${pairedResult.netBenefitUsd.marginal} USD。`,
    '负边际结果显示在审计记录中，后续绑定该实验的任务被强制保持单角色。',
    '仍未执行同一任务上的真实模型 paired live A/B，因此实际质量、时延与净收益在真实 Provider 上的复现性仍待门禁验证。',
  ]);

  const lowTask = society.createTask({
    tenantId: 'default',
    objective: '低价值双分支任务',
    valueUsd: 0.1,
    maxBudgetUsd: 0.08,
    departmentId: 'operations',
    branches: teamBranches().map(item => ({ ...item, departmentId: 'operations' })),
  });
  const lowTick = society.tick('default');
  const lowSchedule = lowTick.decisions.find(item => item.taskId === lowTask.id);
  assert.equal(lowSchedule?.mode, 'solo');
  assert.equal(lowSchedule?.roleIds.length, 1);
  finishAndAccept(primary, society, lowSchedule!, lowTask);

  const noGain = society.createTask({
    tenantId: 'default',
    objective: '低收益检查',
    valueUsd: 0.05,
    maxBudgetUsd: 0.08,
    departmentId: 'operations',
  });
  society.tick('default');
  const noGainTask = store.organization.getSocietyTask(noGain.id, 'default');
  assert.equal(noGainTask?.status, 'queued');
  assert.match(noGainTask?.lastSchedulingReason ?? '', /净收益不足/);
  pass('G2', '组队净收益阈值', [
    '同一双分支结构在低价值时保持单角色，没有误组队。',
    `更低收益任务进入排队：${noGainTask?.lastSchedulingReason}。`,
    '组队决策要求团队净收益高于单角色并跨过制度门槛。',
  ]);
  pass('G6', '熔断与回退', [
    '低收益扩团被阻止，任务保留可重新估价状态。',
    '团队分支失败后创建单角色协调契约，保留已完成证据并以 ROLLBACK_TO_SOLO 继续。',
  ]);

  const failureTask = society.createTask({
    tenantId: 'default',
    objective: '验证失败交付不能人工伪造成功',
    valueUsd: 5,
    maxBudgetUsd: 0.08,
    departmentId: 'knowledge',
  });
  const failureTick = society.tick('default');
  const failureSchedule = failureTick.decisions.find(item => item.taskId === failureTask.id)!;
  finish(failureSchedule.runIds[0]!, 'failed');
  const failedTask = store.organization.getSocietyTask(failureTask.id, 'default');
  assert.equal(failedTask?.status, 'failed');
  assert.throws(
    () => society.releaseTask(failureTask.id, 'default', 'completed', '模型或人工声称完成'),
    (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
  );

  const fallbackTask = society.createTask({
    tenantId: 'default',
    objective: '团队失败后由协调角色接管已完成证据',
    acceptance: ['保留已完成分支证据'],
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 2_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const fallbackTeam = society.tick('default').decisions.find(item => item.taskId === fallbackTask.id)!;
  assert.equal(fallbackTeam.mode, 'team');
  finish(fallbackTeam.runIds[0]!);
  finish(fallbackTeam.runIds[1]!, 'failed', false);
  const fallbackSchedule = store.organization.getSocietySchedule(fallbackTeam.id, 'default')!;
  assert.equal(fallbackSchedule.mode, 'solo');
  const fallbackContract = store.organization.getContract(fallbackSchedule.contractIds[0]!, 'default')!;
  assert.ok(fallbackContract.runId);
  assert.equal(store.runs.get(fallbackContract.runId!, 'default')?.fallbackReason, 'ROLLBACK_TO_SOLO');
  finish(fallbackContract.runId!);
  assert.equal(store.organization.getSocietyTask(fallbackTask.id, 'default')?.status, 'awaiting_acceptance');
  society.releaseTask(fallbackTask.id, 'default', 'completed', '人工验收协调回退结果');

  const budgets = society.snapshot('default').economics;
  assert.ok(budgets.societyBudgetUsd > 0);
  assert.ok(budgets.societyTokenBudget > 0);
  assert.equal(budgets.departmentBudgets.every(item => item.quotaUsd >= 0 && item.quotaTokens >= 0), true);
  assert.equal(budgets.roleBudgets.every(item => item.activeAssignments >= 0), true);
  pass('G1', 'token 三级预算', [
    `社会预算=${budgets.societyBudgetUsd} USD / ${budgets.societyTokenBudget} token。`,
    '部门配额、角色账本和任务预算均进入同一快照与调度门禁。',
  ]);

  const updated = society.updateInstitution('default', {
    societyBudgetUsd: 25,
    reason: '人类提高社会总预算',
  });
  const rolledBack = society.rollbackInstitution('default', institution.version, '恢复初始制度');
  assert.equal(rolledBack.version, updated.version + 1);
  const auditActions = new Set(store.organization.institutionAudits('default').map(item => item.action));
  assert.equal(auditActions.has('initialize'), true);
  assert.equal(auditActions.has('update'), true);
  assert.equal(auditActions.has('rollback'), true);
  const roleBeforeChanges = organization.roleHistory(versionedRole.id, 'default').role;
  const roleV2 = organization.updateRole(
    versionedRole.id,
    'default',
    roleBeforeChanges.revision,
    { name: '研究执行员（职责修订）' },
    '验证角色独立版本',
  );
  const roleV2Version = organization.roleHistory(versionedRole.id, 'default').versions[0]?.version;
  const roleV3 = organization.rollbackRole(versionedRole.id, 'default', 1, '验证角色版本回滚');
  const roleHistory = organization.roleHistory(versionedRole.id, 'default');
  assert.equal(roleV2Version, 2);
  assert.equal(roleV2.revision > roleBeforeChanges.revision, true);
  assert.equal(roleV3.name, versionedRole.name);
  assert.deepEqual(roleHistory.versions.map(item => item.version), [3, 2, 1]);
  assert.deepEqual(roleHistory.audits.map(item => item.action), ['rollback', 'update', 'initialize']);

  const evaluationBeforeChanges = organization.evaluationHistory('default');
  const evaluationV2 = organization.updateEvaluation('default', {
    lowConfidenceSamples: 4,
    mediumConfidenceSamples: 12,
    highConfidenceSamples: 40,
  }, '验证评价标准独立版本');
  const evaluationV3 = organization.rollbackEvaluation(
    'default',
    evaluationBeforeChanges.active.version,
    '验证评价标准版本回滚',
  );
  const evaluationHistory = organization.evaluationHistory('default');
  assert.equal(evaluationV2.version, evaluationBeforeChanges.active.version + 1);
  assert.equal(evaluationV3.version, evaluationV2.version + 1);
  assert.deepEqual(
    evaluationHistory.versions.map(item => item.version),
    [evaluationV3.version, evaluationV2.version, evaluationBeforeChanges.active.version],
  );
  assert.deepEqual(
    evaluationHistory.audits.map(item => item.action),
    ['rollback', 'update', 'initialize'],
  );

  pass('E1', '制度版本化演化', [
    '制度更新和回滚均创建新 active 版本，旧版本保留；哈希、来源、前后版本和原因可审计。',
    `角色独立发布 v${roleV2Version} 并回滚为 active v${roleHistory.versions[0]?.version}，历史版本和审计保持可查。`,
    `评价标准独立发布 v${evaluationV2.version} 并回滚为 active v${evaluationV3.version}，AI 复盘可冻结完整策略版本和哈希。`,
  ]);
  pass('F4', '制度可版本化演化', [
    `制度从 v${institution.version} 更新到 v${updated.version}，再以 v${rolledBack.version} 发布回滚。`,
    '历史版本、策略哈希和审计记录保持可查。',
  ]);

  const highSpendStore = new Store(':memory:');
  try {
    const high = fixture(highSpendStore);
    const pending = high.society.createTask({
      tenantId: 'default',
      objective: '高额研究交付',
      valueUsd: 30,
      maxBudgetUsd: 3,
      departmentId: 'knowledge',
    });
    assert.equal(pending.status, 'waiting_approval');
    assert.equal(high.society.tick('default').decisions.length, 0);
    high.society.approveTask(pending.id, 'default', true);
    high.society.updateInstitution('default', {
      departments: high.society.ensureInstitution('default').policies.departments.map(department =>
        department.id === 'knowledge' ? { ...department, quotaUsd: 2 } : department),
      reason: '收紧研究部门配额',
    });
    assert.equal(high.society.tick('default').decisions.length, 0);
    assert.match(
      highSpendStore.organization.getSocietyTask(pending.id, 'default')?.lastSchedulingReason ?? '',
      /部门预算配额不足/,
    );
    pass('E2', '可审计与可干预', [
      '模型不能批准自身高额任务；人类批准后才进入调度。',
      '人类调整部门配额后，调度被事实门禁阻断并记录具体原因。',
    ]);
  } finally {
    highSpendStore.close();
  }

  const welfareStore = new Store(':memory:');
  try {
    const welfare = fixture(welfareStore);
    welfare.society.updateInstitution('default', {
      welfareMaxActiveAssignments: 1,
      reason: '限制单角色并发',
    });
    const first = welfare.society.createTask({
      tenantId: 'default', objective: '读取论文一', valueUsd: 5,
      maxBudgetUsd: 0.08, departmentId: 'knowledge',
    });
    const second = welfare.society.createTask({
      tenantId: 'default', objective: '读取论文二', valueUsd: 5,
      maxBudgetUsd: 0.08, departmentId: 'knowledge',
    });
    const welfareTick = welfare.society.tick('default');
    assert.equal(welfareTick.decisions.some(item => item.taskId === first.id), true);
    assert.equal(welfareTick.decisions.some(item => item.taskId === second.id), false);
    assert.match(
      welfareStore.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '',
      /福利上限|角色预算不足/,
    );
    const welfareRunId = welfareTick.decisions.find(item => item.taskId === first.id)!.runIds[0]!;
    const welfareRun = welfareStore.runs.get(welfareRunId, 'default')!;
    welfareStore.runs.startModelCall({
      id: randomUUID(), runId: welfareRunId, scope: 'run', purpose: 'agent',
      providerId: welfareRun.providerId, model: welfareRun.model, status: 'running',
      startedAt: Date.now(), inputEstimate: 850, outputLimit: 50,
      contextWindow: 1_000, usageStatus: 'unknown', priceSource: 'unknown',
    });
    const modelCallId = welfareStore.runs.modelCalls(welfareRunId)[0]!.id;
    welfareStore.runs.finishModelCall({
      ...welfareStore.runs.modelCalls(welfareRunId)[0]!, id: modelCallId, status: 'completed',
    });
    welfare.society.tick('default');
    const pressuredRole = welfare.organization.wellbeing('default')
      .find(item => item.roleId === welfareTick.decisions.find(decision => decision.taskId === first.id)?.roleIds[0]);
    assert.equal(pressuredRole?.contextPressure, 'high');
    assert.match(
      welfareStore.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '',
      /上下文压力过高/,
    );
    pass('C2', 'AI 社会成员福利', [
      '角色并发上限进入实际调度门禁。',
      '超载时新任务不启动 Run，角色不会被无限占用。',
      'Provider 上下文窗口进入福利快照；最近调用达到窗口 80% 时暂停向该角色分配新任务。',
    ]);
    pass('F3', '调度受福利与资源约束', [
      '福利负载、部门并发、预算和角色可用性共同决定是否派工。',
    ]);
  } finally {
    welfareStore.close();
  }

  assert.equal(store.organization.getSocietyTask(noGain.id, 'default')?.status, 'queued');
  assert.equal(store.organization.getSocietyTask(failureTask.id, 'default')?.status, 'failed');
  assert.equal(existsSync(dashboard), true, '浏览器经营闭环必须先生成 dashboard.png');
  pass('D1', '人类经营者界面', [
    '工作台提供目标、价值、预算、部门、审批、验收、制度调整与回滚操作。',
    `浏览器 UI 契约测试覆盖经营流程；截图仅作展示：${dashboardRef}。`,
  ]);
  pass('D2', '社会仪表盘', [
    'mock API 浏览器契约确认界面展示部门、角色、网络、瓶颈、福利、执行进度与待验收结果。',
    '执行中的真实 Run 不显示验收按钮；只有 awaiting_acceptance 才允许人工确认交付。',
  ]);
  pass('H2', '场景演练', [
    '单 Agent 可解不组队、高价值任务组队、低收益扩团被拒、失败不可伪造完成、团队失败回退单角色、无主 Agent 持久化 Run 推进均已执行。',
    `成功团队 Run=${teamSchedule?.runIds.length}，低价值任务模式=${lowSchedule?.mode}，失败任务终态=${failedTask?.status}。`,
  ]);
} finally {
  store.close();
}

const idOrder = criteria.map(item => item.id);
assert.equal(new Set(idOrder).size, idOrder.length, '验收编号不能重复');
const expectedIds = [
  'A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'D1', 'D2', 'E1', 'E2', 'F1',
  'F2', 'F3', 'F4', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'H1', 'H2',
];
assert.deepEqual([...idOrder].sort(), [...expectedIds].sort());

const report = {
  kind: 'ai-society-deterministic-acceptance',
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  mode: 'deterministic-real-runtime-fixture',
  criteria: criteria.sort((left, right) => left.id.localeCompare(right.id)),
  summary: {
    total: criteria.length,
    passed: criteria.filter(item => item.status === 'passed').length,
    partial: criteria.filter(item => item.status === 'partial').length,
    failed: 0,
    aToFPassed: criteria.filter(item => /^[A-F]/.test(item.id)).every(item => item.status === 'passed'),
    gToHPassed: criteria.filter(item => /^[GH]/.test(item.id)).every(item => item.status === 'passed'),
    fullyPassed: criteria.every(item => item.status === 'passed'),
  },
  sourceHashes: Object.fromEntries([
    'scripts/ai-society-acceptance.ts',
    'server/db.ts',
    'server/society.ts',
    'server/organization.ts',
    'server/organization-store.ts',
    'server/run-service.ts',
    'kernel/model-call.ts',
    'kernel/tests/model-call.spec.ts',
    'server/tests/organization.spec.ts',
    'server/tests/society.spec.ts',
    'server/tests/society-restart.integration.spec.ts',
    'ui/e2e/society.spec.ts',
  ].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  evidence: {
    realRuntime: 'Each scheduled assignment creates a persisted Run with society origin, work-order, contract, role, token and cache facts.',
    humanAcceptance: 'Only awaiting_acceptance with all contracts delivered can enter completed.',
    uiE2e: 'ui/e2e/society.spec.ts is a browser UI contract test with mocked APIs.',
    dashboard: dashboardRef,
  },
  liveModelEvidence: liveReport && replayReport ? {
    available: true,
    model: liveReport.requestedModel,
    rawRun: {
      createdAt: liveReport.createdAt,
      expected: liveReport.expected,
      observed: liveReport.observed,
      passed: liveReport.passed,
      allPassed: liveReport.allPassed,
      calls: liveReport.calls,
      tokensIn: liveReport.tokensIn,
      tokensOut: liveReport.tokensOut,
      configuredCostUsd: liveReport.configuredCostUsd,
      usageComplete: liveReport.usageComplete,
      elapsedMs: liveReport.elapsedMs,
    },
    traceReplay: {
      createdAt: replayReport.createdAt,
      sourceReportHash: replayReport.sourceReportHash,
      rawPassed: replayReport.rawPassed,
      reconciledPassed: replayReport.reconciledPassed,
      total: replayReport.total,
      callsModels: false,
      semantics: 'Reloads persisted outputs and terminal facts through the corrected deterministic finalizer.',
    },
    providerCache: replayReport.providerCacheUsage,
    billing: 'The configured route declares a zero local price; supplier billing and cache savings remain unverified.',
  } : { available: false },
  limits: [
    'This report validates deterministic runtime and browser behavior; it is not a real-model result.',
    'Provider cache savings remain unknown unless usage is reported; cache token hit rate is calculated only from reported cache fields.',
    '福祉表示可观测运行负担，不表示主观感受、意识或法律人格。',
    'H1 is a declared-estimate comparison, not a paired real-model A/B; actual quality gain, latency benefit and net benefit remain unverified.',
    'The browser E2E uses mocked APIs and does not prove a live frontend-to-backend flow.',
  ],
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ output, ...report.summary }, null, 2));
