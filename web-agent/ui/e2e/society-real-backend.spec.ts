import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SocietyTaskSummary {
  id: string;
  objective: string;
  status: 'queued' | 'waiting_approval' | 'scheduled' | 'awaiting_acceptance' | 'completed' | 'failed' | 'cancelled';
  lastSchedulingReason?: string;
}

interface SocietyScheduleSummary {
  id: string;
  taskId: string;
  workOrderId?: string;
  contractIds: string[];
  runIds: string[];
  mode: 'solo' | 'team' | 'queue' | 'human';
  roleIds: string[];
  reason: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  selection?: {
    weights: {
      capability: number;
      memory: number;
      tools: number;
      collaboration: number;
      history: number;
      load: number;
    };
  };
}

interface SocietySnapshot {
  institution: {
    version: number;
    policies: { societyBudgetUsd: number };
    reason: string;
    createdBy: string;
  };
  institutionAudits: Array<{ action: string; toVersion?: number }>;
  departments: Array<{
    id: string;
    name: string;
    charter: string;
    capabilities: string[];
    quotaUsd: number;
    quotaTokens: number;
    maxConcurrent: number;
    priority: number;
    enabled: boolean;
  }>;
  tasks: SocietyTaskSummary[];
  schedules: SocietyScheduleSummary[];
  audits: Array<{
    taskId: string;
    action: 'queued' | 'scheduled' | 'release_completed' | 'release_failed'
      | 'fallback_solo' | 'human_accepted' | 'human_rejected';
  }>;
  network: {
    nodes: Array<{ roleId: string }>;
    edges: Array<{ id: string; fromRoleId: string; toRoleId: string }>;
  };
  bottlenecks: Array<{ departmentId: string; kind: string; detail: string }>;
  economics: {
    cacheUsageStatus: 'known' | 'unknown';
    cacheWriteUsageStatus: 'known' | 'unknown';
    cachedInputTokens: number;
    cacheMissInputTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
    compression: { officialTokenCount: number };
    taskLedger: Array<{
      taskId: string;
      maxBudgetTokens: number;
      actualTokens: number;
      cachedInputTokens: number;
      cacheMissInputTokens: number;
      cacheUsageStatus: 'known' | 'unknown';
    }>;
  };
  roleLife: Array<{ roleId: string; wellbeing?: { state: string } }>;
}

interface RunSummary {
  id: string;
  status: string;
  fallbackReason?: string;
  origin?: { kind?: string; scheduleId?: string; assignmentContractId?: string };
}

interface WorkOrderDetail {
  contracts: Array<{
    id: string;
    runId?: string;
    status: string;
    branchObjective: string;
  }>;
}

interface TeamBranchInput {
  objective: string;
  acceptance: string[];
  expectedArtifacts: string[];
  departmentId: string;
  maxBudgetTokens: number;
}

interface EvidenceReport {
  scenario: string;
  [key: string]: unknown;
}

const evidenceDir = resolve(process.cwd(), 'test-results/ai-society-v1');
const scenarioReports: EvidenceReport[] = [];
const screenshotHashes: Record<string, string> = {};

let provider: Server | undefined;
let providerId = '';
let providerCalls = 0;
let providerFailMarker = '';
let providerSuccessDelayMs = 0;
let providerFailureDelayMs = 0;

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolveDelay => setTimeout(resolveDelay, ms)) : Promise.resolve();
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendProviderError(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(500, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    error: {
      message: 'deterministic E2E child failure',
      type: 'e2e_failure',
      code: 'e2e_child_failed',
    },
  }));
}

