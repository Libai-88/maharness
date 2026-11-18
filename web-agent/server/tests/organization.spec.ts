import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RunRecord } from '../../kernel/run';
import type { AgentLoop, RunOptions } from '../../kernel/loop';
import type { ProviderDef, ToolDef } from '../../kernel/types';
import { Store } from '../db';
import { OrganizationService } from '../organization';
import {
  OrganizationError,
  type OrganizationRole,
  type SocietySchedule,
  type SocietyTask,
} from '../organization-store';
import { RunService } from '../run-service';

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* native handles can lag on Windows */ }
  }
});

function addRun(store: Store, input: {
  objective?: string;
  tenantId?: string;
  budgetUsd?: number;
  budgetPolicy?: 'advisory' | 'enforce';
  workspace?: string;
} = {}): RunRecord {
  if (!store.getProvider('fixture')) {
    store.upsertProvider({
      id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1',
      apiKey: '', model: 'fixture-model', priceIn: 1, priceOut: 2,
    });
  }
  const tenantId = input.tenantId ?? 'default';
  const session = store.createSession('fixture-model', 'fixture', tenantId);
  const id = randomUUID();
  const now = Date.now();
  const run: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId, depth: 0, status: 'running',
    objective: input.objective ?? '整理一份可检查的结果',
    providerId: 'fixture', model: 'fixture-model',
    authorization: {
      workspace: input.workspace ?? process.cwd(),
      profile: 'standard', readOnly: false, revision: 0,
    },
    budgetUsd: input.budgetUsd,
    budgetPolicy: input.budgetPolicy ?? 'advisory',
    requestFingerprint: randomUUID(),
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now,
  };
  store.runs.create(run);
  return store.runs.get(id, tenantId)!;
}

function tool(name: string): ToolDef {
  return {
    name, version: '1.0.0', description: name, permissions: [], sideEffect: 'none',
    parameters: { type: 'object' }, outputSchema: { type: 'object' },
    async handler() { return { ok: true, data: {} }; },
  };
}

function addTeam(service: OrganizationService, run: RunRecord, toolPermission = 'read_file') {
  return service.createTeam(run, {
    assignments: [
      {
        roleName: '资料分析员', objective: '分析资料 A', expectedArtifacts: ['analysis-a.md'],
        acceptance: ['结论带来源'], budgetUsd: 0.02, allowedTools: [toolPermission],
      },
      {
        roleName: '资料分析员 B', objective: '分析资料 B', expectedArtifacts: ['analysis-b.md'],
        acceptance: ['结论带来源'], budgetUsd: 0.02, allowedTools: [toolPermission],
      },
    ],
    reason: '两个独立资料来源与产物',
  });
}

function addChild(store: Store, parent: RunRecord, objective: string): RunRecord {
  const id = randomUUID();
  const now = Date.now();
  const child: RunRecord = {
    id, rootId: parent.rootId, parentId: parent.id, sessionId: parent.sessionId, tenantId: parent.tenantId,
    depth: 1, status: 'queued', objective, providerId: parent.providerId, model: parent.model,
    authorization: { ...parent.authorization }, cost: 0.01, tokensIn: 10, tokensOut: 5,
    createdAt: now, updatedAt: now,
  };
  store.runs.create(child);
  return child;
}

function addArtifact(store: Store, run: RunRecord, callId: string, ref: string): void {
  store.runs.startTool(run.id, callId, 'write_file', '{}', { version: '1.0.0', sideEffect: 'write' });
  store.runs.finishTool(run.id, callId, {
    ok: true, data: {},
    evidence: [{ artifact: true, kind: 'file', label: ref, ref }],
  });
}

function addRole(store: Store, input: {
  workspace?: string;
  readOnly?: boolean;
  profile?: 'standard' | 'developer';
  allowedTools?: string[];
} = {}): OrganizationRole {
  const now = Date.now();
  return store.organization.createRole({
    id: randomUUID(), tenantId: 'default', projectId: '', name: '社会执行员',
    responsibilities: ['执行可验收分工'], capabilities: ['files'],
    authority: {
      workspace: input.workspace ?? '',
      readOnly: input.readOnly ?? false,
      profile: input.profile ?? 'developer',
      allowedTools: input.allowedTools ?? ['read_file', 'write_file'],
    },
    modelPolicy: { providerId: 'fixture', model: 'fixture-model' },
    persistent: true, employment: 'active', source: 'human', revision: 0,
    createdAt: now, updatedAt: now,
  });
}

function societyTask(): SocietyTask {
  const now = Date.now();
  return {
    id: randomUUID(), tenantId: 'default', projectId: '',
    objective: '完成两个有依赖的可验收分支', acceptance: ['两个分支均交付'],
    materials: [], valueUsd: 1, maxBudgetUsd: 0.04, maxBudgetTokens: 4000,
    priority: 3, departmentId: 'operations',
    branches: [
      { objective: '读取来源', acceptance: ['来源完整'], expectedArtifacts: ['source.md'], departmentId: 'operations' },
      { objective: '汇总来源', acceptance: ['汇总完整'], expectedArtifacts: ['summary.md'], departmentId: 'operations', dependsOn: ['branch-1'] },
    ],
    approval: 'not_required', status: 'scheduled', createdAt: now, updatedAt: now, revision: 0,
  };
}

