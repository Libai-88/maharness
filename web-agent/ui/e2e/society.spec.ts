import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

type TaskStatus = 'queued' | 'waiting_approval' | 'scheduled' | 'awaiting_acceptance' | 'completed';
type ScheduleStatus = 'active' | 'completed';

async function setup(page: Page) {
  let institutionVersion = 1;
  let evaluationVersion = 1;
  let evaluationLow = 3;
  let evaluationMedium = 10;
  let evaluationHigh = 30;
  let societyBudgetUsd = 20;
  let tasks: Array<Record<string, unknown> & {
    id: string;
    objective: string;
    valueUsd: number;
    maxBudgetUsd: number;
    approval: string;
    status: TaskStatus;
    lastSchedulingReason: string;
    scheduleId?: string;
  }> = [{
    id: 'task-approval', tenantId: 'default', projectId: '', objective: '高价值资料核验',
    acceptance: ['结论带来源'], materials: [], valueUsd: 30, maxBudgetUsd: 3, priority: 4,
    departmentId: 'knowledge', branches: [
      { objective: '核验来源 A', acceptance: ['逐条来源'], expectedArtifacts: ['a.md'], departmentId: 'knowledge' },
      { objective: '核验来源 B', acceptance: ['逐条来源'], expectedArtifacts: ['b.md'], departmentId: 'knowledge' },
    ],
    approval: 'pending', status: 'waiting_approval', lastSchedulingReason: '等待人类批准高额任务',
    createdAt: 1, updatedAt: 2, revision: 0,
  }];
  let schedules: Array<Record<string, unknown> & {
    id: string;
    taskId: string;
    mode: 'solo' | 'team';
    roleIds: string[];
    runIds: string[];
    status: ScheduleStatus;
  }> = [];
  const audits: Array<Record<string, unknown>> = [{
    id: 'audit-1', version: 1, action: 'initialize', actor: 'maharness',
    toVersion: 1, reason: '初始化本地 AI 社会制度', createdAt: 1,
  }];
  const evaluationAudits: Array<Record<string, unknown>> = [{
    id: 'evaluation-audit-1', tenantId: 'default', kind: 'evaluation', subjectId: 'default',
    version: 1, action: 'initialize', actor: 'maharness', toVersion: 1,
    afterHash: 'evaluation-hash-1', reason: '初始化评价标准', createdAt: 1,
  }];

  const departments = [
    { id: 'operations', name: '综合运营部', charter: '承接办公、文件和轻量自动化交付', capabilities: ['files', 'documents'], quotaUsd: 10, maxConcurrent: 4, priority: 1, enabled: true },
    { id: 'knowledge', name: '知识与研究部', charter: '检索、阅读、归纳和证据整理', capabilities: ['research', 'reading'], quotaUsd: 7, maxConcurrent: 3, priority: 2, enabled: true },
    { id: 'quality', name: '质量与审校部', charter: '独立复核、来源核验和交付验收', capabilities: ['review', 'quality'], quotaUsd: 3, maxConcurrent: 2, priority: 3, enabled: true },
  ];
  const roles = [
    { id: 'role-coordinator', projectId: '', name: '调度协调员', responsibilities: ['按制度调度'], capabilities: ['coordination'], persistent: true, employment: 'active', source: 'builtin', revision: 0, updatedAt: 2 },
    { id: 'role-research', projectId: '', name: '研究执行员', responsibilities: ['形成可核对结论'], capabilities: ['research'], persistent: true, employment: 'active', source: 'builtin', revision: 0, updatedAt: 2 },
    { id: 'role-delivery', projectId: '', name: '交付执行员', responsibilities: ['处理文件'], capabilities: ['files'], persistent: true, employment: 'active', source: 'builtin', revision: 0, updatedAt: 2 },
    { id: 'role-quality', projectId: '', name: '质量审校员', responsibilities: ['独立复核'], capabilities: ['quality'], persistent: true, employment: 'active', source: 'builtin', revision: 0, updatedAt: 2 },
  ];

  const summary = () => {
    const active = schedules.filter(item => item.status === 'active');
    const waiting = tasks.filter(item => item.status === 'waiting_approval');
    const queued = tasks.filter(item => item.status === 'queued');
    return {
      schemaVersion: 1,
      today: '2026-11-17',
      todayItems: [], overdue: [], upcoming: [], unscheduled: [], pendingAutomations: [], automations: [],
      recentRuns: [], artifacts: [],
      projects: [{ id: 'project-1', name: '社会交付项目', stage: '运行', next: '核对结果', blocker: '', status: 'active', updatedAt: 2 }],
      notes: [],
      metrics: {
        schemaVersion: 1, firstTaskSuccessRate: null, takeoverRate: null, recoveredAfterFailureRate: null,
        automaticRecoveryRate: null, invalidToolCalls: 0, duplicateToolCalls: 0, capabilitySelectionFailures: 0,
        durationMs: 0, modelCalls: 0, costUsd: 0, experienceReviewCostUsd: 0, experienceReviewCount: 0,
      },
      experience: {
        schemaVersion: 1, reviewCount: 0, negativeReviews: 0, averageScore: null,
        undecidedFindings: 0, openFindings: 0, findings: [], recentReviews: [],
      },
      organization: {
        schemaVersion: 1,
        workOrders: [{
          id: 'order-1', projectId: 'project-1', sessionId: 'session-1', rootRunId: 'run-1',
          objective: '社会交付项目', status: 'active', createdAt: 1, updatedAt: 2,
          contracts: [], teamCycles: [], roles: [roles[1]],
          exceptions: [],
          economics: {
            singleAgentEstimateUsd: 0.2, teamEstimateUsd: 0.15, actualCostUsd: 0,
            cacheSavingsUsd: null, duplicateEvidenceReads: 0, coordinationRounds: 0,
            roi: null, usageKnown: false,
          },
          scorecards: [{
            roleId: 'role-research', evaluationVersion: 1, evaluationHash: 'evaluation-hash-1',
            sampleSize: 1, confidence: 'insufficient', completionRate: 1,
            acceptanceRate: 1, reworkRate: null, budgetCompliance: 1, recoveryRate: null,
            evidenceCompleteness: 1, reviewConsistency: null, costUsd: 0.02,
          }],
          wellbeing: [{ roleId: 'role-research', activeAssignments: 0, consecutiveFailures: 0, waitingApproval: 0, reworkAssignments: 0, contextPressure: 'normal', state: 'ready' }],
        }],
        roles: [roles[1]], scorecards: [], wellbeing: [], receipts: [], exceptions: [], proposals: [],
      },
      society: {
        schemaVersion: 1,
        institution: {
          id: `institution-${institutionVersion}`, tenantId: 'default', version: institutionVersion,
          status: 'active',
          policies: {
            schemaVersion: 1, societyBudgetUsd, minNetBenefitUsd: 0.01, maxTeamSize: 4,
            welfareMaxActiveAssignments: 2, highSpendApprovalUsd: 2, maxQueuedPerDepartment: 25,
            cognitiveRouting: { decision: 'configured-primary-model', execution: 'configured-role-model-or-tools', utility: 'deterministic-tools' },
            departments,
          },
          hash: `hash-${institutionVersion}`, createdBy: 'human',
          reason: institutionVersion === 1 ? '初始化本地 AI 社会制度' : `社会预算调整为 $${societyBudgetUsd}`,
          createdAt: 1,
        },
        departments: departments.map(item => ({
          ...item, queued: queued.filter(task => task.departmentId === item.id).length,
          active: active.filter(schedule => (tasks.find(task => task.id === schedule.taskId)?.departmentId) === item.id).length,
          reservedUsd: active.reduce((sum, schedule) => sum + Number((schedule.estimates as { teamCostUsd?: number })?.teamCostUsd ?? 0), 0),
          spentUsd: 0, quotaRemainingUsd: item.quotaUsd,
          roleIds: roles.filter(role => role.id !== 'role-coordinator' && (
            item.id === 'knowledge' ? role.id === 'role-research'
              : item.id === 'quality' ? role.id === 'role-quality' : role.id === 'role-delivery'
          )).map(role => role.id),
        })),
        roles,
        roleLife: roles.map(role => ({
          roleId: role.id,
          versions: [{ id: `role-version-${role.id}`, tenantId: 'default', kind: 'role', subjectId: role.id, version: 1, status: 'active', record: role, hash: `role-hash-${role.id}`, createdBy: 'maharness', reason: '建立角色版本', createdAt: 1 }],
          versionAudits: [{ id: `role-audit-${role.id}`, tenantId: 'default', kind: 'role', subjectId: role.id, version: 1, action: 'initialize', actor: 'maharness', toVersion: 1, afterHash: `role-hash-${role.id}`, reason: '建立角色版本', createdAt: 1 }],
          memories: [{ id: `memory-${role.id}`, roleId: role.id, kind: 'appointment', summary: `岗位建立：${role.name}`, evidence: [], createdAt: 1 }],
          relations: role.id === 'role-research' ? [{
            id: 'relation-1', fromRoleId: 'role-research', toRoleId: 'role-quality',
            kind: 'collaborated', score: 0.9, updatedAt: 2,
          }] : [],
          scorecard: role.id === 'role-research' ? {
            roleId: role.id, evaluationVersion: 1, evaluationHash: 'evaluation-hash-1',
            sampleSize: 1, confidence: 'insufficient', completionRate: 1,
            acceptanceRate: 1, reworkRate: null, budgetCompliance: 1, recoveryRate: null,
            evidenceCompleteness: 1, reviewConsistency: null, costUsd: 0.02,
          } : undefined,
          wellbeing: { roleId: role.id, activeAssignments: 0, consecutiveFailures: 0, waitingApproval: 0, reworkAssignments: 0, contextPressure: 'normal', state: 'ready' },
        })),
        tasks, schedules, institutionAudits: audits,
        evaluation: {
          id: `evaluation-${evaluationVersion}`, tenantId: 'default', kind: 'evaluation', subjectId: 'default',
          version: evaluationVersion, status: 'active', hash: `evaluation-hash-${evaluationVersion}`,
          createdBy: 'human', reason: evaluationVersion === 1 ? '初始化评价标准' : '调整履历置信门槛', createdAt: 1,
          record: {
            schemaVersion: 1, lowConfidenceSamples: evaluationLow, mediumConfidenceSamples: evaluationMedium,
            highConfidenceSamples: evaluationHigh,
            rankingWeights: { acceptance: 0.5, budget: 0.3, evidence: 0.2 },
            review: {
              rubricVersion: 'ai-user-review-v1',
              fast: { input: 3000, output: 800, total: 3800 },
              focused: { input: 8000, output: 1200, total: 9200 },
              multi: { input: 10000, output: 1500, total: 11500 },
              positiveMinAverage: 3.5, positiveMinReuse: 4, positiveMinDimension: 3,
            },
            formula: 'role metrics come from contract and Run facts',
          },
        },
        evaluationAudits,
        network: {
          nodes: roles.map(role => ({ roleId: role.id, departmentId: role.id === 'role-research' ? 'knowledge' : 'operations', load: 0 })),
          edges: [{ id: 'relation-1', fromRoleId: 'role-research', toRoleId: 'role-quality', kind: 'collaborated', score: 0.9, updatedAt: 2 }],
        },
        bottlenecks: [],
        health: { score: 92, loadBalance: 1, welfare: 0.9, exceptionHealth: 1, budgetUtilization: 0.1, collaborationHealth: 0.9 },
        economics: {
          societyBudgetUsd, societyReservedUsd: 0, societySpentUsd: 0,
          departmentBudgets: departments.map(item => ({ departmentId: item.id, quotaUsd: item.quotaUsd, reservedUsd: 0, spentUsd: 0, remainingUsd: item.quotaUsd })),
          roleBudgets: roles.map(role => ({ roleId: role.id, costUsd: 0, activeAssignments: 0 })),
          taskLedger: tasks.map(task => ({
            taskId: task.id, maxBudgetUsd: task.maxBudgetUsd, maxBudgetTokens: 1000,
            estimatedCostUsd: 0, estimatedTokens: 1000, actualCostUsd: 0, actualTokens: 100,
            cachedInputTokens: 60, cacheMissInputTokens: 40, cacheWriteTokens: 0,
            cacheUsageStatus: 'known', cacheWriteUsageStatus: 'known',
            valueUsd: task.valueUsd, status: task.status,
          })),
          cachedInputTokens: 60, cacheMissInputTokens: 40, cacheWriteTokens: 0,
          cacheHitRate: 0.6, cacheUsageStatus: 'known', cacheWriteUsageStatus: 'known',
          cacheSavingsUsd: null, duplicateEvidenceReads: 0,
          compression: { sharedMemoryRefs: 2, reusedRefs: 1, officialTokenCount: 0 },
        },
        scheduling: { decisions: schedules, queue: queued, waitingApproval: waiting, activeTeams: active.filter(item => item.mode === 'team') },
      },
    };
  };

  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/sessions') return route.fulfill({ json: [{
      id: 'session-1', title: '社会运行', model: 'fixture-model', provider: 'fixture',
      mode: 'normal', planPending: 0, archived: 0, pinned: 0, createdAt: 1, updatedAt: 2,
    }] });
    if (/\/api\/sessions\/session-1\/messages$/.test(path)) return route.fulfill({ json: [] });
    if (path === '/api/v2/runs') return route.fulfill({ json: [] });
    if (path === '/api/models') return route.fulfill({ json: [{ id: 'fixture@fixture-model', provider: 'fixture', label: 'Fixture', model: 'fixture-model' }] });
    if (path === '/api/providers') return route.fulfill({ json: [{
      id: 'fixture', label: 'Fixture', baseUrl: 'fixture', model: 'fixture-model', enabled: true,
      hasKey: true, apiKeyMasked: '***', createdAt: 1, updatedAt: 2,
    }] });
    if (path === '/api/plugins' || path === '/api/plugins/diagnostics') return route.fulfill({ json: [] });
    if (path === '/api/nav') return route.fulfill({ json: { items: [] } });
    if (path === '/api/workbench/summary') return route.fulfill({ json: summary() });
    if (path === '/api/organization/society/tasks' && request.method() === 'POST') {
      const body = request.postDataJSON() as { objective: string; valueUsd: number; maxBudgetUsd: number; departmentId?: string };
      const task = {
        id: 'task-human', tenantId: 'default', projectId: '', objective: body.objective,
        acceptance: [], materials: [], valueUsd: body.valueUsd, maxBudgetUsd: body.maxBudgetUsd,
        priority: 3, departmentId: body.departmentId ?? 'operations',
        branches: [{ objective: body.objective, acceptance: [], expectedArtifacts: [], departmentId: body.departmentId ?? 'operations' }],
        approval: body.maxBudgetUsd >= 2 ? 'pending' : 'not_required',
        status: body.maxBudgetUsd >= 2 ? 'waiting_approval' : 'queued',
        lastSchedulingReason: body.maxBudgetUsd >= 2 ? '等待人类批准高额任务' : '等待制度调度',
        createdAt: 3, updatedAt: 3, revision: 0,
      };
      tasks.push(task);
      return route.fulfill({ json: { task } });
    }
    const approve = path.match(/^\/api\/organization\/society\/tasks\/([^/]+)\/approve$/);
    if (approve) {
      const task = tasks.find(item => item.id === approve[1])!;
      const body = request.postDataJSON() as { approved: boolean };
      task.approval = body.approved ? 'approved' : 'rejected';
      task.status = body.approved ? 'queued' : 'completed';
      task.lastSchedulingReason = body.approved ? '人类已批准高额任务，等待制度调度' : '人类拒绝高额任务';
      return route.fulfill({ json: { task } });
    }
    if (path === '/api/organization/society/tick') {
      const decisions: typeof schedules = [];
      const recoverableTaskIds = new Set(tasks.filter(item => item.status === 'scheduled').map(item => item.id));
      for (const task of tasks.filter(item => item.status === 'queued')) {
        const team = task.branches.length > 1;
        const schedule = {
          id: `schedule-${task.id}`, tenantId: 'default', taskId: task.id, trigger: 'institution',
          institutionVersion, departmentId: task.departmentId ?? 'operations',
          mode: team ? 'team' as const : 'solo' as const,
          roleIds: team ? ['role-research', 'role-quality'] : ['role-research'],
          runIds: task.branches.map((_, index) => `run-${task.id}-${index + 1}`),
          assignments: task.branches.map((branch, index) => ({
            roleId: team && index === 1 ? 'role-quality' : 'role-research',
            branchObjective: branch.objective, expectedArtifacts: branch.expectedArtifacts,
            acceptance: branch.acceptance, cognitiveTier: index === 0 ? 'decision' : 'execution',
          })),
          formula: 'net = value × quality + latencyBenefit + value × riskReduction - estimatedCost - coordinationCost',
          estimates: {
            soloCostUsd: task.maxBudgetUsd * 0.55, teamCostUsd: task.maxBudgetUsd * (team ? 0.8 : 0.55),
            coordinationCostUsd: team ? 0.01 : 0, soloNetBenefitUsd: task.valueUsd * 0.72,
            teamNetBenefitUsd: task.valueUsd * 0.82 - task.maxBudgetUsd, marginalNetBenefitUsd: 0.8,
            qualityGain: team ? 0.1 : 0, latencyGainMs: team ? 2500 : 0, riskReduction: team ? 0.04 : 0, roi: 2.1,
          },
          sharedMemoryRefs: [], reason: team ? '独立分支净收益超过单角色门槛，建立短周期组织' : '单角色即可完成，保持单角色执行',
          status: 'active' as const, createdAt: 4,
        };
        schedules.push(schedule);
        decisions.push(schedule);
        task.status = 'scheduled';
        task.scheduleId = schedule.id;
        task.lastSchedulingReason = schedule.reason;
      }
      for (const task of tasks.filter(item => recoverableTaskIds.has(item.id))) {
        const schedule = schedules.find(item => item.taskId === task.id && item.status === 'active');
        if (!schedule) continue;
        schedule.status = 'completed';
        task.status = 'awaiting_acceptance';
        task.lastSchedulingReason = '全部真实分工已交付，等待人类验收';
      }
      return route.fulfill({ json: {
        decisions, queued: tasks.filter(item => item.status === 'queued').length,
        waitingApproval: tasks.filter(item => item.status === 'waiting_approval').length,
        snapshot: summary().society,
      } });
    }
    const release = path.match(/^\/api\/organization\/society\/tasks\/([^/]+)\/release$/);
    if (release) {
      const task = tasks.find(item => item.id === release[1])!;
      const schedule = schedules.find(item => item.taskId === task.id)!;
      task.status = 'completed';
      task.lastSchedulingReason = '人类确认交付完成，释放短周期角色';
      schedule.status = 'completed';
      return route.fulfill({ json: { task, schedule } });
    }
    if (path === '/api/organization/institution') {
      const body = request.postDataJSON() as { policies: { societyBudgetUsd?: number }; reason: string };
      societyBudgetUsd = Number(body.policies.societyBudgetUsd ?? societyBudgetUsd);
      institutionVersion += 1;
      audits.unshift({
        id: `audit-${institutionVersion}`, version: institutionVersion, action: 'update', actor: 'human',
        fromVersion: institutionVersion - 1, toVersion: institutionVersion, reason: body.reason, createdAt: 3,
      });
      return route.fulfill({ json: { institution: summary().society.institution } });
    }
    if (path === '/api/organization/institution/rollback') {
      institutionVersion += 1;
      societyBudgetUsd = 20;
      audits.unshift({
        id: `audit-${institutionVersion}`, version: institutionVersion, action: 'rollback', actor: 'human',
        fromVersion: institutionVersion - 1, toVersion: institutionVersion, reason: '人类在工作台回滚制度', createdAt: 4,
      });
      return route.fulfill({ json: { institution: summary().society.institution } });
    }
    if (path === '/api/organization/evaluations' && request.method() === 'POST') {
      const body = request.postDataJSON() as {
        policy: { lowConfidenceSamples?: number; mediumConfidenceSamples?: number; highConfidenceSamples?: number };
        reason: string;
      };
      evaluationLow = Number(body.policy.lowConfidenceSamples ?? evaluationLow);
      evaluationMedium = Number(body.policy.mediumConfidenceSamples ?? evaluationMedium);
      evaluationHigh = Number(body.policy.highConfidenceSamples ?? evaluationHigh);
      evaluationVersion += 1;
      evaluationAudits.unshift({
        id: `evaluation-audit-${evaluationVersion}`, tenantId: 'default', kind: 'evaluation', subjectId: 'default',
        version: evaluationVersion, action: 'update', actor: 'human', fromVersion: evaluationVersion - 1,
        toVersion: evaluationVersion, afterHash: `evaluation-hash-${evaluationVersion}`,
        reason: body.reason, createdAt: 3,
      });
      return route.fulfill({ json: { evaluation: summary().society.evaluation } });
    }
    if (path === '/api/organization/evaluations/rollback') {
      evaluationLow = 3;
      evaluationMedium = 10;
      evaluationHigh = 30;
      evaluationVersion += 1;
      evaluationAudits.unshift({
        id: `evaluation-audit-${evaluationVersion}`, tenantId: 'default', kind: 'evaluation', subjectId: 'default',
        version: evaluationVersion, action: 'rollback', actor: 'human', fromVersion: evaluationVersion - 1,
        toVersion: evaluationVersion, afterHash: `evaluation-hash-${evaluationVersion}`,
        reason: '人类在工作台回滚评价标准', createdAt: 4,
      });
      return route.fulfill({ json: { evaluation: summary().society.evaluation } });
    }
    if (path === '/api/organization/roles/role-research/life') {
      return route.fulfill({ json: { life: summary().society.roleLife.find(item => item.roleId === 'role-research') } });
    }
    return route.fulfill({ json: {} });
  });
}

