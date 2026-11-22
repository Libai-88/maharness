import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  let teamState: 'planned' | 'paused' | 'running' | 'dissolved' = 'planned';
  let exceptionStatus = 'waiting_human';
  let contractRoleId = 'role-1';
  let rolePersistent = false;

  const summary = () => {
    const role = (id: string, name: string, persistent: boolean) => ({
      id,
      projectId: persistent ? '' : 'project-1',
      name,
      responsibilities: [id === 'role-1' ? '整理资料来源' : '核对结构与验收'],
      capabilities: ['资料整理'],
      persistent,
      employment: 'active',
      source: 'human',
      revision: 1,
      budgetLimitUsd: 0.5,
      updatedAt: 2,
    });
    const roles = [role('role-1', '资料分析员', rolePersistent), role('role-2', '结构审校员', true)];
    const contracts = [
      {
        id: 'contract-1',
        workOrderId: 'order-1',
        teamCycleId: 'team-1',
        roleId: contractRoleId,
        runId: 'run-1',
        branchObjective: '整理三个来源的共同结论',
        expectedArtifacts: ['analysis.md'],
        acceptance: [{ statement: '结论带版本化来源' }],
        dependsOn: [],
        budgetUsd: 0.1,
        status: 'delivered',
        delivery: {
          summary: '已整理共同结论并保留来源。',
          artifacts: ['outputs/run-1/analysis.md'],
          evidence: [{ id: 'material:doc:v1', ref: 'doc-v1' }],
          unfinished: [],
          costUsd: 0.04,
          usageKnown: true,
        },
      },
      {
        id: 'contract-2',
        workOrderId: 'order-1',
        teamCycleId: 'team-1',
        roleId: 'role-2',
        branchObjective: '核对交付结构',
        expectedArtifacts: ['review.md'],
        acceptance: [{ statement: '每个结论都有来源' }],
        dependsOn: ['contract-1'],
        budgetUsd: 0.1,
        status: teamState === 'dissolved' ? 'cancelled' : 'proposed',
      },
    ];
    const exception = {
      id: 'exception-1',
      workOrderId: 'order-1',
      contractId: 'contract-2',
      kind: 'budget',
      summary: '核对分支需要追加少量预算',
      facts: ['剩余预算低于分支预期'],
      factRuling: '运行事实已记录，决定超出模型权限',
      requiresHuman: true,
      recovery: '等待人类决定费用',
      status: exceptionStatus,
      updatedAt: 2,
    };
    const receipt = {
      id: 'receipt-1',
      workOrderId: 'order-1',
      status: 'partial',
      answer: '共同结论已交付，结构核对仍在等待裁决。',
      artifacts: ['outputs/run-1/analysis.md'],
      sources: [{ id: 'artifact:analysis', ref: 'outputs/run-1/analysis.md' }],
      contributors: [{ roleId: 'role-1', contractId: 'contract-1', summary: '完成资料整理' }],
      costUsd: 0.04,
      unfinished: ['核对交付结构'],
      exceptions: [exception.summary],
      usageKnown: true,
      updatedAt: 2,
    };
    return {
      schemaVersion: 1,
      today: '2026-11-17',
      todayItems: [],
      overdue: [],
      upcoming: [],
      unscheduled: [],
      pendingAutomations: [],
      automations: [],
      recentRuns: [],
      artifacts: [],
      projects: [{ id: 'project-1', name: '交付项目', stage: '验收', next: '核对来源', blocker: '', status: 'active', updatedAt: 2 }],
      notes: [],
      metrics: {
        schemaVersion: 1,
        firstTaskSuccessRate: null,
        takeoverRate: null,
        recoveredAfterFailureRate: null,
        automaticRecoveryRate: null,
        invalidToolCalls: 0,
        duplicateToolCalls: 0,
        capabilitySelectionFailures: 0,
        durationMs: 1000,
        modelCalls: 1,
        costUsd: 0.04,
        experienceReviewCostUsd: 0,
        experienceReviewCount: 0,
      },
      experience: {
        schemaVersion: 1,
        reviewCount: 0,
        negativeReviews: 0,
        averageScore: null,
        undecidedFindings: 0,
        openFindings: 0,
        findings: [],
        recentReviews: [],
      },
      organization: {
        schemaVersion: 1,
        workOrders: [
          {
            id: 'order-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            rootRunId: 'run-1',
            objective: '整理资料并交付可核对结论',
            budgetUsd: 0.25,
            status: 'active',
            createdAt: 1,
            updatedAt: 2,
            contracts,
            teamCycles: [
              {
                id: 'team-1',
                assignmentIds: ['contract-1', 'contract-2'],
                soloEstimateUsd: 0.3,
                teamEstimateUsd: 0.2,
                status: teamState,
              },
            ],
            roles,
            receipt,
            exceptions: [exception],
            economics: {
              singleAgentEstimateUsd: 0.3,
              teamEstimateUsd: 0.2,
              actualCostUsd: 0.04,
              cacheSavingsUsd: null,
              duplicateEvidenceReads: 0,
              coordinationRounds: 1,
              roi: 0.867,
              usageKnown: true,
            },
            scorecards: roles.map((item) => ({
              roleId: item.id,
              evaluationVersion: 1,
              evaluationHash: 'evaluation-hash-1',
              sampleSize: 1,
              confidence: 'insufficient',
              completionRate: 1,
              acceptanceRate: 1,
              reworkRate: null,
              budgetCompliance: 1,
              recoveryRate: 0,
              evidenceCompleteness: 1,
              reviewConsistency: null,
              costUsd: 0.04,
            })),
            wellbeing: roles.map((item) => ({
              roleId: item.id,
              activeAssignments: 0,
              consecutiveFailures: 0,
              waitingApproval: 0,
              reworkAssignments: 0,
              state: 'ready',
            })),
          },
        ],
        roles,
        scorecards: [],
        wellbeing: [],
        receipts: [receipt],
        exceptions: [exception],
        proposals: [
          {
            id: 'proposal-1',
            workOrderId: 'order-1',
            category: 'cache',
            title: '复用共同资料前缀',
            detail: '两个分支读取同一来源时先建立共享前缀。',
            impact: 'medium',
            status: 'pending',
          },
        ],
      },
    };
  };

  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/sessions')
      return route.fulfill({
        json: [
          {
            id: 'session-1',
            title: '组织交付',
            model: 'fixture-model',
            provider: 'fixture',
            mode: 'normal',
            planPending: 0,
            archived: 0,
            pinned: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });
    if (/\/api\/sessions\/session-1\/messages$/.test(path)) return route.fulfill({ json: [] });
    if (path === '/api/v2/runs') return route.fulfill({ json: [] });
    if (path === '/api/models')
      return route.fulfill({
        json: [
          {
            id: 'fixture@fixture-model',
            provider: 'fixture',
            label: 'Fixture',
            model: 'fixture-model',
          },
        ],
      });
    if (path === '/api/providers')
      return route.fulfill({
        json: [
          {
            id: 'fixture',
            label: 'Fixture',
            baseUrl: 'fixture',
            model: 'fixture-model',
            enabled: true,
            hasKey: true,
            apiKeyMasked: '***',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });
    if (path === '/api/plugins' || path === '/api/plugins/diagnostics') return route.fulfill({ json: [] });
    if (path === '/api/nav') return route.fulfill({ json: { items: [] } });
    if (path === '/api/workbench/summary') return route.fulfill({ json: summary() });
    if (path === '/api/organization/teams/team-1/pause') {
      teamState = 'paused';
      return route.fulfill({ json: { teamCycle: { id: 'team-1', status: teamState }, runIds: [] } });
    }
    if (path === '/api/organization/teams/team-1/resume') {
      teamState = 'running';
      return route.fulfill({ json: { teamCycle: { id: 'team-1', status: teamState }, runIds: [] } });
    }
    if (path === '/api/organization/teams/team-1/dissolve') {
      teamState = 'dissolved';
      return route.fulfill({ json: { teamCycle: { id: 'team-1', status: teamState }, runIds: [] } });
    }
    if (path === '/api/organization/teams/team-1/contracts/contract-2/reassign') {
      contractRoleId = 'role-2';
      return route.fulfill({ json: { contract: { id: 'contract-2', roleId: contractRoleId, status: 'proposed' } } });
    }
    if (path === '/api/organization/roles/role-1/confirm') {
      rolePersistent = true;
      return route.fulfill({ json: { role: { id: 'role-1', persistent: true } } });
    }
    if (path === '/api/organization/exceptions/exception-1/resolve') {
      exceptionStatus = 'resolved';
      return route.fulfill({ json: { exception: { id: 'exception-1', status: exceptionStatus } } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto('/?view=society');
  await expect(page.getByTestId('society-home')).toBeVisible();
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();
  await page.getByRole('button', { name: '交付项目 · 组织详情', exact: true }).click();
  await expect(page.getByRole('heading', { name: '交付项目 · 组织视图' })).toBeVisible();
}

test('项目组织视图展示回执并完成暂停、改派、异常和关闭操作', async ({ page }) => {
  await setup(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('共同结论已交付，结构核对仍在等待裁决。')).toBeVisible();
  await expect(dialog.getByText('1 个来源')).toBeVisible();
  await expect(dialog.getByText('用量未知')).toBeVisible();

  await dialog.getByLabel('异常决定 exception-1').fill('批准少量追加预算');
  await dialog.getByRole('button', { name: '处理', exact: true }).click();
  await expect(dialog.getByText('核对分支需要追加少量预算')).toHaveCount(0);

  await dialog.getByText('角色、契约与履历', { exact: true }).click();
  await expect(dialog.getByText(/履历置信度 insufficient · 样本 1/).first()).toBeVisible();
  await dialog.getByLabel('改派 contract-2').selectOption('role-2');
  await dialog.getByRole('button', { name: '改派', exact: true }).click();
  await dialog.getByRole('button', { name: '确认持久角色', exact: true }).click();

  await dialog.getByRole('button', { name: '暂停新分支', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '解散团队', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '解散团队', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('cancelled', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '交付项目 · 组织视图' })).toHaveCount(0);
  await page.getByRole('button', { name: '交付项目 · 组织详情', exact: true }).click();
  await page.getByRole('button', { name: '打开会话', exact: true }).click();
  await expect(page).toHaveURL(/view=chat/);
  await expect(page.getByPlaceholder('跟 maharness 说点什么…（按 / 看命令）')).toBeVisible();
});
