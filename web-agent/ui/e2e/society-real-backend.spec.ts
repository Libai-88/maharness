import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

let provider: Server;
let providerCalls = 0;

test.beforeAll(async () => {
  provider = createServer((_request, response) => {
    providerCalls += 1;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      model: 'society-e2e',
      choices: [{ delta: { content: '会议资料已整理，来源与限制已保留。' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      model: 'society-e2e',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolveListening, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolveListening);
  });
});

test.afterAll(async () => {
  await new Promise<void>(resolveClose => provider.close(() => resolveClose()));
});

test('real backend经营闭环写入临时 SQLite 并可由浏览器验收', async ({ page, request }, testInfo) => {
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('provider did not bind');
  const configured = await request.post('/api/providers', {
    data: {
      label: `Society E2E ${process.pid}`,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'e2e-key',
      model: 'society-e2e',
      priceIn: 0,
      priceOut: 0,
    },
  });
  expect(configured.ok()).toBeTruthy();
  const configuredProvider = await configured.json() as { id: string };
  const providersResponse = await request.get('/api/providers');
  expect(providersResponse.ok()).toBeTruthy();
  const providers = await providersResponse.json() as Array<{ id: string; enabled: boolean; updatedAt: number }>;
  for (const item of providers) {
    if (item.id === configuredProvider.id || !item.enabled) continue;
    const disabled = await request.patch(`/api/providers/${item.id}`, {
      data: { expectedUpdatedAt: item.updatedAt, enabled: false },
    });
    expect(disabled.ok()).toBeTruthy();
  }

  await page.goto('/?view=workbench');
  await expect(page.getByTestId('workbench-home')).toBeVisible();
  const society = page.getByTestId('society-console');
  await expect(society).toBeVisible();

  const objective = `真实后端会议纪要 ${Date.now()}`;
  await society.getByLabel('社会任务目标').fill(objective);
  await society.getByLabel('任务价值').fill('20');
  await society.getByLabel('任务预算').fill('10');
  await society.getByRole('button', { name: '登记任务' }).click();

  await expect(society.getByText(objective, { exact: true }).first()).toBeVisible();
  await society.getByRole('button', { name: '批准', exact: true }).first().click();
  await expect(page.getByText('高额任务已批准，等待制度调度')).toBeVisible();

  providerCalls = 0;
  await society.getByRole('button', { name: '运行制度调度' }).click();
  const taskStatus = async () => {
    const response = await request.get('/api/organization/society');
    expect(response.ok()).toBeTruthy();
    const snapshot = await response.json() as {
      tasks: Array<{ id: string; objective: string; status: string }>;
    };
    return snapshot.tasks.find(task => task.objective === objective)?.status;
  };
  await expect.poll(taskStatus, { timeout: 20_000 }).toBe('awaiting_acceptance');

  await page.getByRole('button', { name: '刷新' }).first().click();
  await expect(society.getByText('待你验收', { exact: true }).first()).toBeVisible();
  await society.getByRole('button', { name: '确认交付' }).first().click();
  await expect(page.getByText('任务已释放，角色履历与关系已更新')).toBeVisible();
  await expect.poll(taskStatus).toBe('completed');

  await society.getByText('制度版本、配额与审计').click();
  await society.getByLabel('制度社会总预算').fill('25');
  await society.getByRole('button', { name: '发布制度 v2' }).click();
  await expect(society.getByText('当前 v2', { exact: false })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await society.getByTestId('institution-versions')
    .getByRole('button', { name: '回滚上一版' }).click();
  await expect(society.getByText('当前 v3', { exact: false })).toBeVisible();

  const response = await request.get('/api/organization/society');
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json() as {
    institution: { version: number; policies: { societyBudgetUsd: number } };
    institutionAudits: Array<{ action: string; toVersion?: number }>;
    tasks: Array<{ id: string; objective: string; status: string }>;
    schedules: Array<{ taskId: string; runIds: string[]; status: string }>;
  };
  const task = snapshot.tasks.find(item => item.objective === objective)!;
  const schedule = snapshot.schedules.find(item => item.taskId === task.id)!;
  expect(task.status).toBe('completed');
  expect(schedule.status).toBe('completed');
  expect(schedule.runIds).toHaveLength(1);
  expect(snapshot.institution.version).toBe(3);
  expect(snapshot.institution.policies.societyBudgetUsd).toBe(20);
  expect(snapshot.institutionAudits.some(item => item.action === 'update' && item.toVersion === 2)).toBe(true);
  expect(snapshot.institutionAudits.some(item => item.action === 'rollback' && item.toVersion === 3)).toBe(true);
  expect(providerCalls).toBeGreaterThan(0);

  const evidenceDir = resolve(process.cwd(), '../evals/acceptance/ai-society-v1');
  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = resolve(evidenceDir, 'real-workflow.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const report = {
    kind: 'browser-real-backend-workflow',
    backend: 'maharness server/index.ts',
    database: 'temporary SQLite',
    browser: 'Playwright Chromium',
    provider: 'deterministic OpenAI-compatible local HTTP transport',
    realModel: false,
    mockBoundary: 'provider transport only; API, scheduler, RunService, persistence and UI are real',
    taskStatus: task.status,
    scheduleStatus: schedule.status,
    realRunCount: schedule.runIds.length,
    providerCalls,
    institutionVersion: snapshot.institution.version,
    institutionBudgetUsd: snapshot.institution.policies.societyBudgetUsd,
    auditActions: snapshot.institutionAudits.map(item => item.action),
    screenshotSha256: createHash('sha256').update(readFileSync(screenshotPath)).digest('hex'),
  };
  writeFileSync(resolve(evidenceDir, 'real-workflow.json'), JSON.stringify(report, null, 2));
  await testInfo.attach('real-workflow', { path: screenshotPath, contentType: 'image/png' });
  await testInfo.attach('real-workflow-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