function societySchedule(task: SocietyTask, roleId: string): SocietySchedule {
  return {
    id: randomUUID(), tenantId: task.tenantId, taskId: task.id, contractIds: [], runIds: [],
    trigger: 'institution', institutionVersion: 1, departmentId: 'operations', mode: 'team',
    roleIds: [roleId],
    assignments: task.branches.map(branch => ({
      roleId, branchObjective: branch.objective, expectedArtifacts: branch.expectedArtifacts,
      acceptance: branch.acceptance, cognitiveTier: 'execution',
      routingStrategy: 'configured-role-model-or-tools',
      dependsOn: branch.dependsOn ?? [], budgetTokens: 2000,
      providerId: 'fixture', model: 'fixture-model',
    })),
    formula: 'test', estimates: {
      soloCostUsd: 0.04, teamCostUsd: 0.04, coordinationCostUsd: 0,
      soloNetBenefitUsd: 0.96, teamNetBenefitUsd: 0.96, marginalNetBenefitUsd: 0,
      qualityGain: 0, latencyGainMs: 0, riskReduction: 0,
      soloTokens: 4000, teamTokens: 4000, coordinationTokens: 0, roi: 24,
    },
    sharedMemoryRefs: [], reason: 'test', status: 'active', createdAt: Date.now(),
  };
}

function addSocietyRun(store: Store, input: {
  workOrderId: string;
  contractId: string;
  roleId: string;
  objective: string;
  toolNames?: string[];
}): RunRecord {
  const session = store.createSession('fixture-model', 'fixture');
  const id = randomUUID();
  const now = Date.now();
  const run: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId: 'default', depth: 0, status: 'queued',
    objective: input.objective, providerId: 'fixture', model: 'fixture-model',
    authorization: { workspace: process.cwd(), profile: 'developer', readOnly: false, revision: 0 },
    toolNames: input.toolNames,
    workOrderId: input.workOrderId, assignmentContractId: input.contractId,
    organizationRoleId: input.roleId,
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now,
    requestFingerprint: randomUUID(), budgetPolicy: 'enforce', budgetUsd: 0.02, budgetTokens: 2000,
  };
  return run;
}

