import { expect, test, type Page } from '@playwright/test';

const dimensions = [
  'capability_discovery', 'tool_contract_clarity', 'result_actionability', 'state_credibility',
  'error_recovery', 'execution_efficiency', 'context_continuity', 'authorization_control',
  'result_usability', 'reuse_intention',
] as const;

async function setup(page: Page, initialStatus: 'completed' | 'queued' | 'insufficient_evidence' = 'completed') {
  const run = {
    id: 'run-1',
    sessionId: 'session-1',
    objective: '核对复盘工作流',
    providerId: 'fixture',
    model: 'fixture-model',
    status: 'completed',
    answer: '已完成',
    cost: 0,
    tokensIn: 20,
    tokensOut: 10,
    createdAt: 1,
    updatedAt: 2,
    authorization: { workspace: 'fixture', profile: 'standard', readOnly: false, revision: 0 },
  };
  const suggestion = {
    id: 'suggestion-1',
    title: '保留证据入口',
    detail: '继续在复盘结果中提供可核对的证据入口。',
    category: 'result-feedback',
    impact: 'medium',
    confidence: 0.9,
    evidenceRefs: ['run:run-1:verification'],
  };
  const factLedger = {
    schemaVersion: 1,
    rubricVersion: 'ai-user-review-v1',
    runIds: ['run-1'],
    generatedAt: 2,
    runs: [{
      id: 'run-1', status: 'completed', goal: run.objective, verified: true, durationMs: 1,
      modelCalls: 1, toolCalls: 1, failedTools: 0, duplicateTools: 0, recoveries: 0,
      approvalWaits: 0, artifacts: 0, invalidArtifacts: 0, capabilities: [], conflicts: 0,
    }],
    totals: {
      durationMs: 1, modelCalls: 1, toolCalls: 1, failedTools: 0, duplicateTools: 0,
      recoveries: 0, approvalWaits: 0, artifacts: 0, invalidArtifacts: 0,
    },
    gates: {
      allTerminal: true, noFalseSuccess: true, noUnknownSideEffects: true,
      noUnauthorizedSideEffects: true, artifactsParsable: true,
    },
    anomalies: [],
  };
  let review = {
    id: 'review-1',
    tenantId: 'default',
    scope: 'run',
    sourceRunIds: ['run-1'],
    status: initialStatus,
    path: 'fast',
    providerId: 'fixture',
    model: 'fixture-model',
    originalProviderId: 'fixture',
    originalModel: 'fixture-model',
    crossModel: false,
    verdict: initialStatus === 'insufficient_evidence' ? 'insufficient_evidence' : 'positive',
    dimensions: dimensions.map(id => ({
      id, score: 5, reason: '事实与证据支持该判断。', evidenceRefs: ['run:run-1:verification'],
    })),
    observations: [{
      kind: 'positive', summary: '结果和验收事实可直接核对。', evidenceRefs: ['run:run-1:verification'],
    }],
    suggestions: [suggestion],
    reuseIntent: 5,
    confidence: 0.9,
    evidenceGaps: [],
    facts: factLedger,
    evidenceIndex: [{
      id: 'run:run-1:verification', kind: 'verification', runId: 'run-1', label: '机器验收结果',
    }],
    evidence: [{
      ref: 'run:run-1:verification', label: '机器验收结果', text: '{"status":"passed"}',
      hash: '0123456789abcdef', tokens: 8,
    }],
    budget: {
      inputTokenLimit: 3_000, outputTokenLimit: 800, totalTokenLimit: 3_800,
      inputTokens: 100, outputTokens: 50, costUsd: 0.001, costSource: 'configured',
    },
    calls: 1,
    createdAt: 2,
    updatedAt: 3,
    completedAt: 3,
  };
  let findings: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let created = false;

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/sessions') {
      return route.fulfill({ json: [{
        id: 'session-1', title: '复盘测试', model: 'fixture-model', provider: 'fixture',
        createdAt: 1, updatedAt: 2,
      }] });
    }
    if (/\/api\/sessions\/session-1\/messages$/.test(path) || /\/api\/sessions\/session-1\/checkpoint$/.test(path)) {
      return route.fulfill({ json: path.endsWith('checkpoint') ? { exists: false } : [] });
    }
    if (path === '/api/models') {
      return route.fulfill({ json: [{ id: 'fixture@fixture-model', provider: 'fixture', label: 'Fixture Model', model: 'fixture-model' }] });
    }
    if (path === '/api/providers') {
      return route.fulfill({ json: [{ id: 'fixture', label: 'Fixture', model: 'fixture-model', enabled: true, hasKey: true }] });
    }
    if (path === '/api/plugins' || path === '/api/plugins/diagnostics') return route.fulfill({ json: [] });
    if (path === '/api/nav') return route.fulfill({ json: { items: [] } });
    if (path === '/api/items') return route.fulfill({ json: { items: [], projects: [] } });
    if (path === '/api/security') return route.fulfill({ json: {
      bind: '127.0.0.1',
      mutationAuthRequired: false,
      mutationTokenHeader: 'x-maharness-token',
      approvalTokenRequired: true,
      masterKey: { state: 'generated', available: true, path: 'data/secret.key' },
      credentials: { broken: [] },
      policy: { available: true, files: [], blanketAllow: [] },
    } });
    if (path === '/api/v2/runs') return route.fulfill({ json: [run] });
    if (/^\/api\/v2\/runs\/[^/]+\/(artifacts|children|tools|inputs|calls|plugins)$/.test(path)) {
      return route.fulfill({ json: [] });
    }
    if (path === '/api/workbench/summary') {
      return route.fulfill({ json: {
        schemaVersion: 1,
        today: '2026-11-17',
        todayItems: [], overdue: [], upcoming: [], unscheduled: [],
        pendingAutomations: [], automations: [], recentRuns: [], artifacts: [], projects: [], notes: [],
        metrics: {
          schemaVersion: 1, firstTaskSuccessRate: 100, takeoverRate: 0,
          recoveredAfterFailureRate: null, automaticRecoveryRate: null,
          invalidToolCalls: 0, duplicateToolCalls: 0, capabilitySelectionFailures: 0,
          durationMs: 1, modelCalls: 1, costUsd: 0, experienceReviewCostUsd: 0.001,
          experienceReviewCount: 1,
        },
        experience: {
          schemaVersion: 1,
          reviewCount: 1,
          negativeReviews: 0,
          averageScore: 5,
          undecidedFindings: findings.filter(finding => finding.status === 'new' || finding.status === 'triaged').length,
          openFindings: findings.filter(finding => finding.status !== 'closed' && finding.status !== 'wont_fix').length,
          findings,
          recentReviews: [{
            id: review.id,
            sourceRunIds: review.sourceRunIds,
            sessionId: run.sessionId,
            status: review.status,
            verdict: review.verdict,
            path: review.path,
            providerId: review.providerId,
            model: review.model,
            originalProviderId: review.originalProviderId,
            originalModel: review.originalModel,
            crossModel: review.crossModel,
            score: 5,
            suggestionCount: 1,
            adoptedCount: 0,
            costUsd: 0.001,
            updatedAt: 3,
          }],
        },
      } });
    }
    if (path === '/api/experience/reviews/estimate') {
      return route.fulfill({ json: {
        providerId: 'fixture', model: 'fixture-model',
        originalProviderId: 'fixture', originalModel: 'fixture-model',
        crossModel: false, available: true, requiresExplicitModel: false,
        scope: 'run', path: 'fast', inputTokenLimit: 3_000, outputTokenLimit: 800,
        totalTokenLimit: 3_800, estimatedCostUsd: 0.001, costSource: 'configured', runCount: 1,
      } });
    }
    if (path === '/api/experience/reviews' && request.method() === 'POST') {
      created = true;
      return route.fulfill({ status: 202, json: { review } });
    }
    if (path === '/api/experience/reviews') {
      return route.fulfill({ json: { reviews: created ? [review] : [] } });
    }
    if (path === '/api/experience/reviews/review-1') {
      return route.fulfill({ json: { review, audits, findings } });
    }
    if (path === '/api/experience/reviews/review-1/cancel') {
      review = { ...review, status: 'cancelled' };
      return route.fulfill({ json: { review } });
    }
    if (path === '/api/experience/reviews/review-1/deepen') {
      review = { ...review, status: 'completed', path: 'focused', verdict: 'positive' };
      return route.fulfill({ status: 202, json: { review } });
    }
    if (path === '/api/experience/reviews/review-1/audit') {
      const audit = {
        id: 'audit-1', source: 'ai', kind: 'independent_review', providerId: 'fixture',
        model: 'fixture-model', verdict: 'agree', summary: '事实和评分一致。',
        correctedEvidenceRefs: [], confidence: 0.9, inputTokens: 200, outputTokens: 50,
        costUsd: 0.0001, createdAt: 5,
      };
      audits.unshift(audit);
      return route.fulfill({ status: 201, json: { audit } });
    }
    if (path === '/api/experience/reviews/review-1/calibrate') {
      const body = request.postDataJSON() as { dimensions?: unknown[] };
      const audit = {
        id: 'calibration-1', source: 'human', kind: 'calibration', providerId: 'human',
        model: 'human', verdict: 'agree', summary: '人工验收结果一致。',
        correctedEvidenceRefs: [], dimensions: body.dimensions, createdAt: 6,
      };
      audits.unshift(audit);
      return route.fulfill({ status: 201, json: { audit } });
    }
    if (path === '/api/experience/reviews/review-1/suggestions/suggestion-1/adopt') {
      const finding = {
        id: 'finding-1', reviewId: review.id, reviewIds: [review.id], suggestionId: suggestion.id,
        title: suggestion.title, detail: suggestion.detail, category: suggestion.category,
        severity: 'P3', status: 'new', evidenceRefs: suggestion.evidenceRefs,
        sourceRunIds: review.sourceRunIds, occurrences: 2, createdAt: 4, updatedAt: 4,
      };
      findings = [finding];
      review = {
        ...review,
        suggestions: [{ ...suggestion, adoptedFindingId: finding.id }],
      };
      return route.fulfill({ status: 201, json: { finding } });
    }
    if (path === '/api/experience/findings/finding-1/reproduce') {
      findings = findings.map(finding => finding.id === 'finding-1'
        ? { ...finding, status: 'reproduced', regressionId: 'regression-1', updatedAt: 5 }
        : finding);
      return route.fulfill({ status: 201, json: { finding: findings[0] } });
    }
    if (path === '/api/experience/findings/finding-1/verify') {
      findings = findings.map(finding => finding.id === 'finding-1'
        ? { ...finding, status: 'closed', updatedAt: 6 }
        : finding);
      return route.fulfill({ status: 201, json: {
        finding: findings[0],
        regression: {
          id: 'regression-1', findingId: 'finding-1', sourceRunIds: review.sourceRunIds,
          objective: '隔离重放', expected: '问题不再出现', evidenceRefs: ['run:run-1:verification'],
          status: 'passed', verificationRunId: 'run-1', resultSummary: '隔离重放通过',
          completedAt: 6, createdAt: 4, updatedAt: 6,
        },
      } });
    }
    if (path === '/api/experience/findings/finding-1/evolve') {
      findings = findings.map(finding => finding.id === 'finding-1'
        ? { ...finding, evolutionProposalId: 'proposal-1', evolutionSubmittedAt: 7, updatedAt: 7 }
        : finding);
      return route.fulfill({ status: 201, json: { finding: findings[0] } });
    }
    if (path === '/api/experience/findings/finding-1') {
      const body = request.postDataJSON() as { status?: string };
      findings = findings.map(finding => finding.id === 'finding-1'
        ? { ...finding, status: body.status, updatedAt: 5 }
        : finding);
      return route.fulfill({ json: { finding: findings[0] } });
    }
    return route.fulfill({ json: {} });
  });
}