function sendProviderToolCall(
  response: ServerResponse,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.write(`data: ${JSON.stringify({
    model: 'society-e2e',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    model: 'society-e2e',
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function sendProviderSuccess(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.write(`data: ${JSON.stringify({
    model: 'society-e2e',
    choices: [{ delta: { content: '分工已完成，来源、限制与验收结果已核对。' }, finish_reason: null }],
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
}

async function handleProviderRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  providerCalls += 1;
  try {
    const body = await readRequestBody(request);
    if (providerFailMarker && body.includes(providerFailMarker)) {
      await delay(providerFailureDelayMs);
      sendProviderError(response);
      return;
    }
    await delay(providerSuccessDelayMs);
    const payload = JSON.parse(body) as {
      messages?: Array<{
        role?: string;
        content?: string | null;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const toolNames = payload.tools?.flatMap(tool => tool.function?.name ? [tool.function.name] : []) ?? [];
    const supportsWrite = payload.tools?.some(tool => tool.function?.name === 'write_file') ?? false;
    const supportsEnable = payload.tools?.some(tool => tool.function?.name === 'enable_tools') ?? false;
    const called = (name: string) => payload.messages?.some(message =>
      message.role === 'assistant'
      && message.tool_calls?.some(call => call.function?.name === name),
    ) ?? false;
    const objectives = payload.messages
      ?.filter(message => message.role === 'user' && typeof message.content === 'string')
      .map(message => message.content as string) ?? [];
    const artifactPaths = objectives
      .flatMap(objective => [...objective.matchAll(/\[artifact: ([^\]\n]+)\]/g)].map(match => match[1]!))
      .filter((candidate, index, all) => all.indexOf(candidate) === index);
    const writtenPaths = new Set(payload.messages?.flatMap(message =>
      message.role === 'assistant'
        ? (message.tool_calls ?? []).flatMap(call => {
          if (call.function?.name !== 'write_file' || !call.function.arguments) return [];
          try {
            const args = JSON.parse(call.function.arguments) as { path?: string };
            return args.path ? [args.path] : [];
          } catch {
            return [];
          }
        })
        : [],
    ) ?? []);
    const path = artifactPaths.find(candidate => !writtenPaths.has(candidate));
    if (supportsEnable && !supportsWrite && !called('enable_tools')) {
      if (path) {
        sendProviderToolCall(
          response,
          `enable-${createHash('sha256').update(`${path}\0${providerCalls}`).digest('hex').slice(0, 16)}`,
          'enable_tools',
          { names: ['write_file'] },
        );
        return;
      }
    }
    if (supportsWrite) {
      if (path) {
        sendProviderToolCall(
          response,
          `write-${createHash('sha256').update(`${path}\0${providerCalls}`).digest('hex').slice(0, 16)}`,
          'write_file',
          {
            path,
            content: `# ${path}\n\n来源、限制与验收结果已核对。\n`,
            expectedVersion: null,
          },
        );
        return;
      }
    }
    sendProviderSuccess(response);
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

function resetProvider(): void {
  providerCalls = 0;
  providerFailMarker = '';
  providerSuccessDelayMs = 0;
  providerFailureDelayMs = 0;
}

async function readSociety(request: APIRequestContext): Promise<SocietySnapshot> {
  const response = await request.get('/api/organization/society');
  expect(response.ok()).toBeTruthy();
  return await response.json() as SocietySnapshot;
}

async function readRuns(request: APIRequestContext): Promise<RunSummary[]> {
  const response = await request.get('/api/v2/runs');
  expect(response.ok()).toBeTruthy();
  return await response.json() as RunSummary[];
}

async function readWorkOrder(request: APIRequestContext, id: string): Promise<WorkOrderDetail> {
  const response = await request.get(`/api/work-orders/${id}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as WorkOrderDetail;
}

async function createTeamTask(
  request: APIRequestContext,
  input: {
    objective: string;
    departmentId: string;
    branches: TeamBranchInput[];
  },
): Promise<SocietyTaskSummary> {
  const response = await request.post('/api/organization/society/tasks', {
    data: {
      objective: input.objective,
      valueUsd: 20,
      maxBudgetUsd: 0.2,
      maxBudgetTokens: 200_000,
      priority: 5,
      departmentId: input.departmentId,
      acceptance: ['交付结论可核对且限制明确'],
      branches: input.branches,
      economics: {
        qualityGain: 0.1,
        riskReduction: 0.02,
        latencyGainMs: 1_000,
        latencyBenefitUsd: 0.1,
      },
    },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { task: SocietyTaskSummary };
  return payload.task;
}

async function waitForTeamSchedule(
  request: APIRequestContext,
  taskId: string,
): Promise<SocietyScheduleSummary> {
  let schedule: SocietyScheduleSummary | undefined;
  await expect.poll(async () => {
    const snapshot = await readSociety(request);
    const task = snapshot.tasks.find(item => item.id === taskId);
    schedule = snapshot.schedules.find(item => item.taskId === taskId);
    return schedule
      ? `${schedule.status}|${schedule.mode}|${schedule.runIds.length}|${schedule.contractIds.length}`
      : task
        ? `queued:${task.status}:${task.lastSchedulingReason ?? 'no-reason'}`
        : 'missing-task';
  }, { timeout: 20_000 }).toBe('active|team|2|2');
  return schedule!;
}

async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  status: SocietyTaskSummary['status'],
): Promise<{ snapshot: SocietySnapshot; task: SocietyTaskSummary; schedule: SocietyScheduleSummary }> {
  let result: { snapshot: SocietySnapshot; task: SocietyTaskSummary; schedule: SocietyScheduleSummary } | undefined;
  await expect.poll(async () => {
    const snapshot = await readSociety(request);
    const task = snapshot.tasks.find(item => item.id === taskId);
    const schedule = snapshot.schedules.find(item => item.taskId === taskId);
    if (task?.status === status && schedule) result = { snapshot, task, schedule };
    return task?.status ?? 'missing';
  }, { timeout: 30_000 }).toBe(status);
  return result!;
}

async function waitForRollback(
  request: APIRequestContext,
  taskId: string,
): Promise<{
  snapshot: SocietySnapshot;
  task: SocietyTaskSummary;
  schedule: SocietyScheduleSummary;
  runs: RunSummary[];
  fallbackRun: RunSummary;
}> {
  let result: {
    snapshot: SocietySnapshot;
    task: SocietyTaskSummary;
    schedule: SocietyScheduleSummary;
    runs: RunSummary[];
    fallbackRun: RunSummary;
  } | undefined;
  await expect.poll(async () => {
    const [snapshot, runs] = await Promise.all([readSociety(request), readRuns(request)]);
    const task = snapshot.tasks.find(item => item.id === taskId);
    const schedule = snapshot.schedules.find(item => item.taskId === taskId);
    const fallbackRun = runs.find(item =>
      item.origin?.scheduleId === schedule?.id && item.fallbackReason === 'ROLLBACK_TO_SOLO');
    if (task && schedule && schedule.mode === 'solo' && schedule.runIds.length >= 3 && fallbackRun) {
      result = { snapshot, task, schedule, runs, fallbackRun };
      return 'ready';
    }
    return 'waiting';
  }, { timeout: 30_000 }).toBe('ready');
  return result!;
}

async function refreshWorkbench(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(response => {
    try {
      return new URL(response.url()).pathname === '/api/workbench/summary'
        && response.request().method() === 'GET';
    } catch {
      return false;
    }
  });
  await page.getByTestId('society-observations').getByRole('button', { name: '刷新', exact: true }).click();
  expect((await responsePromise).ok()).toBeTruthy();
  await expect(page.getByTestId('society-home')).toBeVisible();
}

async function openDetails(details: Locator): Promise<void> {
  const isOpen = await details.evaluate(element => (element as HTMLDetailsElement).open);
  if (!isOpen) await details.locator('summary').first().click();
}

async function captureScreenshot(page: Page, filename: string): Promise<string> {
  const path = resolve(evidenceDir, filename);
  await page.screenshot({ path, fullPage: true });
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  screenshotHashes[filename] = hash;
  return path;
}

test.beforeAll(async ({ request }) => {
  mkdirSync(evidenceDir, { recursive: true });
  provider = createServer((requestStream, response) => {
    void handleProviderRequest(requestStream, response);
  });
  await new Promise<void>((resolveListening, reject) => {
    provider!.once('error', reject);
    provider!.listen(0, '127.0.0.1', resolveListening);
  });

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
  providerId = (await configured.json() as { id: string }).id;

  const providersResponse = await request.get('/api/providers');
  expect(providersResponse.ok()).toBeTruthy();
  const providers = await providersResponse.json() as Array<{ id: string; enabled: boolean; updatedAt: number }>;
  for (const item of providers) {
    if (item.id === providerId || !item.enabled) continue;
    const disabled = await request.patch(`/api/providers/${item.id}`, {
      data: { expectedUpdatedAt: item.updatedAt, enabled: false },
    });
    expect(disabled.ok()).toBeTruthy();
  }
  providerCalls = 0;
});

test.afterAll(async () => {
  writeFileSync(resolve(evidenceDir, 'real-workflow.json'), JSON.stringify({
    kind: 'browser-real-backend-workflow-suite',
    backend: 'maharness server/index.ts',
    database: 'temporary SQLite',
    browser: 'Playwright Chromium',
    provider: 'deterministic OpenAI-compatible local HTTP transport',
    realModel: false,
    mockBoundary: 'provider transport only; API, production Scheduler, RunService, SocietyService, persistence and UI are real',
    coverage: {
      realTeamTask: scenarioReports.some(item => item.scenario === 'team-auto-scheduler-ui'),
      childRunsAtLeast2: scenarioReports.some(item => Number(item.childRunCount) >= 2),
      contractsAtLeast2: scenarioReports.some(item => Number(item.contractCount) >= 2),
      collaborationNetworkUi: scenarioReports.some(item => item.collaborationNetworkUi === true),
      bottleneckUi: scenarioReports.some(item => item.bottleneckUi === true),
      sixFactorUi: scenarioReports.some(item => item.sixFactorUi === true),
      wellbeingUi: scenarioReports.some(item => item.wellbeingUi === true),
      tokenCacheUi: scenarioReports.some(item => item.tokenCacheUi === true),
      rollbackToSolo: scenarioReports.some(item =>
        item.scenario === 'failed-child-rollback-to-solo' && item.rollbackMarker === 'ROLLBACK_TO_SOLO'),
      immutableSocietyAudit: scenarioReports.some(item =>
        Array.isArray(item.societyAuditActions)
        && item.societyAuditActions.includes('queued')
        && item.societyAuditActions.includes('scheduled')
        && item.societyAuditActions.includes('human_accepted')),
      schedulerAutoAdvanceWithoutTickApi: scenarioReports.some(item =>
        item.schedulerTickApiCalls === 0 && item.schedulerAutoAdvanced === true),
    },
    screenshots: screenshotHashes,
    scenarios: scenarioReports,
  }, null, 2));

  await new Promise<void>(resolveClose => {
    if (!provider) {
      resolveClose();
      return;
    }
    provider.close(() => resolveClose());
  });
});

test.beforeEach(() => {
  resetProvider();
});

test('真实后端经营闭环写入临时 SQLite 并可由浏览器验收', async ({ page, request }, testInfo) => {
  await page.goto('/?view=society');
  await expect(page.getByTestId('society-home')).toBeVisible();
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();
  const society = page.getByTestId('society-console');
  await expect(society).toBeVisible();

  const objective = `真实后端会议纪要 ${Date.now()}`;
  const submitted = await request.post('/api/organization/society/tasks', { data: { objective, acceptance: ['会议纪要可核对'], valueUsd: 20, maxBudgetUsd: 10 } });
  expect(submitted.status(), await submitted.text()).toBe(201);
  await refreshWorkbench(page);

  await expect(society.getByText(objective, { exact: true }).first()).toBeVisible();
  await society.getByRole('button', { name: '批准', exact: true }).first().click();
  await expect(page.getByText('高额任务已批准，等待制度调度')).toBeVisible();

  await society.getByRole('button', { name: '运行制度调度' }).click();
  const taskStatus = async () => {
    const snapshot = await readSociety(request);
    return snapshot.tasks.find(task => task.objective === objective)?.status;
  };
  await expect.poll(taskStatus, { timeout: 20_000 }).toBe('awaiting_acceptance');

  await refreshWorkbench(page);
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

  const snapshot = await readSociety(request);
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

  const screenshotPath = await captureScreenshot(page, 'real-workflow-governance.png');
  const report: EvidenceReport = {
    scenario: 'governance-version-history',
    taskStatus: task.status,
    scheduleStatus: schedule.status,
    childRunCount: schedule.runIds.length,
    providerCalls,
    institutionVersion: snapshot.institution.version,
    institutionBudgetUsd: snapshot.institution.policies.societyBudgetUsd,
    auditActions: snapshot.institutionAudits.map(item => item.action),
    societyAuditActions: snapshot.audits
      .filter(item => item.taskId === task.id).map(item => item.action),
    screenshotSha256: screenshotHashes['real-workflow-governance.png'],
  };
  scenarioReports.push(report);
  await testInfo.attach('real-workflow-governance', { path: screenshotPath, contentType: 'image/png' });
  await testInfo.attach('real-workflow-governance-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});

test('对话交付在 AI 社会可下载，刷新和返工沿用原工作单', async ({ page, request }) => {
  const marker = `对话交付 ${Date.now()}`;
  const path = `outputs/society-e2e-chat-${Date.now()}/result.md`;
  await page.goto('/?view=chat');
  await page.getByPlaceholder(/跟 maharness 说点什么/).fill(`${marker}，写入约定文件 [artifact: ${path}]`);
  const created = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/v2\/sessions\/[^/]+\/runs$/.test(new URL(response.url()).pathname));
  await page.getByTestId('send-btn').click();
  const { runId, run } = await (await created).json() as { runId: string; run: { workOrderId: string } };
  await expect.poll(async () => (await request.get(`/api/v2/runs/${runId}`)).json().then(value => value.status)).toBe('completed');

  await page.goto('/?view=society');
  const openRun = () => page.getByRole('button', { name: new RegExp(marker) }).click();
  await openRun();
  const details = page.getByTestId('society-task-detail');
  const downloaded = page.waitForEvent('download');
  await details.getByRole('button', { name: '下载', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('result.md');
  await page.reload();
  await openRun();
  expect((await readRuns(request)).filter(item => item.id === runId)).toHaveLength(1);

  await details.getByRole('button', { name: '返工', exact: true }).click();
  await details.getByLabel('返工要求').fill('保留原文件，只在答复中补一条说明');
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/v2\/sessions\/[^/]+\/runs$/.test(new URL(response.url()).pathname));
  await details.getByRole('button', { name: '提交返工' }).click();
  const rework = await (await submitted).json();
  expect(rework.run).toMatchObject({ workOrderId: run.workOrderId, reworkOfRunId: runId });
  expect(rework.runId).not.toBe(runId);
  await expect(details).toContainText('保留原文件，只在答复中补一条说明');
});

test('AI 社会断线补读，停止和继续保留补充及已写入产物', async ({ page, request }) => {
  const marker = `任务暂停 ${Date.now()}`;
  const path = `outputs/society-e2e-pause-${Date.now()}/result.md`;
  providerSuccessDelayMs = 4_000;
  try {
    const session = await (await request.post('/api/sessions', { data: { model: '' } })).json();
    await page.goto(`/?view=chat&session=${encodeURIComponent(session.id)}`);
    await page.getByPlaceholder(/跟 maharness 说点什么/).fill(`${marker}，写入约定文件 [artifact: ${path}]`);
    const created = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/v2\/sessions\/[^/]+\/runs$/.test(new URL(response.url()).pathname));
    await page.getByTestId('send-btn').click();
    const { runId } = await (await created).json() as { runId: string };
    let offline = true;
    await page.route('**/api/events**', route => offline ? route.abort() : route.continue());
    await page.goto('/?view=society');
    await expect(page.getByText('连接断开，正在重连')).toBeVisible();
    offline = false;
    await expect(page.getByText('实时连接', { exact: true })).toBeVisible();
    const openRun = () => page.getByTestId('society-home').getByRole('button', { name: new RegExp(marker) }).click();
    await openRun();
    const details = page.getByTestId('society-task-detail');
    await expect(details.getByRole('button', { name: '下载', exact: true })).toBeVisible();
    await details.getByRole('button', { name: '补充或新建任务' }).click();
    await details.getByLabel('当前任务要求').fill('保留已写入文件');
    await details.getByRole('button', { name: '补充当前任务' }).click();
    await expect(details.getByText(/补充要求(?:待送达|已送达)/)).toBeVisible();
    await details.getByRole('button', { name: '停止任务' }).click();
    await expect(details.getByRole('button', { name: '继续任务' })).toBeVisible();
    await page.reload();
    await openRun();
    providerSuccessDelayMs = 0;
    await details.getByRole('button', { name: '继续任务' }).click();
    await expect(details.getByText(/补充要求已送达/)).toBeVisible();
    await expect.poll(async () => (await request.get(`/api/v2/runs/${runId}`)).json().then(value => value.status)).toBe('completed');
    const tools = await (await request.get(`/api/v2/runs/${runId}/tools`)).json();
    expect(tools.filter((tool: { name: string }) => tool.name === 'write_file')).toHaveLength(1);
    expect((await readRuns(request)).filter(item => item.id === runId)).toHaveLength(1);
  } finally { providerSuccessDelayMs = 0; }
});

test('AI 社会沿用真实工具审批，刷新等待期间不执行写入', async ({ page, request }) => {
  const marker = `审批交付 ${Date.now()}`;
  const path = `outputs/society-e2e-approval-${Date.now()}/.env`;
  const session = await (await request.post('/api/sessions', { data: { model: '' } })).json();
  const response = await request.post(`/api/v2/sessions/${session.id}/runs`, { data: { message: `${marker}，写入测试内容 [artifact: ${path}]` } });
  expect(response.ok()).toBeTruthy();
  const { runId } = await response.json();
  await expect.poll(async () => (await request.get(`/api/v2/runs/${runId}`)).json().then(value => value.status)).toBe('waiting_approval');
  await page.goto('/?view=society');
  const openRun = () => page.getByTestId('society-home').getByRole('button', { name: new RegExp(marker) }).click();
  await openRun();
  const details = page.getByTestId('society-task-detail');
  await expect(details.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  expect((await request.get(`/api/v2/runs/${runId}/artifacts`).then(result => result.json()))).toHaveLength(0);
  await page.reload();
  await openRun();
  await details.getByRole('button', { name: '批准', exact: true }).click();
  await expect.poll(async () => (await request.get(`/api/v2/runs/${runId}`)).json().then(value => value.status)).toBe('completed');
  const tools = await (await request.get(`/api/v2/runs/${runId}/tools`)).json();
  expect(tools.filter((tool: { name: string; status: string }) => tool.name === 'write_file' && tool.status === 'succeeded')).toHaveLength(1);
  expect((await readRuns(request)).filter(item => item.id === runId)).toHaveLength(1);
});

test('生产 Scheduler 自动推进真实团队并展示网络、六因子、福利、瓶颈与 token 缓存', {
  timeout: 60_000,
}, async ({ page, request }, testInfo) => {
  providerSuccessDelayMs = 10_000;
  let tickApiCalls = 0;
  page.on('request', requestEvent => {
    try {
      if (new URL(requestEvent.url()).pathname === '/api/organization/society/tick') tickApiCalls += 1;
    } catch {
      // Ignore non-URL browser requests.
    }
  });

  const initial = await readSociety(request);
  const institutions = await request.post('/api/organization/institution', {
    data: {
      policies: {
        departments: initial.departments.map(department => ({
          id: department.id,
          name: department.name,
          charter: department.charter,
          capabilities: department.capabilities,
          quotaUsd: department.id === 'knowledge' ? 0.101 : department.quotaUsd,
          quotaTokens: department.quotaTokens,
          maxConcurrent: department.maxConcurrent,
          priority: department.priority,
          enabled: department.enabled,
        })),
      },
      reason: 'E2E 团队验收设置可观测部门容量',
    },
  });
  expect(institutions.status()).toBe(201);

  const objective = `团队自动调度验收 ${Date.now()}`;
  const taskRunId = `society-e2e-${Date.now()}`;
  const task = await createTeamTask(request, {
    objective,
    departmentId: 'knowledge',
    branches: [
      {
        objective: '整理来源核查结论',
        acceptance: ['列出可核对结论与限制'],
        expectedArtifacts: [`outputs/${taskRunId}/research.md`],
        departmentId: 'knowledge',
        maxBudgetTokens: 100_000,
      },
      {
        objective: '复核交付内容质量',
        acceptance: ['给出独立复核结论'],
        expectedArtifacts: [`outputs/${taskRunId}/review.md`],
        departmentId: 'quality',
        maxBudgetTokens: 100_000,
      },
    ],
  });

  const activeSchedule = await waitForTeamSchedule(request, task.id);
  const active = await readSociety(request);
  const activeScheduleSnapshot = active.schedules.find(item => item.id === activeSchedule.id)!;
  expect(activeScheduleSnapshot.mode).toBe('team');
  expect(activeScheduleSnapshot.runIds).toHaveLength(2);
  expect(activeScheduleSnapshot.contractIds).toHaveLength(2);
  expect(active.bottlenecks.length).toBeGreaterThan(0);

  await page.goto('/?view=society');
  await expect(page.getByTestId('society-home')).toBeVisible();
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();
  const society = page.getByTestId('society-console');
  await expect(society).toBeVisible();
  await refreshWorkbench(page);

  await expect(society.getByText('团队 2', { exact: true }).first()).toBeVisible();
  await expect(society.getByText(active.bottlenecks[0]!.detail, { exact: true }).first()).toBeVisible();

  const selection = society.getByTestId(`society-selection-${activeScheduleSnapshot.id}`);
  await expect(selection).toBeVisible();
  await openDetails(selection);
  await expect(selection.getByText(
    /能力 \d+% · 记忆 \d+% · 工具 \d+% · 协作 \d+% · 履历 \d+% · 负载 \d+%/,
  ).first()).toBeVisible();

  const wellbeing = society.getByTestId('society-role-wellbeing');
  await openDetails(wellbeing);
  expect(await wellbeing.locator('[data-testid^="wellbeing-"]').count()).toBeGreaterThanOrEqual(2);

  const institutionDetails = society.locator('details').filter({ hasText: '制度版本、配额与审计' }).first();
  await openDetails(institutionDetails);
  await expect(society.getByText(`${active.network.nodes.length} 成员`, { exact: true })).toBeVisible();
  await expect(society.getByText(`${active.network.edges.length} 协作关系`, { exact: true })).toBeVisible();

  const activeScreenshot = await captureScreenshot(page, 'real-workflow-team-active.png');
  expect(tickApiCalls).toBe(0);

  const awaiting = await waitForTaskStatus(request, task.id, 'awaiting_acceptance');
  await refreshWorkbench(page);
  await expect(society.getByText('待你验收', { exact: true }).first()).toBeVisible();
  await expect(society.getByText('2 个 Run', { exact: false }).first()).toBeVisible();
  await openDetails(society.locator('details').filter({ hasText: '制度版本、配额与审计' }).first());

  const ledgers = awaiting.snapshot.economics.taskLedger;
  const ledger = ledgers.find(item => item.taskId === task.id)!;
  expect(ledger.actualTokens).toBeGreaterThan(0);
  expect(ledger.cacheUsageStatus).toBe('known');
  expect(awaiting.snapshot.economics.cacheUsageStatus).toBe('known');
  expect(awaiting.snapshot.economics.compression.officialTokenCount).toBeGreaterThan(0);
  await expect(society.getByText('角色 token 账本', { exact: true })).toBeVisible();
  await expect(society.getByText('任务 token 账本与估算 ROI', { exact: true })).toBeVisible();
  await expect(society.getByText(/缓存命中率：0%/).first()).toBeVisible();
  await expect(society.getByText(
    new RegExp(`缓存命中 0 / 未命中 ${ledger.cacheMissInputTokens}`),
  ).first()).toBeVisible();

  const awaitingScreenshot = await captureScreenshot(page, 'real-workflow.png');
  await society.getByRole('button', { name: '确认交付' }).first().click();
  await expect(page.getByText('任务已释放，角色履历与关系已更新')).toBeVisible();

  const completed = await waitForTaskStatus(request, task.id, 'completed');
  const runs = (await readRuns(request)).filter(item => item.origin?.scheduleId === activeSchedule.id);
  expect(runs).toHaveLength(2);
  expect(runs.every(item => item.status === 'completed')).toBe(true);
  const workOrder = await readWorkOrder(request, completed.schedule.workOrderId!);
  expect(workOrder.contracts).toHaveLength(2);
  expect(workOrder.contracts.every(item => item.status === 'delivered')).toBe(true);

  const finalScreenshot = await captureScreenshot(page, 'real-workflow-team-final.png');
  expect(tickApiCalls).toBe(0);
  const report: EvidenceReport = {
    scenario: 'team-auto-scheduler-ui',
    taskStatus: completed.task.status,
    scheduleStatus: completed.schedule.status,
    scheduleMode: completed.schedule.mode,
    childRunCount: runs.length,
    contractCount: workOrder.contracts.length,
    networkNodeCount: active.network.nodes.length,
    networkEdgeCount: active.network.edges.length,
    bottleneckKinds: [...new Set(active.bottlenecks.map(item => item.kind))],
    selectionFactors: ['capability', 'memory', 'tools', 'collaboration', 'history', 'load'],
    wellbeingRoleCount: awaiting.snapshot.roleLife.filter(item => item.wellbeing).length,
    officialTokenCount: awaiting.snapshot.economics.compression.officialTokenCount,
    actualTokenCount: ledger.actualTokens,
    cacheUsageStatus: awaiting.snapshot.economics.cacheUsageStatus,
    cachedInputTokens: awaiting.snapshot.economics.cachedInputTokens,
    cacheMissInputTokens: awaiting.snapshot.economics.cacheMissInputTokens,
    cacheWriteUsageStatus: awaiting.snapshot.economics.cacheWriteUsageStatus,
    providerCalls,
    schedulerTickApiCalls: tickApiCalls,
    schedulerAutoAdvanced: true,
    collaborationNetworkUi: true,
    bottleneckUi: true,
    sixFactorUi: true,
    wellbeingUi: true,
    tokenCacheUi: true,
    activeScreenshotSha256: screenshotHashes['real-workflow-team-active.png'],
    awaitingScreenshotSha256: screenshotHashes['real-workflow.png'],
    finalScreenshotSha256: screenshotHashes['real-workflow-team-final.png'],
  };
  scenarioReports.push(report);
  await testInfo.attach('real-workflow-team-active', { path: activeScreenshot, contentType: 'image/png' });
  await testInfo.attach('real-workflow', { path: awaitingScreenshot, contentType: 'image/png' });
  await testInfo.attach('real-workflow-team-final', { path: finalScreenshot, contentType: 'image/png' });
  await testInfo.attach('real-workflow-team-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});

test('真实 child Run 失败后由 RunService 与 SocietyService 回退单角色并留下标记', {
  timeout: 90_000,
}, async ({ page, request }, testInfo) => {
  let tickApiCalls = 0;
  page.on('request', requestEvent => {
    try {
      if (new URL(requestEvent.url()).pathname === '/api/organization/society/tick') tickApiCalls += 1;
    } catch {
      // Ignore non-URL browser requests.
    }
  });

  const institution = await readSociety(request);
  const institutions = await request.post('/api/organization/institution', {
    data: {
      policies: {
        departments: institution.departments.map(department => ({
          ...department,
          quotaUsd: department.id === 'knowledge'
            ? Math.max(department.quotaUsd, 1)
            : department.quotaUsd,
        })),
      },
      reason: 'E2E 回退验收准备部门回退容量',
    },
  });
  expect(institutions.status()).toBe(201);

  const failureMarker = `E2E_FAIL_CHILD_${Date.now()}`;
  providerFailMarker = failureMarker;
  providerFailureDelayMs = 500;
  providerSuccessDelayMs = 1_000;
  const objective = `团队失败回退验收 ${Date.now()}`;
  const taskRunId = `society-e2e-rollback-${Date.now()}`;
  const task = await createTeamTask(request, {
    objective,
    departmentId: 'knowledge',
    branches: [
      {
        objective: `整理来源核查结论 ${failureMarker}`,
        acceptance: ['列出可核对结论与限制'],
        expectedArtifacts: [`outputs/${taskRunId}/research.md`],
        departmentId: 'knowledge',
        maxBudgetTokens: 100_000,
      },
      {
        objective: '复核交付内容质量',
        acceptance: ['给出独立复核结论'],
        expectedArtifacts: [`outputs/${taskRunId}/review.md`],
        departmentId: 'quality',
        maxBudgetTokens: 100_000,
      },
    ],
  });

  const initialSchedule = await waitForTeamSchedule(request, task.id);
  const initialRuns = (await readRuns(request)).filter(item => item.origin?.scheduleId === initialSchedule.id);
  expect(initialRuns).toHaveLength(2);
  const initialWorkOrder = await readWorkOrder(request, initialSchedule.workOrderId!);
  expect(initialWorkOrder.contracts).toHaveLength(2);

  const fallback = await waitForRollback(request, task.id);
  expect(fallback.schedule.mode).toBe('solo');
  expect(fallback.schedule.roleIds).toHaveLength(1);
  expect(fallback.fallbackRun.fallbackReason).toBe('ROLLBACK_TO_SOLO');
  expect(fallback.runs.some(item => item.status === 'failed' && item.id !== fallback.fallbackRun.id)).toBe(true);

  await page.goto('/?view=society');
  await expect(page.getByTestId('society-home')).toBeVisible();
  await page.getByText('制度、角色负载、费用账本与历史调度', { exact: true }).click();
  const society = page.getByTestId('society-console');
  await expect(society).toBeVisible();
  await refreshWorkbench(page);
  await expect(society.getByText(objective, { exact: true }).first()).toBeVisible();
  await expect(society.getByText('单角色', { exact: true }).first()).toBeVisible();
  await expect(society.getByText(/团队失败后回退单角色/).first()).toBeVisible();
  const fallbackScreenshot = await captureScreenshot(page, 'real-workflow-rollback-active.png');
  expect(tickApiCalls).toBe(0);

  const awaiting = await waitForTaskStatus(request, task.id, 'awaiting_acceptance');
  await refreshWorkbench(page);
  await society.getByRole('button', { name: '确认交付' }).first().click();
  await expect(page.getByText('任务已释放，角色履历与关系已更新')).toBeVisible();

  const completed = await waitForTaskStatus(request, task.id, 'completed');
  expect(completed.schedule.mode).toBe('solo');
  const finalRuns = (await readRuns(request)).filter(item => item.origin?.scheduleId === completed.schedule.id);
  const failedChildren = finalRuns.filter(item => item.status === 'failed' && item.fallbackReason !== 'ROLLBACK_TO_SOLO');
  const fallbackRun = finalRuns.find(item => item.fallbackReason === 'ROLLBACK_TO_SOLO')!;
  expect(failedChildren.length).toBeGreaterThanOrEqual(1);
  expect(fallbackRun.status).toBe('completed');

  const workOrder = await readWorkOrder(request, completed.schedule.workOrderId!);
  expect(workOrder.contracts.length).toBeGreaterThanOrEqual(3);
  expect(workOrder.contracts.some(item => item.status === 'collapsed')).toBe(true);
  expect(workOrder.contracts.some(item => item.status === 'delivered')).toBe(true);

  const finalScreenshot = await captureScreenshot(page, 'real-workflow-rollback.png');
  expect(tickApiCalls).toBe(0);
  const report: EvidenceReport = {
    scenario: 'failed-child-rollback-to-solo',
    taskStatus: completed.task.status,
    initialScheduleMode: 'team',
    initialChildRunCount: initialRuns.length,
    initialContractCount: initialWorkOrder.contracts.length,
    childRunCount: finalRuns.length,
    contractCount: workOrder.contracts.length,
    fallbackMode: completed.schedule.mode,
    fallbackRunStatus: fallbackRun.status,
    rollbackMarker: fallbackRun.fallbackReason,
    failedChildCount: failedChildren.length,
    contractStatuses: [...new Set(workOrder.contracts.map(item => item.status))].sort(),
    societyAuditActions: completed.snapshot.audits
      .filter(item => item.taskId === task.id).map(item => item.action),
    providerCalls,
    schedulerTickApiCalls: tickApiCalls,
    schedulerAutoAdvanced: true,
    soloUi: true,
    rollbackReasonUi: true,
    activeScreenshotSha256: screenshotHashes['real-workflow-rollback-active.png'],
    finalScreenshotSha256: screenshotHashes['real-workflow-rollback.png'],
  };
  scenarioReports.push(report);
  await testInfo.attach('real-workflow-rollback-active', { path: fallbackScreenshot, contentType: 'image/png' });
  await testInfo.attach('real-workflow-rollback', { path: finalScreenshot, contentType: 'image/png' });
  await testInfo.attach('real-workflow-rollback-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
