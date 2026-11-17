import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RunEvent, RunRecord } from '../../kernel/run';
import { Store } from '../db';
import { OrganizationService } from '../organization';
import {
  OrganizationError,
  type AssignmentContract,
  type OrganizationRole,
  type SocietySchedule,
  type SocietyTask,
} from '../organization-store';
import { SocietyService } from '../society';

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release native handles later */ }
  }
});

function addRun(store: Store): RunRecord {
  const tenantId = 'default';
  const session = store.createSession('fixture-model', 'fixture', tenantId);
  const id = randomUUID();
  const now = Date.now();
  const run: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId, depth: 0, status: 'running',
    objective: '保留组织事实', providerId: 'fixture', model: 'fixture-model',
    authorization: { workspace: process.cwd(), profile: 'standard', readOnly: false, revision: 0 },
    requestFingerprint: randomUUID(), cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now,
  };
  store.runs.create(run);
  return store.runs.get(id, tenantId)!;
}

function addPersistentRole(store: Store, tenantId: string, name: string, capabilities: string[]): OrganizationRole {
  const now = Date.now();
  return store.organization.createRole({
    id: randomUUID(), tenantId, projectId: '', name,
    responsibilities: ['执行可验收的独立分支'],
    capabilities,
    authority: { workspace: '', readOnly: true, profile: 'standard', allowedTools: [] },
    modelPolicy: { providerId: 'institution', model: 'runtime-selected' },
    persistent: true, employment: 'active', source: 'builtin', revision: 0,
    createdAt: now, updatedAt: now,
  });
}

function societyRuntime(store: Store) {
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  const organization = new OrganizationService({
    store,
    runtimeAuthority: () => ({
      workspace: process.cwd(), readOnly: false, profile: 'standard',
    }),
  });
  const emit = (runId: string) => {
    for (const listener of listeners.get(runId) ?? []) listener({} as RunEvent);
  };
  const runtime = {
    startSocietyAssignment(input: {
      task: SocietyTask;
      schedule: SocietySchedule;
      role: OrganizationRole;
      contract: AssignmentContract;
    }): RunRecord {
      const session = store.createSession('fixture-model', 'fixture', input.task.tenantId);
      const createdAt = Date.now();
      const run: RunRecord = {
        id: randomUUID(), rootId: randomUUID(), sessionId: session.id, tenantId: input.task.tenantId,
        depth: 0, objective: input.contract.branchObjective, providerId: 'fixture', model: 'fixture-model',
        status: 'running', cost: 0, tokensIn: 0, tokensOut: 0, createdAt, updatedAt: createdAt,
        authorization: {
          workspace: process.cwd(), profile: input.role.authority.profile,
          readOnly: input.role.authority.readOnly, revision: 0,
        },
        requestFingerprint: randomUUID(), budgetUsd: input.contract.budgetUsd,
        budgetTokens: input.contract.budgetTokens, budgetPolicy: 'enforce',
        origin: {
          kind: 'society', societyTaskId: input.task.id, scheduleId: input.schedule.id,
          assignmentContractId: input.contract.id,
        },
        workOrderId: input.contract.workOrderId, assignmentContractId: input.contract.id,
        organizationRoleId: input.role.id, teamCycleId: input.contract.teamCycleId,
        toolNames: input.role.authority.allowedTools,
      };
      run.rootId = run.id;
      organization.prepareSocietyRun(run, input.contract.id);
      store.runs.create(run);
      return store.runs.get(run.id, run.tenantId)!;
    },
    get(runId: string, tenantId: string): RunRecord {
      const run = store.runs.get(runId, tenantId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      return run;
    },
    subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
      let set = listeners.get(runId);
      if (!set) listeners.set(runId, set = new Set());
      set.add(listener);
      return () => { set!.delete(listener); };
    },
    cancel(runId: string, tenantId: string): RunRecord {
      const run = store.runs.get(runId, tenantId)!;
      store.runs.update(run, { status: 'cancelled' });
      return store.runs.get(run.id, tenantId)!;
    },
    resume(runId: string, tenantId: string): RunRecord {
      const run = store.runs.get(runId, tenantId)!;
      store.runs.update(run, { status: 'running', error: undefined });
      emit(runId);
      return store.runs.get(run.id, tenantId)!;
    },
  };
  const finish = (
    runId: string,
    tenantId = 'default',
    status: 'completed' | 'failed' = 'completed',
    consumeBudget = true,
  ) => {
    const run = store.runs.get(runId, tenantId)!;
    const contract = store.organization.contractsForRun(runId, tenantId)[0];
    for (const artifact of contract?.expectedArtifacts ?? []) {
      store.runs.startTool(runId, `artifact-${artifact}`, 'fixture_artifact', '{}', { sideEffect: 'write' });
      store.runs.finishTool(runId, `artifact-${artifact}`, {
        ok: true,
        data: artifact,
        evidence: [{ artifact: true, kind: 'file', label: artifact, ref: artifact }],
      });
    }
    store.runs.update(run, {
      status,
      answer: status === 'completed' ? `交付完成：${contract?.branchObjective ?? run.objective}` : undefined,
      error: status === 'failed' ? 'fixture failure' : undefined,
      usageStatus: 'reported', tokensIn: consumeBudget ? run.budgetTokens ?? 0 : 0, tokensOut: 0,
      tokensCached: consumeBudget ? Math.floor((run.budgetTokens ?? 0) / 2) : 0,
      tokensCacheMiss: consumeBudget ? Math.ceil((run.budgetTokens ?? 0) / 2) : 0,
      cost: consumeBudget ? run.budgetUsd ?? 0 : 0,
    });
    emit(runId);
    return store.runs.get(runId, tenantId)!;
  };
  const finishAll = (status: 'completed' | 'failed' = 'completed') => {
    for (const run of store.runs.list('default').filter(run => !['completed', 'failed', 'cancelled'].includes(run.status)))
      finish(run.id, run.tenantId, status);
  };
  return { runtime, organization, finish, finishAll, listeners };
}