test('人类经营 AI 社会闭环并留下可审计证据', async ({ page }) => {
  await setup(page);
  await page.goto('/?view=workbench');
  await expect(page.getByTestId('workbench-home')).toBeVisible();

  const society = page.getByTestId('society-console');
  await expect(society.getByText('maharness 社会运行')).toBeVisible();
  await expect(society.getByText('92/100')).toBeVisible();
  await expect(society.locator('span').filter({ hasText: /^知识与研究部$/ })).toBeVisible();
  await expect(society.getByText('高价值资料核验').first()).toBeVisible();

  await society.getByLabel('社会任务目标').fill('整理一份可核对的会议纪要');
  await society.getByRole('button', { name: '登记任务' }).click();
  await expect(society.getByText('整理一份可核对的会议纪要').first()).toBeVisible();

  await society.getByRole('button', { name: '批准', exact: true }).click();
  await expect(society.getByText('人类已批准高额任务，等待制度调度')).toBeVisible();
  await society.getByRole('button', { name: '运行制度调度' }).click();
  await expect(society.getByText('团队 2', { exact: true })).toBeVisible();
  await expect(society.getByRole('button', { name: '确认交付' })).toHaveCount(0);
  await society.getByRole('button', { name: '运行制度调度' }).click();
  await expect(society.getByText('待你验收', { exact: true }).first()).toBeVisible();
  await society.getByRole('button', { name: '确认交付' }).first().click();
  await expect(society.getByText('人类确认交付完成，释放短周期角色')).toBeVisible();

  await society.getByText('制度版本、配额与审计').click();
  await expect(society.getByText(/缓存命中率：60% · 命中 60 \/ 未命中 40 · 写入 0/)).toBeVisible();
  await expect(society.getByText(/缓存命中 60 \/ 未命中 40 · 写入 0/).first()).toBeVisible();
  await society.getByLabel('制度社会总预算').fill('25');
  await society.getByRole('button', { name: '发布制度 v2' }).click();
  await expect(society.getByText('当前 v2', { exact: false })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await society.getByTestId('institution-versions').getByRole('button', { name: '回滚上一版' }).click();
  await expect(society.getByText('当前 v3', { exact: false })).toBeVisible();
  await expect(society.getByText('回滚自 v2', { exact: false })).toBeVisible();

  await society.getByLabel('评价标准低置信样本').fill('4');
  await society.getByLabel('评价标准中置信样本').fill('12');
  await society.getByLabel('评价标准高置信样本').fill('40');
  await society.getByRole('button', { name: '发布评价 v2' }).click();
  await expect(society.getByText('当前评价 v2', { exact: false })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await society.getByTestId('evaluation-versions').getByRole('button', { name: '回滚上一版' }).click();
  await expect(society.getByText('当前评价 v3', { exact: false })).toBeVisible();
  await expect(society.getByText('回滚自 v2', { exact: false }).last()).toBeVisible();

  const evidence = resolve(process.cwd(), '../evals/acceptance/ai-society-v1');
  mkdirSync(evidence, { recursive: true });
  await society.screenshot({ path: resolve(evidence, 'dashboard.png') });

  await page.getByText('社会交付项目', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '社会交付项目 · 组织视图' })).toBeVisible();
  await dialog.getByText('角色、契约与履历', { exact: true }).click();
  await dialog.getByRole('button', { name: '查看生命史' }).click();
  await expect(dialog.getByText('岗位版本与审计')).toBeVisible();
  await expect(dialog.getByText(/v1 · active/)).toBeVisible();
  await expect(dialog.getByText('岗位建立：研究执行员')).toBeVisible();
  await expect(dialog.getByText(/collaborated/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('workbench-home')).toBeVisible();
});