describe('AI labor organization', () => {
  test('schema 10 migration installs organization and versioned society tables while preserving existing data', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-org-migration-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    let store = new Store(file);
    const session = store.createSession('fixture-model', 'fixture');
    const run = addRun(store);
    store.close();

    const raw = new Database(file);
    raw.exec(`
      DROP TABLE organization_proposals_v1;
      DROP TABLE organization_exceptions_v1;
      DROP TABLE organization_receipts_v1;
      DROP TABLE organization_ledger_v1;
      DROP TABLE organization_contracts_v1;
      DROP TABLE organization_team_cycles_v1;
      DROP TABLE organization_roles_v1;
      DROP TABLE organization_work_orders_v1;
    `);
    raw.pragma('user_version = 10');
    raw.close();

    store = new Store(file);
    try {
      assert.equal(store.schemaVersion, 15);
      assert.equal(store.getSession(session.id)?.id, session.id);
      assert.equal(store.runs.get(run.id, 'default')?.id, run.id);
      assert.doesNotThrow(() => store.organization.listWorkOrders('default'));
    } finally {
      store.close();
    }
  });

  test('runtime role binding does not advance governance revision or enter version snapshots', () => {
    const store = new Store(':memory:');
    try {
      const organization = new OrganizationService({ store });
      const role = addRole(store);
      const initial = organization.roleHistory(role.id, 'default');
      const bound = store.organization.updateRole(role, {
        authority: { ...role.authority, workspace: process.cwd() },
        executionSessionId: 'runtime-session',
      }, role.revision, { trackVersion: false });

      assert.equal(bound.revision, initial.role.revision);
      assert.equal(organization.roleHistory(role.id, 'default').versions.length, 1);
      const snapshot = organization.roleHistory(role.id, 'default').versions[0]!.record as unknown as Record<string, unknown>;
      assert.equal('authority' in snapshot, false);
      assert.equal('executionSessionId' in snapshot, false);

      const updated = organization.updateRole(role.id, 'default', bound.revision, {
        budgetLimitUsd: 2,
      }, '运行时绑定后更新治理预算');
      assert.equal(updated.revision, bound.revision + 1);
      assert.equal(organization.roleHistory(role.id, 'default').versions[0]?.version, 2);
    } finally {
      store.close();
    }
  });

  test('organization versions allow exactly one active row per subject', () => {
    const store = new Store(':memory:');
    try {
      const active = new OrganizationService({ store }).ensureEvaluation('default');
      assert.throws(() => store.organization.createOrganizationVersion({
        ...active,
        id: randomUUID(),
        version: active.version + 100,
      }));
      assert.equal(
        store.organization.activeOrganizationVersion('evaluation', 'default', 'default')?.version,
        active.version,
      );
    } finally {
      store.close();
    }
  });

  test('solo work creates one contract and delegation requires a team contract', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '整理会议材料' });
      const order = organization.createForRun(run);
      const contracts = store.organization.contracts(order.id, 'default');
      assert.equal(contracts.length, 1);
      assert.equal(contracts[0].runId, run.id);
      assert.equal(contracts[0].status, 'active');
      const names = organization.authorizeTools(run, [
        tool('role_directory'), tool('team_create'), tool('run_subagent'), tool('run_parallel'),
        tool('read_file'), tool('write_file'),
      ]).map(item => item.name);
      assert.deepEqual(names.sort(), ['read_file', 'role_directory', 'write_file']);

      const negated = addRun(store, { objective: '只回答 2+2=4，不要创建团队，也不要调用组织工具。' });
      organization.createForRun(negated);
      const negatedNames = organization.authorizeTools(negated, [
        tool('role_directory'), tool('team_create'), tool('role_scorecard'), tool('read_file'),
      ]).map(item => item.name);
      assert.deepEqual(negatedNames.sort(), ['read_file', 'role_directory']);
    } finally {
      store.close();
    }
  });

  test('persistent branch roles preserve coordinator authority and enforce child authority', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请两个角色分别并行分析独立资料' });
      store.runs.update(run, { authorization: { ...run.authorization, profile: 'developer' } });
      organization.createForRun(run);
      const before = structuredClone(run.authorization);
      const reader = addRole(store, { workspace: run.authorization.workspace, readOnly: true, profile: 'standard', allowedTools: ['read_file'] });
      const writer = addRole(store, { workspace: run.authorization.workspace, allowedTools: ['write_file'] });
      const team = organization.createTeam(run, { assignments: [
        { roleId: reader.id, objective: '读取A', expectedArtifacts: ['a.md'], acceptance: ['内容准确'], allowedTools: ['read_file'] },
        { roleId: writer.id, objective: '交付B', expectedArtifacts: ['b.md'], acceptance: ['文件存在'], allowedTools: ['write_file'] },
      ] });
      assert.deepEqual(run.authorization, before);
      assert.equal(run.toolNames, undefined);
      assert.equal(store.runs.get(run.id, 'default')!.toolNames, undefined);
      assert.ok(organization.authorizeTools(run, [tool('run_parallel')]).some(item => item.name === 'run_parallel'));
      assert.deepEqual(team.contracts.map(contract => contract.allowedTools), [['read_file'], ['write_file']]);
      const child = addChild(store, run, '读取A');
      organization.prepareDelegation(run, child, { objective: child.objective, assignmentContractId: team.contracts[0].id });
      assert.equal(child.authorization.readOnly, true);
      assert.equal(child.authorization.profile, 'standard');
      assert.deepEqual(child.toolNames, ['read_file']);
    } finally { store.close(); }
  });

  test('root Run returns a partial work receipt when planned branches never start', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, {
        objective: '使用团队整理两个独立来源',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      const order = organization.createForRun(run);
      addTeam(organization, run);
      store.runs.update(run, { status: 'completed', answer: '团队已建立，但分支未执行' });
      const receipt = organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(receipt?.workOrderId, order.id);
      assert.equal(receipt?.status, 'partial');
      assert.match(receipt?.unfinished.join('\n') ?? '', /组织分支未完成/);
      assert.equal(store.organization.getWorkOrder(order.id, 'default')?.status, 'partial');
      assert.equal(store.organization.contracts(order.id, 'default').filter(item => item.status === 'proposed').length, 2);
    } finally {
      store.close();
    }
  });

  test('an empty artifact set cannot satisfy a contract with expected artifacts', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, {
        objective: '请组织团队并行整理两份资料',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      const child = addChild(store, run, team.contracts[0]!.branchObjective);
      organization.prepareDelegation(run, child, {
        objective: child.objective,
        assignmentContractId: team.contracts[0]!.id,
      });
      store.runs.update(child, { status: 'completed', answer: '没有生成文件' });
      const delivered = organization.deliver(child.id, 'default', { summary: '没有生成文件' });

      assert.equal(delivered.status, 'failed');
      assert.equal(delivered.delivery?.artifacts.length, 0);
      assert.equal(
        delivered.delivery?.unfinished.includes('缺少预期产物：analysis-a.md'),
        true,
        JSON.stringify(delivered.delivery),
      );
    } finally {
      store.close();
    }
  });

  test('society assignments cannot create teams or delegate additional roles', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const parent = addRun(store, {
        objective: '使用团队整理两个独立来源',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      organization.createForRun(parent);
      const team = addTeam(organization, parent);
      const assignment = addChild(store, parent, '独立执行社会分工');
      const persisted = store.runs.get(assignment.id, 'default')!;
      store.runs.update(persisted, {
        origin: {
          kind: 'society',
          societyTaskId: 'society-task',
          scheduleId: 'society-schedule',
          assignmentContractId: team.contracts[0]!.id,
        },
        teamCycleId: team.teamCycle.id,
        workOrderId: team.contracts[0]!.workOrderId,
        assignmentContractId: team.contracts[0]!.id,
        organizationRoleId: team.contracts[0]!.roleId,
      });
      const run = store.runs.get(assignment.id, 'default')!;
      assert.deepEqual(
        organization.authorizeTools(run, [
          tool('read_file'),
          tool('run_subagent'),
          tool('run_parallel'),
          tool('run_review'),
          tool('team_create'),
          tool('work_contract_deliver'),
        ]).map(item => item.name),
        ['read_file'],
      );
      assert.throws(
        () => organization.createTeam(run, { assignments: [] }),
        (error: unknown) => error instanceof OrganizationError && error.code === 'ROLE_AUTHORITY_EXCEEDED',
      );
      assert.throws(
        () => organization.prepareDelegation(run, addChild(store, parent, '越权分支'), {
          objective: '越权分支',
          tools: 'read',
          assignmentContractId: team.contracts[0]!.id,
        }),
        (error: unknown) => error instanceof OrganizationError && error.code === 'ROLE_AUTHORITY_EXCEEDED',
      );
    } finally {
      store.close();
    }
  });

  test('team creation requires independent branches and unlocks delegation only after cost gate', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行整理两份独立资料', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const before = organization.authorizeTools(run, [tool('team_create'), tool('run_subagent')]).map(item => item.name);
      assert.deepEqual(before, ['team_create']);

      assert.throws(() => organization.createTeam(run, {
        assignments: [{ objective: '重复', expectedArtifacts: ['same.md'], acceptance: ['可检查'], budgetUsd: 0.02 }],
      }), (error: unknown) => error instanceof OrganizationError && error.code === 'TEAM_NOT_ELIGIBLE');

      const team = addTeam(organization, run);
      assert.equal(team.contracts.length, 2);
      const after = organization.authorizeTools(run, [
        tool('team_create'), tool('run_subagent'), tool('run_parallel'), tool('work_contract_deliver'),
      ]).map(item => item.name);
      assert.equal(after.includes('run_subagent'), true);
      assert.equal(after.includes('run_parallel'), true);
      assert.equal(after.includes('team_create'), false);
    } finally {
      store.close();
    }
  });

  test('team estimates ignore caller claims and unknown pricing remains optional', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, {
        objective: '分别整理两份资料并生成两个文件',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      organization.createForRun(run);
      const assignments = [
        {
          objective: '整理资料 A', expectedArtifacts: ['a.md'],
          acceptance: ['内容可核对'], budgetUsd: 0.02,
        },
        {
          objective: '整理资料 B', expectedArtifacts: ['b.md'],
          acceptance: ['内容可核对'], budgetUsd: 0.02,
        },
      ];
      const automatic = organization.createTeam(run, { assignments, singleAgentEstimateUsd: 1, teamEstimateUsd: 0.000001 });
      assert.ok(automatic.teamCycle.teamEstimateUsd! > 0.000001);

      const humanRun = addRun(store, {
        objective: '请组织团队并行整理两批资料',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      organization.createForRun(humanRun);
      const team = organization.createTeam(humanRun, {
        assignments,
        singleAgentEstimateUsd: 0.000001,
        teamEstimateUsd: 0.000001,
      });
      assert.ok(team.teamCycle.teamEstimateUsd! > 0.000001);
      assert.ok(team.teamCycle.soloEstimateUsd! > 0.000001);

      store.upsertProvider({
        id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1',
        apiKey: '', model: 'fixture-model', priceIn: undefined, priceOut: undefined,
      });
      const missingPriceRun = addRun(store, {
        objective: '请组织团队并行整理价格检查',
        budgetUsd: 0.1,
        budgetPolicy: 'enforce',
      });
      organization.createForRun(missingPriceRun);
      const unknown = organization.createTeam(missingPriceRun, { assignments: assignments.map(({ budgetUsd: _budget, ...draft }) => draft) });
      assert.equal(unknown.teamCycle.teamEstimateUsd, undefined);
      assert.equal(unknown.contracts[0].budgetUsd, 0.1);
      const ordinary = addRun(store, { objective: '请组织团队并行处理两份独立资料' });
      organization.createForRun(ordinary);
      assert.equal(organization.teamPlanningEligible(ordinary), true);
      assert.equal(organization.createTeam(ordinary, { assignments: assignments.map(({ budgetUsd: _budget, ...draft }) => draft) }).teamCycle.hardBudget, false);
    } finally {
      store.close();
    }
  });

  test('team branches cannot expose or start nested delegation', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行完成两个分支', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      const child = addChild(store, run, '执行第一个分支');
      organization.prepareDelegation(run, child, {
        objective: '执行第一个分支',
        tools: 'read',
        assignmentContractId: team.contracts[0]!.id,
      });
      const currentChild = store.runs.get(child.id, 'default')!;
      assert.deepEqual(
        organization.authorizeTools(currentChild, [tool('run_subagent'), tool('run_parallel'), tool('run_review')]),
        [],
      );
      const grandchild = addChild(store, currentChild, '尝试再次委派');
      assert.throws(
        () => organization.prepareDelegation(currentChild, grandchild, {
          objective: '尝试再次委派',
          tools: 'read',
          assignmentContractId: team.contracts[1]!.id,
        }),
        (error: unknown) => error instanceof OrganizationError && error.code === 'TEAM_NOT_ELIGIBLE',
      );
    } finally {
      store.close();
    }
  });

  test('automatic verification failure cannot become a delivered contract', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      for (const verification of [
        { type: 'task_partial' as const, status: 'partial' as const },
        { type: 'task_failed' as const, status: 'failed' as const },
      ]) {
        const run = addRun(store, { objective: '请组织团队并行完成两个分支', budgetUsd: 0.1, budgetPolicy: 'enforce' });
        organization.createForRun(run);
        const team = addTeam(organization, run);
        const child = addChild(store, run, `执行${verification.type}分支`);
        organization.prepareDelegation(run, child, {
          objective: `执行${verification.type}分支`,
          tools: 'read',
          assignmentContractId: team.contracts[0]!.id,
        });
        store.runs.update(child, {
          status: 'completed',
          answer: '结果未通过验收',
          verification: {
            type: verification.type,
            status: verification.status,
            checks: [{ ok: false, reason: '未通过验收' }],
          },
        });
        const delivered = organization.deliver(child.id, 'default', { summary: '分支结束' });
        assert.equal(delivered.status, 'failed');
        assert.equal(delivered.delivery?.unfinished.includes('未通过验收'), true);
      }
    } finally {
      store.close();
    }
  });

  test('root-wide tasks can grant available tools while narrowed tasks cannot expand authority', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const wide = addRun(store, { objective: '请组织团队并行整理两份资料', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(wide);
      const team = addTeam(organization, wide, 'role_directory');
      assert.deepEqual(team.contracts.map(contract => contract.allowedTools), [
        ['role_directory'], ['role_directory'],
      ]);

      const narrowed = addRun(store, { objective: '请组织团队并行核对两份资料', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      store.runs.update(narrowed, { toolNames: ['read_file'] });
      const current = store.runs.get(narrowed.id, narrowed.tenantId)!;
      organization.createForRun(current);
      assert.throws(() => addTeam(organization, current, 'role_directory'),
        (error: unknown) => error instanceof OrganizationError && error.code === 'ROLE_AUTHORITY_EXCEEDED');
    } finally {
      store.close();
    }
  });

  test('delegation enforces role authority and contract budget', async () => {
    const store = new Store(':memory:');
    store.upsertProvider({
      id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1',
      apiKey: '', model: 'fixture-model', priceIn: 1, priceOut: 2,
    });
    const provider: ProviderDef = {
      id: 'fixture', label: 'Fixture', defaultModel: 'fixture-model',
      async *chat() {},
    };
    let options: RunOptions | undefined;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const runner: AgentLoop = {
      approveApproval: () => false,
      async *run(runOptions) {
        if (!runOptions.parentRunId) {
          options = runOptions;
          entered();
          await proceed;
          yield { type: 'assistant_done', content: '协调完成', reasoning: '', usage: { input: 2, output: 1 }, cost: 0 };
        } else {
          yield { type: 'assistant_done', content: '分支完成', reasoning: '', usage: { input: 2, output: 1 }, cost: 0 };
        }
      },
    };
    const organization = new OrganizationService({ store });
    const service = new RunService({
      store, organization, runner: () => runner, tools: () => [tool('read_file'), tool('write_file')],
      workspace: () => process.cwd(), provider: () => ({ id: 'fixture', model: 'fixture-model' }),
      prepare: () => ({ provider, model: 'fixture-model', messages: [], traceId: '' }),
    });
    try {
      const session = store.createSession('fixture-model', 'fixture');
      const run = service.create(session, {
        message: '请组织团队并行完成两个分支',
        budgetUsd: 0.1,
        budgetTokens: 1_000,
        budgetPolicy: 'enforce',
      });
      await started;
      const team = addTeam(organization, run);
      const first = store.organization.updateContract(
        team.contracts[0]!,
        { budgetTokens: 400 },
        team.contracts[0]!.revision,
      );

      await assert.rejects(
        options!.delegate!({ objective: '越过分工预算', assignmentContractId: first.id, budgetUsd: 0.03 }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TEAM_BUDGET_INSUFFICIENT',
      );
      await assert.rejects(
        options!.delegate!({ objective: '越过分工 token 预算', assignmentContractId: first.id, budgetTokens: 401 }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TEAM_BUDGET_INSUFFICIENT',
      );
      const result = await options!.delegate!({ objective: '执行第一个分支', assignmentContractId: first.id });
      assert.equal(result.error, undefined);
      const child = store.runs.children(run.id, 'default')[0];
      assert.equal(child.status, 'completed');
      assert.equal(child.answer, '分支完成');
      assert.deepEqual(store.organization.getContract(first.id, 'default')?.coordinatorArtifacts, ['analysis-a.md']);
      assert.equal(child.budgetUsd, 0.02);
      assert.equal(child.budgetTokens, 400);
      assert.deepEqual(child.toolNames, ['read_file']);

      store.runs.update(run, { cost: 0.085 });
      await assert.rejects(
        options!.delegate!({ objective: '启动新分支', assignmentContractId: team.contracts[1].id }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TEAM_BUDGET_INSUFFICIENT',
      );
      release();
      await service.shutdown();
    } finally {
      release?.();
      await service.shutdown();
      store.close();
    }
  });

  test('scorecards and receipts use contract facts, preserve branch artifacts, and keep unknown usage unknown', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行交付两份报告', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      for (const [index, contract] of team.contracts.entries()) {
        const child = addChild(store, run, contract.branchObjective);
        organization.prepareDelegation(run, child, {
          objective: child.objective, assignmentContractId: contract.id, allowedTools: contract.allowedTools,
        });
        const ref = `outputs/${run.id}/analysis-${String.fromCharCode(97 + index)}.md`;
        store.runs.startTool(child.id, `artifact-${index}`, 'write_file', '{}', { version: '1.0.0', sideEffect: 'write' });
        store.runs.finishTool(child.id, `artifact-${index}`, {
          ok: true, data: {}, evidence: [{ artifact: true, kind: 'file', label: `报告 ${index + 1}`, ref }],
        });
        store.runs.startTool(child.id, `read-${index}`, 'read_document_content', '{"id":"shared"}', {
          version: '1.0.0', sideEffect: 'read',
        });
        store.runs.finishTool(child.id, `read-${index}`, { ok: true, data: {} });
        store.runs.update(child, { status: 'completed', answer: `报告 ${index + 1} 完成`, usageStatus: 'unknown' });
        organization.finalizeRun(store.runs.get(child.id, 'default')!);
      }
      store.runs.update(run, { status: 'completed', answer: '两份报告已合并交付', cost: 0.02, usageStatus: 'unknown' });
      const receipt = organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(receipt?.status, 'completed');
      assert.equal(receipt?.artifacts.length, 2);
      assert.equal(receipt?.usageKnown, false);
      assert.equal(receipt?.cacheSavingsUsd, undefined);
      const detail = organization.detail(organization.workOrderForRun(run).id, 'default');
      assert.equal(detail.teamCycles.at(-1)?.status, 'completed');
      const tempCard = detail.scorecards.find(card => card.roleId === team.contracts[0].roleId)!;
      assert.equal(tempCard.sampleSize, 1);
      assert.equal(tempCard.confidence, 'insufficient');
      assert.equal(tempCard.completionRate, 1);
      assert.equal(tempCard.evidenceCompleteness, 1);
      assert.equal(tempCard.budgetCompliance, 1);
      assert.equal(detail.economics.duplicateEvidenceReads, 1);
    } finally {
      store.close();
    }
  });

  test('society contracts use runtime authority, enforce dependencies, and finalize without a root Run', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({
      store,
      runtimeAuthority: () => ({
        workspace: process.cwd(), readOnly: false, profile: 'standard',
        allowedTools: ['read_file'],
      }),
    });
    try {
      const role = addRole(store);
      const task = societyTask();
      const schedule = societySchedule(task, role.id);
      store.organization.createSocietyTask(task);
      store.organization.createSocietySchedule(schedule);
      const plan = organization.createSocietyExecution(task, schedule);
      assert.equal(plan.workOrder.rootRunId, undefined);
      assert.equal(plan.contracts[1]?.dependsOn[0], plan.contracts[0]?.id);
      assert.deepEqual(store.organization.getRole(role.id, 'default')?.authority, {
        workspace: process.cwd(), readOnly: false, profile: 'standard', allowedTools: ['read_file'],
      });

      const first = addSocietyRun(store, {
        workOrderId: plan.workOrder.id, contractId: plan.contracts[0]!.id,
        roleId: role.id, objective: plan.contracts[0]!.branchObjective, toolNames: ['read_file', 'write_file'],
      });
      organization.prepareSocietyRun(first, plan.contracts[0]!.id);
      assert.deepEqual(first.toolNames, ['read_file']);
      assert.equal(first.authorization.profile, 'standard');
      assert.match(first.cachePrefixHash ?? '', /^[a-f0-9]{64}$/);
      store.runs.create(first);
      store.runs.startTool(first.id, 'source', 'write_file', '{}', { version: '1.0.0', sideEffect: 'write' });
      store.runs.finishTool(first.id, 'source', {
        ok: true, data: {}, evidence: [{ artifact: true, kind: 'file', label: '来源', ref: 'outputs/source.md' }],
      });
      store.runs.update(first, { status: 'completed', answer: '来源已读取', usageStatus: 'reported' });
      assert.equal(organization.finalizeRun(store.runs.get(first.id, 'default')!), undefined);
      assert.equal(store.organization.getContract(plan.contracts[0]!.id, 'default')?.status, 'delivered');

      const second = addSocietyRun(store, {
        workOrderId: plan.workOrder.id, contractId: plan.contracts[1]!.id,
        roleId: role.id, objective: plan.contracts[1]!.branchObjective, toolNames: ['read_file'],
      });
      organization.prepareSocietyRun(second, plan.contracts[1]!.id);
      assert.equal(second.cachePrefixHash, first.cachePrefixHash);
      store.runs.create(second);
      store.runs.startTool(second.id, 'summary', 'write_file', '{}', { version: '1.0.0', sideEffect: 'write' });
      store.runs.finishTool(second.id, 'summary', {
        ok: true, data: {}, evidence: [{ artifact: true, kind: 'file', label: '汇总', ref: 'outputs/summary.md' }],
      });
      store.runs.update(second, { status: 'completed', answer: '汇总已交付', usageStatus: 'reported', tokensIn: 10, tokensOut: 5 });
      const receipt = organization.finalizeRun(store.runs.get(second.id, 'default')!);
      assert.equal(receipt?.status, 'awaiting_acceptance');
      assert.equal(receipt?.artifacts.length, 2);
      assert.equal(receipt?.humanAcceptedAt, undefined);
      assert.equal(store.organization.getWorkOrder(plan.workOrder.id, 'default')?.status, 'awaiting_acceptance');
      const reviewed = organization.reviewWorkOrder(plan.workOrder.id, 'default', 'completed', '人工验收通过');
      assert.equal(reviewed.status, 'completed');
      assert.ok(reviewed.humanAcceptedAt);
      assert.equal(store.organization.getWorkOrder(plan.workOrder.id, 'default')?.status, 'completed');
      assert.deepEqual(
        organization.detail(plan.workOrder.id, 'default').ledger.slice(-2).map(item => item.type),
        ['reviewed', 'closed'],
      );
      assert.equal(organization.workOrderForRun(second).id, plan.workOrder.id);
    } finally {
      store.close();
    }
  });

  test('human rejection is immutable when a late finalizer runs again', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({
      store,
      runtimeAuthority: () => ({
        workspace: process.cwd(), readOnly: false, profile: 'developer',
        allowedTools: ['read_file'],
      }),
    });
    try {
      const role = addRole(store);
      const task = societyTask();
      const schedule = societySchedule(task, role.id);
      store.organization.createSocietyTask(task);
      store.organization.createSocietySchedule(schedule);
      const plan = organization.createSocietyExecution(task, schedule);
      let latest: RunRecord | undefined;
      for (const [index, contract] of plan.contracts.entries()) {
        const run = addSocietyRun(store, {
          workOrderId: plan.workOrder.id, contractId: contract.id, roleId: role.id,
          objective: contract.branchObjective, toolNames: ['read_file'],
        });
        organization.prepareSocietyRun(run, contract.id);
        store.runs.create(run);
        addArtifact(store, run, `review-artifact-${index}`, contract.expectedArtifacts[0]!);
        store.runs.update(run, { status: 'completed', answer: '分支完成', usageStatus: 'reported' });
        latest = store.runs.get(run.id, 'default')!;
        organization.finalizeRun(latest);
      }

      const pending = store.organization.receipt(plan.workOrder.id, 'default')!;
      assert.equal(pending.status, 'awaiting_acceptance');
      const rejected = organization.reviewWorkOrder(plan.workOrder.id, 'default', 'failed', '关键来源不完整');
      assert.equal(rejected.status, 'failed');
      assert.ok(rejected.humanReviewedAt);
      assert.equal(rejected.humanAcceptedAt, undefined);

      const late = organization.finalizeRun(latest!);
      assert.equal(late?.status, 'failed');
      assert.equal(late?.humanReviewedAt, rejected.humanReviewedAt);
      assert.equal(store.organization.getWorkOrder(plan.workOrder.id, 'default')?.status, 'failed');
      assert.ok(store.organization.societyAudits('default').some(entry =>
        entry.action === 'human_rejected' && entry.workOrderId === plan.workOrder.id));
    } finally {
      store.close();
    }
  });

  test('society contracts cannot start before dependencies deliver and cannot expand role tools', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({
      store,
      runtimeAuthority: () => ({
        workspace: process.cwd(), readOnly: false, profile: 'standard',
        allowedTools: ['read_file'],
      }),
    });
    try {
      const role = addRole(store);
      const task = societyTask();
      const schedule = societySchedule(task, role.id);
      store.organization.createSocietyTask(task);
      store.organization.createSocietySchedule(schedule);
      const plan = organization.createSocietyExecution(task, schedule);
      const second = addSocietyRun(store, {
        workOrderId: plan.workOrder.id, contractId: plan.contracts[1]!.id,
        roleId: role.id, objective: plan.contracts[1]!.branchObjective, toolNames: ['read_file'],
      });
      assert.throws(
        () => organization.prepareSocietyRun(second, plan.contracts[1]!.id),
        (error: unknown) => error instanceof OrganizationError && error.code === 'WORK_LEDGER_CONFLICT',
      );

      const contract = store.organization.getContract(plan.contracts[1]!.id, 'default')!;
      store.organization.updateContract(contract, { allowedTools: ['write_file'] }, contract.revision);
      store.organization.updateContract(
        store.organization.getContract(plan.contracts[0]!.id, 'default')!,
        { status: 'delivered', delivery: {
          summary: '已交付', artifacts: ['outputs/source.md'], evidence: [],
          unfinished: [], costUsd: 0, usageKnown: true,
        } },
        store.organization.getContract(plan.contracts[0]!.id, 'default')!.revision,
      );
      assert.throws(
        () => organization.prepareSocietyRun(second, plan.contracts[1]!.id),
        (error: unknown) => error instanceof OrganizationError && error.code === 'ROLE_AUTHORITY_EXCEEDED',
      );
    } finally {
      store.close();
    }
  });

  test('terminal facts, not a human summary, decide completion and repeated finalization stays idempotent', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '读取资料', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      const order = organization.createForRun(run);
      store.runs.update(run, {
        status: 'failed', error: '来源文件损坏', answer: '人工填写：看起来已经完成',
      });
      const receipt = organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(receipt?.status, 'failed');
      assert.match(receipt?.unfinished.join('\n') ?? '', /来源文件损坏/);
      organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(store.organization.ledger(order.id, 'default').filter(item => item.type === 'closed').length, 1);
      assert.equal(store.organization.getContract(
        store.organization.contracts(order.id, 'default')[0]!.id, 'default',
      )?.status, 'failed');
    } finally {
      store.close();
    }
  });

  test('exceptions separate fact recovery from human authority and isolate tenants', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store);
      const order = organization.createForRun(run);
      const budget = organization.raiseException({
        tenantId: 'default', workOrderId: order.id, kind: 'budget',
        summary: '需要增加预算', facts: ['已用预算达到上限'],
      });
      const toolFailure = organization.raiseException({
        tenantId: 'default', workOrderId: order.id, kind: 'tool-failure',
        summary: '读取暂时失败', facts: ['工具返回可重试错误'],
      });
      assert.equal(budget.requiresHuman, true);
      assert.equal(budget.status, 'waiting_human');
      assert.equal(toolFailure.requiresHuman, false);
      assert.equal(toolFailure.status, 'auto_resolved');
      assert.equal(store.organization.getException(budget.id, 'other-tenant'), undefined);
      const role = store.organization.listRoles('default').find(item => !item.persistent);
      assert.equal(role, undefined);
    } finally {
      store.close();
    }
  });

  test('temporary roles become persistent only through explicit human confirmation', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行分析', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      const temporary = store.organization.getRole(team.contracts[0].roleId, 'default')!;
      assert.equal(temporary.persistent, false);
      assert.throws(
        () => organization.confirmPersistentRole(temporary.id, 'other-tenant'),
        (error: unknown) => error instanceof OrganizationError && error.code === 'ROLE_NOT_FOUND',
      );
      const confirmed = organization.confirmPersistentRole(temporary.id, 'default');
      assert.equal(confirmed.persistent, true);
      assert.equal(confirmed.projectId, '');
      assert.equal(confirmed.source, 'human');
    } finally {
      store.close();
    }
  });

  test('two failed branches collapse new work back to solo while retaining facts', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行执行', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      for (const contract of team.contracts) {
        const child = addChild(store, run, contract.branchObjective);
        organization.prepareDelegation(run, child, { objective: child.objective, assignmentContractId: contract.id });
        store.runs.update(child, { status: 'failed', error: '连续无有效进展' });
        organization.finalizeRun(store.runs.get(child.id, 'default')!);
      }
      const collapsed = organization.collapseToSolo(store.runs.get(run.id, 'default')!, '连续两个分支失败');
      assert.equal(collapsed?.status, 'partial');
      assert.equal(store.runs.get(run.id, 'default')?.fallbackReason, 'ROLLBACK_TO_SOLO');
      const firstHandoff = organization.soloTakeoverContract(store.runs.get(run.id, 'default')!, '第一个分支失败');
      const duplicateHandoff = organization.soloTakeoverContract(store.runs.get(run.id, 'default')!, '第二个分支失败');
      assert.equal(firstHandoff.contractId, duplicateHandoff.contractId);
      assert.deepEqual(firstHandoff.expectedArtifacts.sort(), ['analysis-a.md', 'analysis-b.md']);
      addArtifact(store, store.runs.get(run.id, 'default')!, 'takeover-a', 'analysis-a.md');
      addArtifact(store, store.runs.get(run.id, 'default')!, 'takeover-b', 'analysis-b.md');
      store.runs.update(store.runs.get(run.id, 'default')!, {
        status: 'completed',
        answer: '已由单角色合并失败分支后的有效结果',
      });
      const receipt = organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(receipt?.status, 'completed');
      assert.equal(store.organization.getTeamCycle(team.teamCycle.id, 'default')?.status, 'partial');
      assert.equal(team.contracts.every(contract =>
        store.organization.getContract(contract.id, 'default')?.status === 'collapsed'), true);
      const ledger = store.organization.ledger(organization.workOrderForRun(run).id, 'default');
      assert.ok(ledger.some(entry => entry.summary.includes('回退单角色')));
      assert.equal(ledger.filter(entry => entry.type === 'handoff').length, 1);
      assert.ok(store.organization.societyAudits('default').some(entry =>
        entry.action === 'fallback_solo' && entry.workOrderId === organization.workOrderForRun(run).id));
    } finally {
      store.close();
    }
  });

  test('society audit rows are append-only, idempotent, and isolated by tenant', () => {
    const store = new Store(':memory:');
    try {
      const entry = {
        id: 'society-audit-1', tenantId: 'default', taskId: 'task-1',
        scheduleId: 'schedule-1', workOrderId: 'order-1', action: 'queued' as const,
        actorId: 'maharness', reason: '排队等待', details: { queuePosition: 1 },
        idempotencyKey: 'queued:task-1:1', createdAt: Date.now(),
      };
      assert.ok(store.organization.appendSocietyAudit(entry));
      assert.equal(store.organization.appendSocietyAudit(entry), undefined);
      const db = (store as unknown as { db: {
        prepare(sql: string): { run(...args: unknown[]): void };
      } }).db;
      assert.throws(
        () => db.prepare('UPDATE organization_society_audit_v1 SET reason=? WHERE id=?')
          .run('篡改', entry.id),
        /append-only/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM organization_society_audit_v1 WHERE id=?').run(entry.id),
        /append-only/,
      );
      assert.equal(store.organization.societyAudits('default').length, 1);
      assert.equal(store.organization.societyAudits('other-tenant').length, 0);
    } finally {
      store.close();
    }
  });

  test('solo takeover without the promised artifacts cannot report completion', () => {
    const store = new Store(':memory:');
    const organization = new OrganizationService({ store });
    try {
      const run = addRun(store, { objective: '请组织团队并行执行', budgetUsd: 0.1, budgetPolicy: 'enforce' });
      organization.createForRun(run);
      const team = addTeam(organization, run);
      for (const contract of team.contracts) {
        const child = addChild(store, run, contract.branchObjective);
        organization.prepareDelegation(run, child, { objective: child.objective, assignmentContractId: contract.id });
        store.runs.update(child, { status: 'failed', error: '分支失败' });
        organization.finalizeRun(store.runs.get(child.id, 'default')!);
      }
      organization.collapseToSolo(store.runs.get(run.id, 'default')!, '连续两个分支失败');
      organization.soloTakeoverContract(store.runs.get(run.id, 'default')!, '交给单角色接管');
      store.runs.update(store.runs.get(run.id, 'default')!, {
        status: 'completed', answer: '已口头完成',
      });

      const receipt = organization.finalizeRun(store.runs.get(run.id, 'default')!);
      assert.equal(receipt?.status, 'failed');
      assert.match(receipt?.unfinished.join('\n') ?? '', /analysis-a\.md/);
      assert.match(receipt?.unfinished.join('\n') ?? '', /analysis-b\.md/);
      assert.equal(store.organization.getWorkOrder(
        organization.workOrderForRun(run).id, 'default',
      )?.status, 'failed');
    } finally {
      store.close();
    }
  });

  test('duplicate evidence, stalled two-round work and cost loss also collapse teams to solo', () => {
    const scenarios: Array<{
      name: string;
      prepare: (store: Store, organization: OrganizationService, run: RunRecord, team: ReturnType<typeof addTeam>) => void;
    }> = [
      {
        name: '重复证据',
        prepare(store, organization, run, team) {
          const contract = team.contracts[0];
          const child = addChild(store, run, contract.branchObjective);
          organization.prepareDelegation(run, child, {
            objective: child.objective, assignmentContractId: contract.id,
          });
          for (const id of ['read-1', 'read-2']) {
            store.runs.startTool(child.id, id, 'read_file', 'source.md', { sideEffect: 'read' });
            store.runs.finishTool(child.id, id, { ok: true, data: {} });
          }
          store.runs.update(child, { status: 'failed', error: '重复读取同一来源' });
          organization.finalizeRun(store.runs.get(child.id, 'default')!);
        },
      },
      {
        name: '两轮无产物',
        prepare(store, organization, run, team) {
          const completed = addChild(store, run, team.contracts[0].branchObjective);
          organization.prepareDelegation(run, completed, {
            objective: completed.objective, assignmentContractId: team.contracts[0].id,
          });
          store.runs.startTool(completed.id, 'read-a', 'read_file', 'a.md', { sideEffect: 'read' });
          store.runs.finishTool(completed.id, 'read-a', { ok: true, data: {} });
          store.runs.update(completed, { status: 'completed', answer: '没有交付产物' });
          organization.finalizeRun(store.runs.get(completed.id, 'default')!);

          const failed = addChild(store, run, team.contracts[1].branchObjective);
          organization.prepareDelegation(run, failed, {
            objective: failed.objective, assignmentContractId: team.contracts[1].id,
          });
          store.runs.startTool(failed.id, 'read-b', 'read_file', 'b.md', { sideEffect: 'read' });
          store.runs.finishTool(failed.id, 'read-b', { ok: true, data: {} });
          store.runs.update(failed, { status: 'failed', error: '没有有效产物' });
          organization.finalizeRun(store.runs.get(failed.id, 'default')!);
        },
      },
      {
        name: '费用失去收益',
        prepare(store, organization, run, team) {
          const contract = team.contracts[0];
          const child = addChild(store, run, contract.branchObjective);
          organization.prepareDelegation(run, child, {
            objective: child.objective, assignmentContractId: contract.id,
          });
          store.runs.update(child, {
            status: 'failed', error: '预算已耗尽', cost: 0.05, usageStatus: 'reported',
          });
          organization.finalizeRun(store.runs.get(child.id, 'default')!);
        },
      },
    ];

    for (const scenario of scenarios) {
      const store = new Store(':memory:');
      const organization = new OrganizationService({ store });
      try {
        const run = addRun(store, {
          objective: `请组织团队并行执行：${scenario.name}`,
          budgetUsd: 0.1,
          budgetPolicy: 'enforce',
        });
        organization.createForRun(run);
        const team = addTeam(organization, run);
        scenario.prepare(store, organization, run, team);
        const collapsed = organization.collapseToSolo(
          store.runs.get(run.id, 'default')!, scenario.name,
        );
        assert.equal(collapsed?.status, 'partial', scenario.name);
        assert.equal(
          store.runs.get(run.id, 'default')?.fallbackReason,
          'ROLLBACK_TO_SOLO',
          scenario.name,
        );
      } finally {
        store.close();
      }
    }
  });
});