test('从运行选择、估算、启动到三轨结果和问题池采纳形成闭环', async ({ page }) => {
  await setup(page);
  await page.goto('/?view=runs');

  const reviewPanel = page.getByTestId('experience-review');
  await expect(page.getByRole('heading', { name: '运行记录' })).toBeVisible();
  await page.getByRole('checkbox').first().check();
  await expect(reviewPanel).toBeVisible();

  await reviewPanel.getByRole('button', { name: '估算复盘' }).click();
  await expect(reviewPanel).toContainText('输入上限 3000 token');
  await reviewPanel.getByRole('button', { name: '开始复盘' }).click();

  const result = page.getByTestId('experience-review-result');
  await expect(result).toContainText('实际发生');
  await expect(result).toContainText('AI 用户复盘');
  await expect(result).toContainText('人工校准');
  await result.getByRole('button', { name: '加入问题池' }).click();
  await expect(result).toContainText('保留证据入口');
  await expect(result).toContainText('new');

  await result.getByRole('button', { name: /独立复核/ }).click();
  await expect(result).toContainText('独立复核：agree');
  await result.getByLabel('人工校准说明').fill('人工验收结果与 AI 判断一致。');
  await result.getByText('逐维度人工校准', { exact: true }).click();
  await result.getByLabel('人工评分 能力发现').selectOption('3');
  await result.getByLabel('人工理由 能力发现').fill('人工核对时发现能力发现仍需改进。');
  await result.getByRole('button', { name: '追加人工校准' }).click();
  await expect(result).toContainText('人工验收结果一致。');
  await expect(result).toContainText('能力发现 3/5（人工核对时发现能力发现仍需改进。）');
});