function teamBranches() {
  return [
    {
      objective: '核对资料 A 的来源与结论', acceptance: ['列出逐条来源'],
      expectedArtifacts: ['source-a.md'], departmentId: 'knowledge',
    },
    {
      objective: '核对资料 B 的来源与结论', acceptance: ['列出逐条来源'],
      expectedArtifacts: ['source-b.md'], departmentId: 'knowledge',
    },
  ];
}

function crossDepartmentBranches() {
  return [
    {
      objective: '核对研究资料与来源', acceptance: ['逐条列出来源'],
      expectedArtifacts: ['research.md'], departmentId: 'knowledge',
    },
    {
      objective: '整理为办公文档', acceptance: ['文档可打开'],
      expectedArtifacts: ['brief.docx'], departmentId: 'operations',
    },
    {
      objective: '独立复核结论', acceptance: ['列出复核结论'],
      expectedArtifacts: ['review.md'], departmentId: 'quality',
    },
  ];
}

describe('AI society operation layer', () => {
  test('schema migration reaches 14 and backfills role/evaluation history without losing facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-society-migration-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    let store = new Store(file);
    const run = addRun(store);
    const order = new OrganizationService({ store }).createForRun(run);
    store.close();

    const raw = new Database(file);
    raw.exec(`
      DROP TABLE organization_version_audits_v1;
      DROP TABLE organization_versions_v1;
      DROP TABLE organization_role_relations_v1;
      DROP TABLE organization_role_memories_v1;
      DROP TABLE organization_society_schedules_v1;
      DROP TABLE organization_society_tasks_v1;
      DROP TABLE organization_institution_audits_v1;
      DROP TABLE organization_institutions_v1;
      PRAGMA user_version=11;
    `);
    raw.close();

    store = new Store(file);
    try {
      assert.equal(store.schemaVersion, 14);
      assert.equal(store.organization.getWorkOrder(order.id, 'default')?.id, order.id);
      const snapshot = new SocietyService({ store }).snapshot('default');
      assert.equal(snapshot.institution.version, 1);
      assert.equal(snapshot.roles.length >= 4, true);
      assert.equal(snapshot.evaluation.version, 1);
      assert.equal(snapshot.roleLife.every(item => item.versions[0]?.version === 1), true);
      assert.equal(snapshot.roleLife.every(item => item.versionAudits[0]?.action === 'initialize'), true);
      const inspection = new Database(file, { readonly: true });
      const columns = inspection.prepare('PRAGMA table_info(organization_work_orders_v1)').all() as Array<{ name: string; notnull: number }>;
      inspection.close();
      assert.equal(columns.find(column => column.name === 'root_run_id')?.notnull, 0);
      assert.equal(columns.some(column => column.name === 'origin_kind'), true);
    } finally {
      store.close();
    }
  });

  test('institution versions are audited and rollback creates a new active version', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      const initial = society.ensureInstitution('default');
      assert.equal(initial.version, 1);
      assert.equal(store.organization.institutionAudits('default')[0]?.action, 'initialize');

      const updated = society.updateInstitution('default', {
        societyBudgetUsd: 30,
        reason: '提高本月社会总预算',
      });
      assert.equal(updated.version, 2);
      assert.equal(updated.policies.societyBudgetUsd, 30);

      const rolledBack = society.rollbackInstitution('default', 1, '恢复默认预算');
      assert.equal(rolledBack.version, 3);
      assert.equal(rolledBack.policies.societyBudgetUsd, initial.policies.societyBudgetUsd);
      assert.deepEqual(
        store.organization.institutionAudits('default').map(item => item.action).sort(),
        ['initialize', 'rollback', 'update'],
      );

      const snapshot = society.snapshot('default');
      assert.equal(snapshot.roles.length >= 4, true);
      assert.equal(snapshot.roleLife.every(item => item.memories.some(memory => memory.kind === 'appointment')), true);
    } finally {
      store.close();
    }
  });

  test('role and evaluation standards have independent versions, audits and rollback', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      society.ensureInstitution('default');
      const organization = new OrganizationService({ store });
      const role = store.organization.listRoles('default', undefined, true)
        .find(item => item.capabilities.includes('research'))!;
      const initialRole = organization.roleHistory(role.id, 'default');
      assert.equal(initialRole.versions[0]?.version, 1);
      assert.equal(initialRole.audits[0]?.action, 'initialize');

      const roleV2 = organization.updateRole(role.id, 'default', role.revision, {
        name: '研究执行员（审计版）',
        capabilities: ['research', 'reading', 'analysis', 'verification'],
      }, '扩展角色职责');
      const roleHistory = organization.roleHistory(role.id, 'default');
      assert.equal(roleHistory.versions[0]?.version, 2);
      assert.equal(roleHistory.versions[1]?.status, 'superseded');
      assert.equal(roleHistory.audits[0]?.action, 'update');

      store.organization.updateRole(roleV2, {
        authority: { ...roleV2.authority, workspace: process.cwd() },
      }, roleV2.revision, { trackVersion: false });
      assert.equal(organization.roleHistory(role.id, 'default').versions.length, 2);

      const roleV3 = organization.rollbackRole(role.id, 'default', 1, '恢复初始职责');
      assert.notEqual(roleV3.revision, roleV2.revision);
      const rolledBackRole = organization.roleHistory(role.id, 'default');
      assert.equal(rolledBackRole.versions[0]?.version, 3);
      assert.equal(rolledBackRole.versions[0]?.record.name, role.name);
      assert.equal(rolledBackRole.audits[0]?.action, 'rollback');

      const initialEvaluation = society.snapshot('default').evaluation;
      assert.equal(initialEvaluation.version, 1);
      const evaluationV2 = organization.updateEvaluation('default', {
        lowConfidenceSamples: 4,
        mediumConfidenceSamples: 12,
        highConfidenceSamples: 40,
      }, '提高履历置信门槛');
      assert.equal(evaluationV2.version, 2);
      assert.equal(society.snapshot('default').evaluation.version, 2);
      assert.equal(organization.scorecards('default').every(card =>
        card.evaluationVersion === 2 && card.evaluationHash === evaluationV2.hash), true);

      const evaluationV3 = organization.rollbackEvaluation('default', 1, '恢复默认门槛');
      assert.equal(evaluationV3.version, 3);
      assert.equal(evaluationV3.record.lowConfidenceSamples, initialEvaluation.record.lowConfidenceSamples);
      assert.deepEqual(
        store.organization.organizationVersionAudits('evaluation', 'default', 'default').map(item => item.action).sort(),
        ['initialize', 'rollback', 'update'],
      );

      assert.equal(store.organization.activeInstitution('default')?.version, 1);
    } finally {
      store.close();
    }
  });

  test('role and evaluation histories survive a database restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-role-history-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    let store = new Store(file);
    let roleId = '';
    try {
      const society = new SocietyService({ store });
      society.ensureInstitution('default');
      const organization = new OrganizationService({ store });
      const role = store.organization.listRoles('default', undefined, true)[0]!;
      roleId = role.id;
      organization.updateRole(role.id, 'default', role.revision, { name: `${role.name} v2` }, '持久化角色历史');
      organization.updateEvaluation('default', { lowConfidenceSamples: 5 }, '持久化评价标准');
    } finally {
      store.close();
    }
    store = new Store(file);
    try {
      const society = new SocietyService({ store });
      const life = society.roleLife('default', roleId);
      assert.equal(life.versions[0]?.version, 2);
      assert.equal(life.versions[0]?.status, 'active');
      assert.equal(society.snapshot('default').evaluation.version, 2);
      assert.equal(store.schemaVersion, 14);
    } finally {
      store.close();
    }
  });

  test('institutional tick creates a real solo Run and requires delivery before human acceptance', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = society.createTask({
        tenantId: 'default',
        objective: '整理会议文件并列出未完成项',
        valueUsd: 5,
        maxBudgetUsd: 0.1,
        departmentId: 'operations',
      });
      assert.equal(store.runs.list('default').length, 0);

      const tick = society.tick('default');
      assert.equal(tick.decisions.length, 1);
      assert.equal(tick.decisions[0]?.mode, 'solo');
      assert.equal(tick.decisions[0]?.roleIds.length, 1);
      assert.equal(store.runs.list('default').length, 1, JSON.stringify({
        decision: tick.decisions[0],
        task: store.organization.getSocietyTask(task.id, 'default'),
      }));
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'scheduled');

      assert.throws(
        () => society.releaseTask(task.id, 'default', 'completed', '提前伪造成功'),
        (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
      );
      const run = tick.decisions[0]!.runIds[0]!;
      fixture.finish(run);
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'awaiting_acceptance');
      const released = society.releaseTask(task.id, 'default', 'completed', '文件已整理并通过来源检查');
      assert.equal(released.task.status, 'completed');
      assert.equal(released.schedule.status, 'completed');

      const life = society.snapshot('default').roleLife.find(item => item.roleId === released.schedule.roleIds[0]);
      assert.equal(life?.memories.some(item => item.kind === 'schedule'), true);
      assert.equal(life?.memories.some(item => item.kind === 'delivery'), true);
    } finally {
      store.close();
    }
  });

  test('team formation needs independent branches and positive marginal net benefit', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);

      const highValue = society.createTask({
        tenantId: 'default',
        objective: '分别核对两份资料',
        valueUsd: 100,
        maxBudgetUsd: 0.08,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const highResult = society.tick('default');
      const highSchedule = highResult.decisions.find(item => item.taskId === highValue.id);
      assert.equal(highSchedule?.mode, 'team');
      assert.equal((highSchedule?.roleIds.length ?? 0) >= 2, true);
      assert.equal((highSchedule?.estimates.marginalNetBenefitUsd ?? 0) > 0, true);
      assert.equal(highSchedule?.runIds.length, 2);

      const lowValue = society.createTask({
        tenantId: 'default',
        objective: '分别核对两份短提示',
        valueUsd: 0.1,
        maxBudgetUsd: 0.08,
        departmentId: 'operations',
        branches: teamBranches().map(item => ({ ...item, departmentId: 'operations' })),
      });
      const lowTick = society.tick('default');
      const lowSchedule = lowTick.decisions.find(item => item.taskId === lowValue.id);
      assert.equal(lowSchedule?.mode, 'solo');
      assert.equal(lowSchedule?.roleIds.length, 1);
      assert.equal(lowSchedule?.assignments.length, 1);
      assert.equal(lowSchedule?.runIds.length, 1);

      const comparison = society.experiment(highValue.id, 'default');
      assert.equal(comparison.selected, 'team');
      assert.match(comparison.estimate.formula, /quality.*riskReduction.*estimatedCost.*coordinationCost/);
      for (const runId of highSchedule!.runIds) fixture.finish(runId);
      assert.equal(store.organization.getSocietyTask(highValue.id, 'default')?.status, 'awaiting_acceptance');
      society.releaseTask(highValue.id, 'default', 'completed', '两份独立资料已交付');
      const snapshot = society.snapshot('default');
      assert.equal(snapshot.network.edges.length > 0, true);
    } finally {
      store.close();
    }
  });

  test('paired solo and team Runs persist measured net benefit and block negative expansion', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      const pair = society.createPairedExperiment({
        tenantId: 'default',
        objective: '分别核对两份资料',
        valueUsd: 0.1,
        maxBudgetUsd: 0.08,
        maxBudgetTokens: 2_000,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.2, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const schedules = society.tick('default').decisions;
      const soloSchedule = schedules.find(item => item.taskId === pair.solo.id)!;
      const teamSchedule = schedules.find(item => item.taskId === pair.team.id)!;
      assert.equal(soloSchedule.mode, 'solo');
      assert.equal(teamSchedule.mode, 'team');

      fixture.finish(soloSchedule.runIds[0]!);
      fixture.finish(teamSchedule.runIds[0]!);
      fixture.finish(teamSchedule.runIds[1]!, 'default', 'failed', true);

      const measured = society.measurePairedExperiment(pair.experiment.id, 'default');
      assert.equal(measured.status, 'measured');
      assert.ok(measured.measurements);
      assert.ok(measured.netBenefitUsd);
      assert.ok(measured.measurements.solo.completed);
      assert.equal(measured.measurements.team.completed, false);
      assert.ok(measured.netBenefitUsd.marginal < 0);
      assert.equal(measured.measurements.team.coordinationCostUsd >= 0, true);
      assert.equal(society.pairedExperiment(pair.experiment.id, 'default').status, 'measured');

      const guarded = society.createTask({
        tenantId: 'default',
        objective: '复用负收益实验继续核对两份资料',
        valueUsd: 100,
        maxBudgetUsd: 0.08,
        departmentId: 'knowledge',
        evidenceExperimentId: pair.experiment.id,
        economics: { qualityGain: 0.2, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const guardedSchedule = society.tick('default').decisions
        .find(item => item.taskId === guarded.id)!;
      assert.equal(guardedSchedule.mode, 'solo');
      assert.match(guardedSchedule.reason, /配对实测边际净收益.*未达到门槛/);
    } finally {
      store.close();
    }
  });

  test('failed team work hands completed evidence to one coordinator fallback Run', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      const task = society.createTask({
        tenantId: 'default',
        objective: '分别核对两份资料并合并交付',
        acceptance: ['保留两份资料的有效证据'],
        valueUsd: 100,
        maxBudgetUsd: 0.08,
        maxBudgetTokens: 1_000,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const team = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(team.mode, 'team');
      fixture.finish(team.runIds[0]);
      fixture.finish(team.runIds[1], 'default', 'failed', false);

      const collapsed = store.organization.getSocietySchedule(team.id, 'default')!;
      assert.equal(collapsed.status, 'active');
      assert.equal(collapsed.mode, 'solo');
      assert.equal(collapsed.assignments.length, 1);
      const fallback = store.organization.getContract(collapsed.contractIds[0], 'default')!;
      assert.equal(fallback.departmentId, 'knowledge');
      assert.match(fallback.branchObjective, /团队执行受阻/);
      assert.equal(fallback.evidenceInputs.some(item => item.ref === 'source-a.md'), true);
      const fallbackRun = store.runs.get(fallback.runId!, 'default')!;
      assert.equal(fallbackRun.fallbackReason, 'ROLLBACK_TO_SOLO');
      assert.equal(fallbackRun.budgetTokens, 500);
      assert.equal(store.organization.getTeamCycle(team.teamCycleId!, 'default')?.status, 'partial');
      const coordinator = store.organization.getRole(collapsed.roleIds[0], 'default')!;
      fixture.organization.updateRole(
        coordinator.id, 'default', coordinator.revision,
        { capabilities: ['files'] }, '验证历史花费使用契约部门',
      );
      const rollbackBudget = society.snapshot('default').economics.departmentBudgets
        .find(item => item.departmentId === 'knowledge')!;
      assert.equal(Math.round(rollbackBudget.spentUsd * 1_000_000), 40_000);
      assert.equal(Math.round(rollbackBudget.reservedUsd * 1_000_000), 40_000);
      assert.equal(store.organization.roleMemories('default', team.roleIds[1], 20)
        .some(item => item.kind === 'failure'), true);

      fixture.finish(fallbackRun.id);
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'awaiting_acceptance');
      const receipt = fixture.organization.detail(fallback.workOrderId, 'default').receipt!;
      assert.equal(receipt.status, 'partial');
      assert.equal(receipt.contributors.some(item => item.summary.includes('团队执行受阻')), true);
    } finally {
      store.close();
    }
  });

  test('team fallback cannot reserve the remaining task in an over-quota department', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      const task = society.createTask({
        tenantId: 'default',
        objective: '验证团队回退不能绕过部门配额',
        valueUsd: 100,
        maxBudgetUsd: 0.12,
        maxBudgetTokens: 1_000,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const team = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(team.mode, 'team');
      fixture.finish(team.runIds[0]);
      society.updateInstitution('default', {
        departments: society.ensureInstitution('default').policies.departments.map(department =>
          department.id === 'knowledge' ? { ...department, quotaUsd: 0.06 } : department),
        reason: '验证团队回退部门配额',
      });
      fixture.finish(team.runIds[1], 'default', 'failed', false);

      const schedule = store.organization.getSocietySchedule(team.id, 'default')!;
      assert.equal(schedule.status, 'failed');
      const contracts = store.organization.contracts(schedule.workOrderId!, 'default');
      assert.equal(contracts.length, 2);
      assert.equal(contracts
        .some(contract => contract.status === 'active' || contract.status === 'proposed'), false);
    } finally {
      store.close();
    }
  });

  test('team roles follow each branch department and remain distinct', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const institution = society.ensureInstitution('default');
      const task = society.createTask({
        tenantId: 'default',
        objective: '跨部门交付一份带来源的研究简报',
        valueUsd: 100,
        maxBudgetUsd: 0.12,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: [
          {
            objective: '核对研究资料与来源',
            acceptance: ['逐条列出来源'],
            expectedArtifacts: ['research.md'],
            departmentId: 'knowledge',
          },
          {
            objective: '整理为办公文档',
            acceptance: ['文档可打开'],
            expectedArtifacts: ['brief.docx'],
            departmentId: 'operations',
          },
          {
            objective: '独立复核结论',
            acceptance: ['列出复核结论'],
            expectedArtifacts: ['review.md'],
            departmentId: 'quality',
          },
        ],
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(schedule.mode, 'team');
      assert.equal(new Set(schedule.roleIds).size, 3);
      const expectedDepartments: Record<string, string> = {
        'research.md': 'knowledge',
        'brief.docx': 'operations',
        'review.md': 'quality',
      };
      for (const assignment of schedule.assignments) {
        const role = store.organization.getRole(assignment.roleId, 'default')!;
        assert.equal(
          society.departmentForRole(role, institution.policies.departments)?.id,
          expectedDepartments[assignment.expectedArtifacts[0] ?? ''],
        );
      }
      const contracts = schedule.contractIds.map(id => store.organization.getContract(id, 'default')!);
      assert.deepEqual(contracts.map(item => item.departmentId), [
        'knowledge', 'operations', 'quality',
      ]);
    } finally {
      store.close();
    }
  });

  test('task creation rejects unknown or disabled branch departments', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      const institution = society.ensureInstitution('default');
      society.updateInstitution('default', {
        departments: institution.policies.departments.map(department =>
          department.id === 'quality' ? { ...department, enabled: false } : department),
        reason: '验证分支部门校验',
      });
      for (const departmentId of ['missing', 'quality']) {
        assert.throws(() => society.createTask({
          tenantId: 'default',
          objective: '验证分支部门绑定',
          valueUsd: 1,
          maxBudgetUsd: 0.04,
          branches: [{
            objective: '执行分支',
            acceptance: ['完成'],
            expectedArtifacts: ['result.md'],
            departmentId,
          }],
        }), (error: unknown) => error instanceof OrganizationError
          && error.code === 'DEPARTMENT_NOT_FOUND');
      }
    } finally {
      store.close();
    }
  });

  test('team scheduling blocks when any branch department has zero quota', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const institution = society.ensureInstitution('default');
      society.updateInstitution('default', {
        departments: institution.policies.departments.map(department =>
          ['operations', 'quality'].includes(department.id)
            ? { ...department, quotaUsd: 0, quotaTokens: 0 }
            : department),
        reason: '验证跨部门团队配额门禁',
      });
      const task = society.createTask({
        tenantId: 'default',
        objective: '跨部门交付一份带来源的研究简报',
        valueUsd: 100,
        maxBudgetUsd: 0.12,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: crossDepartmentBranches(),
      });

      const tick = society.tick('default');
      assert.equal(tick.decisions.length, 0);
      assert.equal(store.runs.list('default').length, 0);
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'queued');
      assert.match(
        store.organization.getSocietyTask(task.id, 'default')?.lastSchedulingReason ?? '',
        /部门预算配额不足/,
      );
    } finally {
      store.close();
    }
  });

  test('snapshot attributes branch reservations and actual run spend by department', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      const task = society.createTask({
        tenantId: 'default',
        objective: '跨部门交付一份带来源的研究简报',
        valueUsd: 100,
        maxBudgetUsd: 0.12,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: crossDepartmentBranches(),
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      const research = schedule.assignments.find(item => item.expectedArtifacts.includes('research.md'))!;
      const operations = schedule.assignments.find(item => item.expectedArtifacts.includes('brief.docx'))!;
      const quality = schedule.assignments.find(item => item.expectedArtifacts.includes('review.md'))!;
      fixture.finish(research.runId!);

      const activeSnapshot = society.snapshot('default');
      const activeBudgets = new Map(activeSnapshot.economics.departmentBudgets.map(item => [item.departmentId, item]));
      assert.equal(Math.round(activeBudgets.get('knowledge')!.spentUsd * 1_000_000), 40_000);
      assert.equal(Math.round(activeBudgets.get('knowledge')!.reservedUsd * 1_000_000), 0);
      assert.equal(Math.round(activeBudgets.get('operations')!.reservedUsd * 1_000_000), 40_000);
      assert.equal(Math.round(activeBudgets.get('quality')!.reservedUsd * 1_000_000), 40_000);
      assert.equal(Math.round(activeSnapshot.economics.societySpentUsd * 1_000_000), 40_000);
      assert.equal(Math.round(activeSnapshot.economics.societyReservedUsd * 1_000_000), 80_000);

      fixture.finish(operations.runId!);
      fixture.finish(quality.runId!);
      const completedBudgets = new Map(society.snapshot('default').economics.departmentBudgets
        .map(item => [item.departmentId, item]));
      for (const departmentId of ['knowledge', 'operations', 'quality']) {
        assert.equal(Math.round(completedBudgets.get(departmentId)!.spentUsd * 1_000_000), 40_000);
        assert.equal(Math.round(completedBudgets.get(departmentId)!.reservedUsd * 1_000_000), 0);
      }
    } finally {
      store.close();
    }
  });

  test('high spend approval and department quota block scheduling', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      const highSpend = society.createTask({
        tenantId: 'default', objective: '生成高额研究交付',
        valueUsd: 20, maxBudgetUsd: 3, departmentId: 'knowledge',
      });
      assert.equal(highSpend.status, 'waiting_approval');
      assert.equal(society.tick('default').decisions.length, 0);
      society.approveTask(highSpend.id, 'default', true);

      society.updateInstitution('default', {
        departments: society.ensureInstitution('default').policies.departments.map(department =>
          department.id === 'knowledge' ? { ...department, quotaUsd: 2 } : department),
        reason: '压缩研究部门配额',
      });
      const quotaTick = society.tick('default');
      assert.equal(quotaTick.decisions.length, 0);
      assert.match(store.organization.getSocietyTask(highSpend.id, 'default')?.lastSchedulingReason ?? '', /部门预算配额不足/);

    } finally {
      store.close();
    }
  });

  test('society-wide budget blocks new work before any Run starts', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.updateInstitution('default', {
        societyBudgetUsd: 0.05,
        reason: '验证社会总预算门禁',
      });
      const task = society.createTask({
        tenantId: 'default', objective: '超出社会总预算的资料整理',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      assert.equal(society.tick('default').decisions.length, 0);
      assert.equal(store.runs.list('default').length, 0);
      assert.match(
        store.organization.getSocietyTask(task.id, 'default')?.lastSchedulingReason ?? '',
        /社会总预算不足/,
      );
    } finally {
      store.close();
    }
  });

  test('branch token budgets cannot exceed or escape the task cap', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      assert.throws(() => society.createTask({
        tenantId: 'default',
        objective: '验证分支预算上限',
        valueUsd: 1,
        maxBudgetUsd: 0.1,
        maxBudgetTokens: 1000,
        branches: [
          { objective: '分支一', acceptance: ['完成'], expectedArtifacts: ['a.md'], maxBudgetTokens: 900 },
          { objective: '分支二', acceptance: ['完成'], expectedArtifacts: ['b.md'], maxBudgetTokens: 200 },
        ],
      }), (error: unknown) => error instanceof OrganizationError && error.code === 'WORK_CONTRACT_INVALID');

      const normalized = society.createTask({
        tenantId: 'default',
        objective: '分配剩余分支预算',
        valueUsd: 1,
        maxBudgetUsd: 0.1,
        maxBudgetTokens: 1000,
        branches: [
          { objective: '分支一', acceptance: ['完成'], expectedArtifacts: ['a.md'], maxBudgetTokens: 300 },
          { objective: '分支二', acceptance: ['完成'], expectedArtifacts: ['b.md'] },
        ],
      });
      assert.deepEqual(normalized.branches.map(branch => branch.maxBudgetTokens), [300, 700]);
    } finally {
      store.close();
    }
  });

  test('declared branch token budgets reach contracts and Runs without exceeding the task cap', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      const task = society.createTask({
        tenantId: 'default', objective: '按预算完成两条研究分支',
        valueUsd: 100, maxBudgetUsd: 0.1, maxBudgetTokens: 1_000,
        departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: teamBranches().map((branch, index) => ({
          ...branch, maxBudgetTokens: index === 0 ? 300 : 700,
        })),
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(schedule.mode, 'team');
      const contracts = schedule.contractIds.map(id => store.organization.getContract(id, 'default')!);
      const runs = schedule.runIds.map(id => store.runs.get(id, 'default')!);
      assert.deepEqual(contracts.map(contract => contract.budgetTokens), [300, 700]);
      assert.deepEqual(runs.map(run => run.budgetTokens), [300, 700]);
      assert.equal(runs.reduce((sum, run) => sum + (run.budgetTokens ?? 0), 0), task.maxBudgetTokens);
    } finally {
      store.close();
    }
  });

  test('incompatible team models stay on the single-role path', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      store.upsertProvider({
        id: 'provider-a', label: 'A', baseUrl: 'https://a.example/v1', apiKey: '',
        model: 'model-a', priceIn: 1, priceOut: 1,
      });
      store.upsertProvider({
        id: 'provider-b', label: 'B', baseUrl: 'https://b.example/v1', apiKey: '',
        model: 'model-b', priceIn: 1, priceOut: 1,
      });
      const extra = addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      store.organization.updateRole(extra, {
        modelPolicy: { providerId: 'provider-b', model: 'model-b' },
      }, extra.revision);
      const base = store.organization.listRoles('default', undefined, true)
        .find(role => role.id !== extra.id && role.capabilities.includes('research'))!;
      store.organization.updateRole(base, {
        modelPolicy: { providerId: 'provider-a', model: 'model-a' },
      }, base.revision);
      const task = society.createTask({
        tenantId: 'default', objective: '核对两份资料',
        valueUsd: 100, maxBudgetUsd: 0.08, departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: teamBranches(),
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(schedule.mode, 'solo');
      assert.match(schedule.reason, /模型、tokenizer 或价格口径不可比/);
      assert.equal(schedule.runIds.length, 1);
    } finally {
      store.close();
    }
  });

  test('welfare load prevents new assignments to an occupied persistent role', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.updateInstitution('default', {
        welfareMaxActiveAssignments: 1,
        reason: '限制单角色并发负载',
      });
      const first = society.createTask({
        tenantId: 'default', objective: '读取第一篇论文', valueUsd: 5,
        maxBudgetUsd: 0.08, departmentId: 'knowledge',
      });
      const second = society.createTask({
        tenantId: 'default', objective: '读取第二篇论文', valueUsd: 5,
        maxBudgetUsd: 0.08, departmentId: 'knowledge',
      });
      const workloadTick = society.tick('default');
      assert.equal(workloadTick.decisions.some(item => item.taskId === first.id), true);
      assert.equal(workloadTick.decisions.some(item => item.taskId === second.id), false);
      assert.match(store.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '', /福利上限|角色预算不足/);
    } finally {
      store.close();
    }
  });

  test('high context pressure pauses new assignments until the active role recovers', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const first = society.createTask({
        tenantId: 'default', objective: '读取长上下文资料', valueUsd: 5,
        maxBudgetUsd: 0.08, departmentId: 'knowledge',
      });
      const firstSchedule = society.tick('default').decisions.find(item => item.taskId === first.id)!;
      const firstRunId = firstSchedule.runIds[0]!;
      const firstRun = store.runs.get(firstRunId, 'default')!;
      const now = Date.now();
      store.runs.startModelCall({
        id: randomUUID(), runId: firstRunId, scope: 'run', purpose: 'agent',
        providerId: firstRun.providerId, model: firstRun.model, status: 'running',
        startedAt: now, inputEstimate: 850, outputLimit: 50,
        contextWindow: 1_000, usageStatus: 'unknown', priceSource: 'unknown',
      });
      const callId = store.runs.modelCalls(firstRunId)[0]!.id;
      store.runs.finishModelCall({
        ...store.runs.modelCalls(firstRunId)[0]!, id: callId, status: 'completed',
      });

      const second = society.createTask({
        tenantId: 'default', objective: '继续读取另一篇资料', valueUsd: 5,
        maxBudgetUsd: 0.08, departmentId: 'knowledge',
      });
      society.tick('default');

      const wellbeing = fixture.organization.wellbeing('default')
        .find(item => item.roleId === firstSchedule.roleIds[0]);
      assert.equal(wellbeing?.contextPressure, 'high');
      assert.equal(store.organization.getSocietyTask(second.id, 'default')?.status, 'queued');
      assert.match(
        store.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '',
        /上下文压力过高/,
      );
    } finally {
      store.close();
    }
  });

  test('role budget is enforced and shared material references are observable', () => {
    const store = new Store(':memory:');
    const society = new SocietyService({ store });
    try {
      society.ensureInstitution('default');
      const researchRole = store.organization.listRoles('default', undefined, true)
        .find(role => role.capabilities.includes('research'))!;
      store.organization.updateRole(researchRole, { budgetLimitUsd: 0.01 }, researchRole.revision);

      const task = society.createTask({
        tenantId: 'default', objective: '分析共享材料',
        materials: [{ id: 'material-a', version: 'v1' }, { id: 'material-a', version: 'v1' }],
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'knowledge',
      });
      const tick = society.tick('default');
      assert.equal(tick.decisions.length, 0);
      assert.match(store.organization.getSocietyTask(task.id, 'default')?.lastSchedulingReason ?? '', /角色预算不足/);

      const snapshot = society.snapshot('default');
      assert.equal(snapshot.economics.compression.sharedMemoryRefs, 1);
      assert.equal(snapshot.economics.compression.reusedRefs, 1);
      assert.equal(snapshot.economics.cacheSavingsUsd, null);
    } finally {
      store.close();
    }
  });

  test('cache hit rate is shown only when every Run reports cached and miss tokens', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = society.createTask({
        tenantId: 'default', objective: '统计缓存用量',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      const run = store.runs.get(schedule.runIds[0], 'default')!;

      store.runs.update(run, {
        usageStatus: 'reported', tokensCached: 60, tokensCacheMiss: 40, cacheWriteTokens: 0,
      });
      const known = society.snapshot('default').economics;
      assert.equal(known.cacheHitRate, 0.6);
      assert.equal(known.cacheMissInputTokens, 40);
      assert.equal(known.cacheWriteUsageStatus, 'known');
      assert.equal(known.cacheWriteTokens, 0);

      store.runs.update(store.runs.get(run.id, 'default')!, {
        usageStatus: 'unknown', tokensCached: 60, tokensCacheMiss: 40,
      });
      const unknown = society.snapshot('default').economics;
      assert.equal(unknown.cacheUsageStatus, 'unknown');
      assert.equal(unknown.cacheHitRate, null);

      store.runs.update(store.runs.get(run.id, 'default')!, {
        usageStatus: 'reported', tokensCached: undefined, tokensCacheMiss: 40,
      });
      assert.equal(society.snapshot('default').economics.cacheHitRate, null);
    } finally {
      store.close();
    }
  });

  test('high-value tasks without declared team gains remain solo', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      const task = society.createTask({
        tenantId: 'default', objective: '分别核对两份资料',
        valueUsd: 100, maxBudgetUsd: 0.08, departmentId: 'knowledge',
        branches: teamBranches(),
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(schedule.mode, 'solo');
      assert.equal(schedule.runIds.length, 1);
    } finally {
      store.close();
    }
  });

  test('dependent contracts start only after every upstream contract delivers', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.ensureInstitution('default');
      addPersistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
      addPersistentRole(store, 'default', '研究执行员三', ['research', 'reading', 'analysis']);
      const task = society.createTask({
        tenantId: 'default', objective: '先核对两份资料，再形成联合结论',
        valueUsd: 100, maxBudgetUsd: 0.12, departmentId: 'knowledge',
        economics: { qualityGain: 0.1, riskReduction: 0.02 },
        branches: [
          {
            objective: '核对资料 A', acceptance: ['列出 A 的来源'],
            expectedArtifacts: ['source-a.md'], departmentId: 'knowledge',
          },
          {
            objective: '核对资料 B', acceptance: ['列出 B 的来源'],
            expectedArtifacts: ['source-b.md'], departmentId: 'knowledge',
          },
          {
            objective: '合并 A 与 B 的结论', acceptance: ['引用两份来源'],
            expectedArtifacts: ['merged.md'], departmentId: 'knowledge',
            dependsOn: ['branch-1', 'branch-2'],
          },
        ],
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      assert.equal(schedule.runIds.length, 2);
      const [first, second] = schedule.runIds;
      fixture.finish(first);
      assert.equal(store.runs.list('default').length, 2);
      fixture.finish(second);
      assert.equal(store.runs.list('default').length, 3);
      const dependent = store.runs.list('default').find(run => run.status === 'running')!;
      assert.match(dependent.objective, /合并/);
      fixture.finish(dependent.id);
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'awaiting_acceptance');
      society.releaseTask(task.id, 'default', 'completed', '联合结论通过人工验收');
    } finally {
      store.close();
    }
  });

  test('tick and service restart are idempotent for an active social assignment', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const firstSociety = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = firstSociety.createTask({
        tenantId: 'default', objective: '整理一份会议纪要',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const first = firstSociety.tick('default').decisions.find(item => item.taskId === task.id)!;
      firstSociety.tick('default');
      const restarted = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
      restarted.tick('default');
      assert.deepEqual(store.runs.list('default').map(run => run.id), first.runIds);
      fixture.finish(first.runIds[0]);
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'awaiting_acceptance');
    } finally {
      store.close();
    }
  });

  test('restart recovers a terminal Run whose completion event was lost', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const firstSociety = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = firstSociety.createTask({
        tenantId: 'default', objective: '整理一份会议纪要',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const schedule = firstSociety.tick('default').decisions.find(item => item.taskId === task.id)!;
      const run = store.runs.get(schedule.runIds[0], 'default')!;
      store.runs.update(run, { status: 'completed', answer: '纪要已整理完成' });

      const restarted = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
      restarted.tickAll();

      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'awaiting_acceptance');
      assert.equal(store.organization.getSocietySchedule(schedule.id, 'default')?.status, 'completed');
    } finally {
      store.close();
    }
  });

  test('restart resumes an interrupted society Run instead of failing the task', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const firstSociety = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = firstSociety.createTask({
        tenantId: 'default', objective: '恢复中断后的社会任务',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const schedule = firstSociety.tick('default').decisions.find(item => item.taskId === task.id)!;
      const run = store.runs.get(schedule.runIds[0], 'default')!;
      store.runs.update(run, { status: 'interrupted', error: '服务重启' });

      const restarted = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
      restarted.tickAll();

      assert.equal(store.runs.get(run.id, 'default')?.status, 'running');
      assert.equal(store.organization.getSocietySchedule(schedule.id, 'default')?.status, 'active');
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'scheduled');
    } finally {
      store.close();
    }
  });

  test('a failed real Run fails the task and cannot be manually marked completed', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = society.createTask({
        tenantId: 'default', objective: '处理损坏的输入资料',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const schedule = society.tick('default').decisions.find(item => item.taskId === task.id)!;
      fixture.finish(schedule.runIds[0], 'default', 'failed');
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'failed');
      assert.equal(store.organization.getSocietySchedule(schedule.id, 'default')?.status, 'failed');
      assert.throws(
        () => society.releaseTask(task.id, 'default', 'completed', '伪造完成'),
        (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
      );
    } finally {
      store.close();
    }
  });

  test('tickAll schedules all tenants without a main Agent and preserves builtin write authority', () => {
    const store = new Store(':memory:');
    if (!store.hasTenant('tenant-a')) store.createTenant('tenant-a', 'Tenant A');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      society.createTask({
        tenantId: 'default', objective: '整理默认租户文件',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      society.createTask({
        tenantId: 'tenant-a', objective: '整理租户 A 文件',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const summary = society.tickAll();
      assert.equal(summary.tenants, 2);
      assert.equal(summary.decisions.length, 2);
      assert.equal(summary.failed.length, 0);
      assert.equal(store.runs.list('default').length, 1);
      assert.equal(store.runs.list('tenant-a').length, 1);
      const builtin = store.organization.listRoles('default', undefined, true)
        .filter(role => role.source === 'builtin');
      assert.equal(builtin.every(role => role.authority.readOnly === false), true);
      const scheduledRoleIds = summary.decisions.find(decision => decision.tenantId === 'default')?.roleIds ?? [];
      assert.equal(scheduledRoleIds.length > 0, true);
      assert.equal(scheduledRoleIds.every(roleId =>
        store.organization.getRole(roleId, 'default')?.authority.workspace === process.cwd()), true);
    } finally {
      store.close();
    }
  });

  test('tenant isolation covers tasks, roles and release operations', () => {
    const store = new Store(':memory:');
    const fixture = societyRuntime(store);
    const society = new SocietyService({ store, organization: fixture.organization, runs: fixture.runtime });
    try {
      const task = society.createTask({
        tenantId: 'tenant-a', objective: '整理租户 A 的文件',
        valueUsd: 5, maxBudgetUsd: 0.08, departmentId: 'operations',
      });
      const scheduled = society.tick('tenant-a');
      assert.equal(scheduled.decisions.length, 1);
      assert.equal(society.snapshot('tenant-b').tasks.length, 0);
      assert.equal(society.snapshot('tenant-b').roles.length, 4);
      assert.throws(
        () => society.releaseTask(task.id, 'tenant-b', 'completed', '越权释放'),
        (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_NOT_FOUND',
      );
    } finally {
      store.close();
    }
  });
});
