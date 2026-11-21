import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store } from '../db';
import { OrganizationService } from '../services/organization/service';
import { registerOrganizationRoutes } from '../routes/organization';
import { SocietyService } from '../services/society';

function addKnowledgeRole(store: Store): void {
  const now = Date.now();
  store.organization.createRole({
    id: randomUUID(),
    tenantId: 'default',
    projectId: '',
    name: '研究执行员二',
    responsibilities: ['执行独立研究分支'],
    capabilities: ['research', 'reading', 'analysis'],
    authority: { workspace: '', readOnly: false, profile: 'standard', allowedTools: [] },
    modelPolicy: { providerId: '', model: 'runtime-selected' },
    persistent: true,
    employment: 'active',
    source: 'human',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

test('society experiment HTTP route returns the team comparison and enforces tenancy', async () => {
  const store = new Store(':memory:');
  const organization = new OrganizationService({ store });
  const society = new SocietyService({ store, organization });
  society.ensureInstitution('default');
  addKnowledgeRole(store);

  const task = society.createTask({
    tenantId: 'default',
    objective: '分别核对两份独立资料',
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: [
      {
        objective: '核对资料 A',
        acceptance: ['列出逐条来源'],
        expectedArtifacts: ['source-a.md'],
        departmentId: 'knowledge',
      },
      {
        objective: '核对资料 B',
        acceptance: ['列出逐条来源'],
        expectedArtifacts: ['source-b.md'],
        departmentId: 'knowledge',
      },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { tenantId: req.get('x-maharness-tenant') ?? 'default' });
    next();
  });
  registerOrganizationRoutes(
    app,
    { store, organization, society } as unknown as Parameters<typeof registerOrganizationRoutes>[1],
    {} as Parameters<typeof registerOrganizationRoutes>[2],
  );

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const address = server.address() as { port: number };
  const request = async (
    path: string,
    tenantId = 'default',
    method = 'GET',
    payload?: Record<string, unknown>,
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'x-maharness-tenant': tenantId, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  try {
    const expected = society.experiment(task.id, 'default');
    const result = await request(`/api/organization/society/experiments/${task.id}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, JSON.parse(JSON.stringify(expected)));
    assert.equal(result.body.selected, 'team');
    assert.match(String((result.body.estimate as { formula: string }).formula), /quality.*riskReduction.*estimatedCost.*coordinationCost/);
    assert.ok((result.body.estimate as { marginalNetBenefitUsd: number }).marginalNetBenefitUsd > 0);

    const missing = await request('/api/organization/society/experiments/missing-task');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SOCIETY_TASK_NOT_FOUND');

    assert.equal((await request(`/api/organization/society/experiments/${task.id}`, 'tenant-b')).status, 404);
    assert.equal((await request(`/api/organization/society/experiments/${task.id}`)).status, 200);

    const role = store.organization.listRoles('default', undefined, true)
      .find(item => item.source === 'human')!;
    const roleUpdate = await request(`/api/organization/roles/${role.id}`, 'default', 'PATCH', {
      revision: role.revision,
      patch: { name: '研究执行员（HTTP 版）' },
      reason: '通过 HTTP 发布角色版本',
    });
    assert.equal(roleUpdate.status, 200);
    const roleVersions = await request(`/api/organization/roles/${role.id}/versions`);
    assert.equal(roleVersions.status, 200);
    assert.equal((roleVersions.body.versions as Array<{ version: number }>)[0]?.version, 2);
    const roleRollback = await request(`/api/organization/roles/${role.id}/rollback`, 'default', 'POST', {
      version: 1,
      reason: '通过 HTTP 回滚角色',
    });
    assert.equal(roleRollback.status, 200);
    const roleAudits = await request(`/api/organization/roles/${role.id}/audits`);
    assert.equal((roleAudits.body.audits as Array<{ action: string }>)[0]?.action, 'rollback');

    const initialEvaluation = await request('/api/organization/evaluations');
    assert.equal(initialEvaluation.status, 200);
    assert.equal((initialEvaluation.body.active as { version: number }).version, 1);
    const evaluationUpdate = await request('/api/organization/evaluations', 'default', 'POST', {
      policy: { lowConfidenceSamples: 4, mediumConfidenceSamples: 12, highConfidenceSamples: 40 },
      reason: '通过 HTTP 调整评价标准',
    });
    assert.equal(evaluationUpdate.status, 201);
    assert.equal((evaluationUpdate.body.evaluation as { version: number }).version, 2);
    const evaluationRollback = await request('/api/organization/evaluations/rollback', 'default', 'POST', {
      version: 1,
      reason: '通过 HTTP 回滚评价标准',
    });
    assert.equal(evaluationRollback.status, 200);
    assert.equal((evaluationRollback.body.evaluation as { version: number }).version, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