test('复盘可取消，证据不足时可继续深入分析', async ({ page }) => {
  await setup(page, 'queued');
  await page.goto('/?view=runs');
  const panel = page.getByTestId('experience-review');
  await page.getByRole('checkbox').first().check();
  await panel.getByRole('button', { name: '估算复盘' }).click();
  await panel.getByRole('button', { name: '开始复盘' }).click();
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel).toContainText('已取消');

  await page.unroute('**/api/**');
  await setup(page, 'insufficient_evidence');
  await page.reload();
  await page.getByRole('checkbox').first().check();
  const resetPanel = page.getByTestId('experience-review');
  await resetPanel.getByRole('button', { name: '估算复盘' }).click();
  await resetPanel.getByRole('button', { name: '开始复盘' }).click();
  await resetPanel.getByRole('button', { name: '继续深入分析' }).click();
  await expect(resetPanel).toContainText('已完成');
  await expect(resetPanel).toContainText('聚焦');
});

test('体验问题池按分诊、复现、修复、真实验证和自进化提交推进', async ({ page }) => {
  await setup(page);
  await page.goto('/?view=runs');
  const panel = page.getByTestId('experience-review');
  await page.getByRole('checkbox').first().check();
  await panel.getByRole('button', { name: '估算复盘' }).click();
  await panel.getByRole('button', { name: '开始复盘' }).click();
  await page.getByTestId('experience-review-result').getByRole('button', { name: '加入问题池' }).click();

  await page.goto('/?view=society');
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();
  const row = () => page.getByText('保留证据入口').locator('..').locator('..');
  await expect(row()).toContainText('new');
  await row().getByRole('button', { name: '分诊' }).click();
  await expect(row()).toContainText('triaged');
  await row().getByRole('button', { name: '建立复现' }).click();
  await expect(row()).toContainText('reproduced');
  await row().getByRole('button', { name: '开始修复' }).click();
  await expect(row()).toContainText('fixing');
  await row().getByRole('button', { name: '进入验证' }).click();
  await expect(row()).toContainText('verifying');
  await page.getByLabel('验证运行 ID finding-1').fill('run-1');
  await page.getByLabel('回归结论 finding-1').fill('隔离重放通过，问题未再出现');
  await page.getByRole('button', { name: '登记' }).click();
  await expect(row()).toContainText('closed');
  await page.getByRole('button', { name: '提交自进化' }).click();
  await expect(page.getByText('自进化提案：proposal-1')).toBeVisible();
});

test('设置页展示复盘 Rubric、预算与复核入口', async ({ page }) => {
  await setup(page);
  await page.goto('/?view=chat');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '高级' }).click();
  await expect(page.getByRole('heading', { name: '高级' })).toBeVisible();
  await expect(page.getByText('ai-user-review-v1')).toBeVisible();
  await expect(page.getByText('3,800 token')).toBeVisible();
  await expect(page.getByText('11,500 token')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开运行记录与复盘' })).toBeVisible();
});

test('社会页中的旧复盘可直接返回来源会话', async ({ page }) => {
  await setup(page);
  await page.goto('/?view=society');
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();

  await expect(page.getByTestId('society-observations')).toContainText('AI 用户整体体验');
  await page.getByRole('button', { name: '打开会话' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=chat/);
});
