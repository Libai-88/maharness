import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const provider = { id: 'design', label: '设计模型', baseUrl: 'https://example.test/v1', model: 'design-model', protocol: 'openai', enabled: true, hasKey: true, apiKeyMasked: 'sk-***', createdAt: 1, updatedAt: 8 };
const initialConfig = {
  revision: 'config-1', context: { maxTokens: 60000, truncateInject: true }, cache: { l1Enabled: false, l2TtlMin: 30, l3Enabled: true },
  agent: { fallbackProviders: [], thinkInEnglish: false }, provider: {},
  taskTypes: ['默认', '代码'], routingTargets: [{ value: 'design@design-model', label: '设计模型', vision: true, contextWindow: 64000 }],
};
const stats = {
  overview: { sessions: 2, messages: 18, tokensIn: 2000, tokensOut: 500, cost: 0.02, truncations: 1 },
  process: { steps: 10, llmCalls: 5, toolCalls: 5, cost: 0.02 },
  context: { maxTokens: 60000, quality: { injections: 4, compactions: 1, truncations: 1, modelRoutes: 1, reasoningHints: 0, toolDefinitions: 20, toolDefBytes: 7000 } },
  cache: { l1Enabled: true, l1Threshold: 0.58, l2TtlMin: 30, l1: { hits: 2, misses: 8, rate: 20 }, l2: { hits: 4, misses: 6, rate: 40 }, l3: { hits: 1, tokens: 300, realHits: 0, realTokens: 0, realRate: 0 }, overall: { served: 6, rate: 30 }, savedCost: 0.01 },
};

async function setup(page: Page) {
  let sessions = ['设计检查', '历史会话'].map((title, index) => ({ id: `design-${index}`, title, mode: 'normal', pinned: 0, archived: 0, updatedAt: Date.now(), createdAt: Date.now() }));
  let config = structuredClone(initialConfig);
  let fileText = '# 设计检查\n\n文件内容';
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() ?? {};
    if (method !== 'GET') mutations.push({ path, body });
    let data: unknown = {};
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/sessions') data = sessions;
    else if (/\/api\/sessions\/design-\d$/.test(path) && method === 'PATCH') {
      sessions = sessions.map((session) => session.id === path.split('/').pop() ? { ...session, ...body } : session);
      data = sessions.find((session) => session.id === path.split('/').pop());
    } else if (/\/messages$/.test(path)) data = [];
    else if (/\/checkpoint$/.test(path)) data = { exists: false };
    else if (path === '/api/models') data = [{ id: 'design@design-model', provider: 'design', model: 'design-model', label: '设计模型' }];
    else if (path === '/api/providers') data = method === 'GET' ? [provider] : { ...provider, ...body };
    else if (path === '/api/providers/models') data = { models: [{ id: 'vision-model', vision: true, tools: true, reasoning: false, contextWindow: 128000, priceIn: 0.2, priceOut: 0.8 }] };
    else if (path === '/api/providers/test') data = { ok: true, latencyMs: 28 };
    else if (path === '/api/providers/design/tool-check') data = { status: 'confirmed', checkedAt: Date.now() };
    else if (path === '/api/v2/workspace/permissions') data = { profile: 'standard', revision: 0, workspace: 'D:/workspace' };
    else if (path === '/api/items') data = { items: [], projects: [] };
    else if (path === '/api/workbench/summary') data = {
      schemaVersion: 1, today: new Date().toISOString().slice(0, 10), todayItems: [], overdue: [], upcoming: [], unscheduled: [],
      pendingAutomations: [], automations: [], recentRuns: [], artifacts: [], projects: [], notes: [],
      metrics: { schemaVersion: 1, firstTaskSuccessRate: null, takeoverRate: null, recoveredAfterFailureRate: null, automaticRecoveryRate: null, invalidToolCalls: 0, duplicateToolCalls: 0, capabilitySelectionFailures: 0, durationMs: 0, modelCalls: 0, costUsd: 0 },
    };
    else if (path === '/api/automations') data = { automations: [], occurrences: [] };
    else if (path === '/api/v2/runs') data = [];
    else if (path === '/api/providers/design') data = { ...provider, ...body };
    else if (path === '/api/config') {
      if (method === 'PATCH') {
        config = { ...config, ...body, context: { ...config.context, ...body.context as object }, cache: { ...config.cache, ...body.cache as object }, agent: { ...config.agent, ...body.agent as object } };
        data = { ok: true, revision: 'config-2' };
      } else data = config;
    } else if (path === '/api/stats') data = stats;
    else if (path === '/api/plugins') data = [{ id: 'design-plugin', name: '示例插件', version: '1.0.0', state: 'started', description: '检查插件交互与布局', caps: ['tool'], watched: true }];
    else if (path === '/api/plugins/diagnostics') data = [];
    else if (path === '/api/nav') data = { items: [] };
    else if (path === '/api/trace/stats') data = { trace: {}, cache: {}, l1Enabled: true };
    else if (path === '/api/personas') data = [{ id: 'design-persona', name: '代码助手', enabled: true, content: '准确、简洁地解释代码。' }];
    else if (path === '/api/security') data = { bind: '127.0.0.1:3000', mutationAuthRequired: true, mutationTokenHeader: 'x-maharness-token', approvalTokenRequired: true, masterKey: { state: 'ready', available: true }, credentials: { broken: [] }, policy: {} };
    else if (path === '/api/skills') data = { installed: [{ name: 'design-skill', description: '界面设计指南', source: 'user' }], market: [] };
    else if (path === '/api/skills/user/design-skill/read') data = { content: '# Design\n\n组件规范' };
    else if (path === '/api/skills/lock') data = { skills: [] };
    else if (path === '/api/rules') data = { globalFiles: [{ name: 'global.md', content: '全局规则正文' }], projectFiles: [{ name: 'AGENTS.md', content: '项目规则正文' }], policy: [], errors: [], promptChars: 12, policyRevisions: { global: 'global-1', project: 'project-1' }, ruleFileRevisions: { global: { 'global.md': 'global-file-1', 'new-rule.md': 'missing' }, project: { 'AGENTS.md': 'project-file-1' } } };
    else if (path === '/api/workspaces') data = [{ id: 'workspace', path: 'D:/workspace', current: true }];
    else if (path === '/api/files/tree') data = { entries: [{ name: 'README.md', type: 'file', size: 40 }] };
    else if (path === '/api/files/read') data = { path: 'README.md', text: fileText };
    else if (path === '/api/files/write') { fileText = body.content; data = { ok: true }; }
    else if (path === '/api/git/status') data = { repo: true, branch: 'main', ahead: 0, staged: [], changes: [] };
    else if (/\/config$/.test(path)) data = { config: {} };
    else if (/\/panel$/.test(path)) data = { title: '扩展信息', html: '<p>插件配置完整</p>' };
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  return mutations;
}

async function openSettings(page: Page, tab?: string) {
  if (await page.getByRole('button', { name: '设置', exact: true }).isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click();
  else { await page.getByRole('button', { name: 'Toggle Sidebar' }).click(); await page.getByRole('button', { name: '设置', exact: true }).click(); }
  await expect(page.getByRole('tab', { name: '通用', exact: true })).toBeVisible();
  if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
}

async function openAdvancedPage(page: Page, label: '插件管理' | '运行记录' | '缓存与成本') {
  await openSettings(page, '高级');
  await page.getByRole('button', { name: label, exact: true }).click();
}

test('侧边栏选择当前或其他会话会退出功能页及设置，保留会话内容', async ({ page }) => {
  await setup(page);
  await page.route('**/api/sessions/*/messages', route => route.fulfill({ json: [{ id: 'saved-message', role: 'user', content: '已保存的会话内容', ts: 1 }] }));
  await page.reload();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByText('已保存的会话内容', { exact: true })).toBeVisible();
  const sessions = page.locator('[data-sidebar="menu-button"][data-size="lg"]');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await sessions.first().click();
  await expect(input).toBeVisible();
  await expect(page.getByText('已保存的会话内容', { exact: true })).toBeVisible();
  await openSettings(page);
  await sessions.nth(1).click();
  await expect(input).toBeVisible();
  await expect(page.getByRole('tab', { name: '通用', exact: true })).toHaveCount(0);
  await expect(page.getByText('已保存的会话内容', { exact: true })).toBeVisible();
});

test('固定功能页和设置的关闭按钮直接返回会话', async ({ page }) => {
  await setup(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(input).toBeVisible();
  for (const name of ['文件', '工作台', '自动化']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: '关闭页面，返回会话', exact: true }).click();
    await expect(input).toBeVisible();
  }
  await openSettings(page);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(input).toBeVisible();
  for (const name of ['插件管理', '运行记录', '缓存与成本'] as const) {
    await openAdvancedPage(page, name);
    await page.getByRole('button', { name: '关闭页面，返回会话', exact: true }).click();
    await expect(input).toBeVisible();
  }
});

test('主导航固定四项，浏览器后退与 Esc 返回会话', async ({ page }) => {
  await setup(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  for (const name of ['会话', '文件', '工作台', '自动化']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page).toHaveURL(/view=workbench/);
  await page.goBack();
  await expect(input).toBeVisible();
  await expect(page).toHaveURL(/view=chat/);
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  await expect(page).toHaveURL(/view=automations/);
  await page.keyboard.press('Escape');
  await expect(input).toBeVisible();
});

test('工作台新增事项后立即刷新聚合结果', async ({ page }) => {
  await setup(page);
  const items: Record<string, unknown>[] = [];
  let posted: Record<string, unknown> | undefined;
  await page.route('**/api/items', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted = route.request().postDataJSON();
    const item = { id: 'item-new', title: posted.title, lifecycle: 'todo', revision: 0 };
    items.push(item);
    return route.fulfill({ json: { item } });
  });
  await page.route('**/api/workbench/summary*', route => route.fulfill({
    json: {
      schemaVersion: 1, today: new Date().toISOString().slice(0, 10), todayItems: items, overdue: [], upcoming: [], unscheduled: [],
      pendingAutomations: [], automations: [], recentRuns: [], artifacts: [], projects: [], notes: [],
      metrics: { schemaVersion: 1, firstTaskSuccessRate: null, takeoverRate: null, recoveredAfterFailureRate: null, automaticRecoveryRate: null, invalidToolCalls: 0, duplicateToolCalls: 0, capabilitySelectionFailures: 0, durationMs: 0, modelCalls: 0, costUsd: 0 },
    },
  }));

  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByLabel('新增事项').fill('整理明天会议资料');
  await page.getByRole('button', { name: '添加', exact: true }).click();

  await expect(page.getByText('整理明天会议资料', { exact: true })).toBeVisible();
  expect(posted).toMatchObject({ title: '整理明天会议资料' });
  expect(posted?.timeZone).toBeTruthy();
  expect(posted?.operationId).toBeTruthy();
});

test('周期自动化创建后待确认，确认后才启用', async ({ page }) => {
  await setup(page);
  let revision = 0;
  let automation: Record<string, unknown> | undefined;
  const automationPayload = () => ({
    id: 'automation-weekly', workspace: 'D:/workspace', createdBy: 'user', materials: [],
    name: '每周整理项目进展', prompt: '整理本周新增文件并生成进展摘要。',
    trigger: { type: 'schedule', recurrence: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', dayOfWeek: 1 },
    createdAt: Date.now(), updatedAt: Date.now(), ...automation,
  });
  await page.route('**/api/automations', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      revision = 0;
      automation = { ...input, state: 'draft', approval: 'pending', revision };
      return route.fulfill({ json: { automation: automationPayload() } });
    }
    return route.fulfill({ json: { automations: automation ? [automationPayload()] : [], occurrences: [] } });
  });
  await page.route('**/api/automations/*/confirm', async route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ revision });
    revision++;
    automation = { ...automation, state: 'active', approval: 'approved', revision };
    return route.fulfill({ json: { automation: automationPayload() } });
  });

  await page.getByRole('button', { name: '自动化', exact: true }).click();
  await page.getByLabel('名称').fill('每周整理项目进展');
  await page.getByLabel('要执行的任务').fill('整理本周新增文件并生成进展摘要。');
  await page.getByRole('combobox', { name: '触发方式' }).click();
  await page.getByRole('option', { name: '周期时间' }).click();
  await page.getByRole('button', { name: '创建自动化', exact: true }).click();

  await expect(page.getByText('待确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  expect(revision).toBe(1);
});

async function checkAccessibility(page: Page) {
  await expect.poll(() => page.locator('[data-sonner-toast][data-removed="false"]').evaluateAll((elements) => elements.every((element) => getComputedStyle(element).opacity === '1'))).toBe(true);
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string }[] }[] }> } }).axe.run();
    return result.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical').map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [1440, 390]) test(`任务诊断展示输入分项和恢复来源，兼容历史记录 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  const run = { billingNotice: '部分模型调用的用量或价格尚未确认，请在任务结束后核对。', id: 'diagnostic-run', sessionId: 'design-0', objective: '核对恢复后的材料', model: 'design-model', providerId: 'design', status: 'interrupted', cost: 0, tokensIn: 0, tokensOut: 0, createdAt: 0, updatedAt: 0, usageStatus: 'unknown', error: '操作结果未知，禁止自动重放', authorization: { workspace: 'fixture', profile: 'standard', readOnly: false, revision: 0 } };
  await page.route('**/api/v2/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v2/runs') return route.fulfill({ json: [run] });
    if (path.endsWith('/tools')) return route.fulfill({ json: [{ id: 'unknown-call', name: 'command_start', status: 'unknown', argsSummary: 'command', failure: { code: 'TOOL_INTERRUPTED', retryable: false, outcome: 'unknown' } }] });
    if (path.endsWith('/model-calls')) return route.fulfill({ json: [{ id: 'vision-call', purpose: 'vision', providerId: 'design', model: 'design-model', status: 'completed', usageStatus: 'unknown', priceSource: 'unknown', inputEstimate: 12 }] });
    if (path.endsWith('/inputs')) return route.fulfill({ json: [
      { id: 'new-input', turn: 1, providerId: 'design', model: 'design-model', createdAt: 0, messages: [{ role: 'user', content: '核对材料' }], tools: [{ name: 'read_file' }], diagnostics: { messageTokens: 12, toolTokens: 5, sources: [{ source: 'user', tokens: 12 }], fingerprint: 'f'.repeat(64), attemptId: 'attempt-2', resumedFromTurn: 0 } },
      { id: 'old-input', turn: 0, providerId: 'design', model: 'design-model', createdAt: 0, messages: [], tools: [] },
    ] });
    return route.fulfill({ json: [] });
  });
  await openAdvancedPage(page, '运行记录');
  await page.getByRole('button', { name: '诊断与子任务' }).click();
  const panel = page.getByTestId('run-diagnostics');
  await expect(panel).toContainText('用量不完整');
  await expect(panel).toContainText('视觉分析');
  await expect(panel).toContainText('费用待核对');
  await expect(panel).toContainText('请在任务结束后核对');
  await expect(panel).toContainText('操作结果未知');
  await expect(panel).toContainText('机器验收 · 尚未验证');
  await expect(panel).toContainText('结果未知，禁止自动重放');
  await expect(panel).toContainText('错误码：TOOL_INTERRUPTED · 副作用：未知 · 不可自动重试');
  await panel.locator('summary').filter({ hasText: '第 2 轮' }).click();
  await expect(panel.getByText(/本地估算：消息 12 tokens/)).toBeVisible();
  await expect(panel.getByText(/执行尝试：attempt-2/)).toContainText('恢复断点：第 1 轮');
  await panel.locator('summary').filter({ hasText: '第 1 轮' }).click();
  await expect(panel.getByText('输入分项：未记录')).toBeVisible();
  await checkAccessibility(page);
  await page.screenshot({ path: `test-results/strengthening-diagnostics-${width}.png`, fullPage: true });
});

for (const [type, label] of [['task_verified', '机器验收通过'], ['task_partial', '机器验收部分通过'], ['task_failed', '机器验收未通过']]) test(`执行完成独立显示${label}`, async ({ page }) => {
  await setup(page);
  const run = { id: 'verified-run', sessionId: 'design-0', objective: '核对产物', model: 'design-model', providerId: 'design', status: 'completed', verification: { type }, cost: 0, tokensIn: 0, tokensOut: 0, createdAt: 0, updatedAt: 0, authorization: { workspace: 'fixture', profile: 'standard', readOnly: false, revision: 0 } };
  await page.route('**/api/v2/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/v2/runs' ? [run] : [] }));
  await openAdvancedPage(page, '运行记录');
  await page.getByRole('button', { name: '诊断与子任务' }).click();
  await expect(page.getByTestId('run-diagnostics')).toContainText(`机器验收 · ${label}`);
  await expect(page.getByTestId('run-diagnostics')).toContainText('执行完成');
});

test('设置主题与品牌选择即时生效并保留偏好', async ({ page }) => {
  await setup(page);
  await openSettings(page);
  await page.getByRole('radio', { name: '苔绿', exact: true }).click();
  await page.getByRole('switch', { name: '切换深色主题' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-brand', 'moss');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await checkAccessibility(page);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-brand', 'moss');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

for (const width of [1440, 390]) test(`任务插件授权默认关闭并独立确认 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await setup(page);
  let permission = { workspace: 'D:/workspace', profile: 'standard', revision: 0, pluginDevelopment: { enabled: false, permissions: [] as string[], dependencies: [] as string[] } };
  const changes: Record<string, unknown>[] = [];
  await page.route('**/api/v2/workspace/**', async route => {
    if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); changes.push(body); permission = { ...permission, revision: permission.revision + 1, pluginDevelopment: body }; }
    return route.fulfill({ json: permission });
  });
  await openSettings(page, '高级');
  const toggle = page.getByRole('switch', { name: '任务插件开发', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click(); await expect(page.getByRole('alertdialog')).toContainText('可信宿主');
  expect(changes).toHaveLength(0);
  await page.getByRole('button', { name: '授权任务插件开发', exact: true }).click();
  await expect(toggle).toBeChecked();
  expect(changes[0]).toMatchObject({ enabled: true, permissions: ['workspace.read', 'workspace.write'], revision: 0 });
  await expect(page.getByRole('switch', { name: '开发者权限', exact: true })).not.toBeChecked();
  await page.getByRole('switch', { name: '网络工具', exact: true }).click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1]).toMatchObject({ permissions: ['workspace.read', 'workspace.write', 'network'], revision: 1 });
  await checkAccessibility(page);
});

for (const width of [1440, 390]) test(`任务插件版本、保存与净化面板 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await setup(page);
  const run = { id: 'plugin-run', sessionId: 'design-0', objective: '插件任务', model: 'design-model', providerId: 'design', status: 'running', cost: 0, tokensIn: 0, tokensOut: 0, createdAt: 0, updatedAt: 0, authorization: { workspace: 'fixture', profile: 'standard', readOnly: false, revision: 0 } };
  let saved = false;
  await page.route('**/api/v2/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v2/runs') return route.fulfill({ json: [run] });
    if (path.endsWith('/plugins')) return route.fulfill({ json: { plugins: [{ id: 'sample', version: '1.2.0', hash: 'abc123456789def', scope: 'run', state: 'active', manifest: { name: '结果插件', requires: ['data-source'], permissions: { capabilities: { api: ['panel'], tool: ['sample_result'] } } } }] } });
    if (path.endsWith('/save')) { expect(route.request().postDataJSON()).toEqual({ hash: 'abc123456789def' }); saved = true; return route.fulfill({ json: { saved: true } }); }
    if (path.endsWith('/api/panel')) return route.fulfill({ json: { title: '结果面板', html: '<p>value=29</p><script>window.pluginUnsafe=true</script><img src=x onerror="window.pluginUnsafe=true">' } });
    return route.fulfill({ json: [] });
  });
  await openAdvancedPage(page, '运行记录'); await page.getByRole('button', { name: '诊断与子任务' }).click();
  const panel = page.getByTestId('run-diagnostics'); await expect(panel).toContainText('abc123456789'); await expect(panel).toContainText('data-source');
  await panel.getByRole('button', { name: '查看面板' }).click(); await expect(panel).toContainText('value=29');
  expect(await page.evaluate(() => (window as unknown as { pluginUnsafe?: boolean }).pluginUnsafe)).toBeUndefined();
  await panel.getByRole('button', { name: '保存到工作区' }).click(); await expect.poll(() => saved).toBe(true);
});

test('首次配置流程只在用户检测后请求模型，再选择工作区并开始任务', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page);
  const guide = page.getByTestId('getting-started');
  await expect(guide).toContainText('1 · 配置模型');
  expect(mutations.some(item => item.path.endsWith('/tool-check'))).toBe(false);
  await guide.getByRole('button', { name: '下一步' }).click();
  await expect(guide.getByRole('button', { name: '下一步' })).toBeDisabled();
  await guide.getByRole('button', { name: '检测连接与工具调用（模型请求可能计费）' }).click();
  await expect(guide).toContainText('连接成功');
  await guide.getByRole('button', { name: '下一步' }).click();
  await expect(guide).toContainText('3 · 选择工作区');
  await guide.getByRole('button', { name: '下一步' }).click();
  await expect(guide).toContainText('常规权限');
  await guide.getByRole('button', { name: '开始任务' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  expect(mutations.filter(item => item.path.endsWith('/tool-check')).length).toBe(1);
});

test('备用线路由用户显式开启并保存顺序', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page, '备用线路');
  await page.getByRole('switch', { name: '设计模型', exact: true }).click();
  await expect.poll(() => (mutations.find(item => item.path === '/api/config')?.body.agent as { fallbackProviders?: string[] })?.fallbackProviders).toEqual(['design']);
  await expect(page.getByText('备用顺序 1')).toBeVisible();
});

test('Provider 表单有标签、可搜索拉取模型并保留并发版本', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page, '模型与 Provider');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('Provider 名称')).toHaveValue('设计模型');
  await page.getByRole('button', { name: '拉取模型列表' }).click();
  await page.getByRole('combobox', { name: /选择已拉取的模型/ }).click();
  await page.getByPlaceholder('搜索模型…').fill('vision');
  await page.getByRole('option', { name: /vision-model/ }).click();
  await expect(page.getByLabel('模型名', { exact: true })).toHaveValue('vision-model');
  await expect(page.getByLabel('输入价格（USD / 1M tokens）')).toHaveValue('0.2');
  await checkAccessibility(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => mutations.find((item) => item.path === '/api/providers/design')?.body.expectedUpdatedAt).toBe(8);
});

test('上下文容量提交设置且相似答案缓存默认关闭', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page, '上下文管理');
  const capacity = page.getByLabel('context.maxTokens', { exact: true });
  await capacity.fill('48000');
  await capacity.press('Tab');
  await expect.poll(() => mutations.filter((item) => item.path === '/api/config').length).toBe(1);
  await expect(capacity).toHaveValue('48000');
  await expect(page.getByText('默认关闭。每次任务均交由当前模型处理。')).toBeVisible();
  await checkAccessibility(page);
});

test('项目与全局规则切换读取正确正文，保存携带文件版本', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page, '用户规则');
  await expect(page.getByLabel('规则正文')).toHaveValue('项目规则正文');
  await page.getByRole('radio', { name: '全局', exact: true }).click();
  await expect(page.getByLabel('规则正文')).toHaveValue('全局规则正文');
  await page.getByLabel('规则正文').fill('全局保存内容');
  await page.getByRole('button', { name: '保存规则' }).click();
  await expect.poll(() => mutations.find((item) => item.path === '/api/rules/global/global.md')?.body.revision).toBe('global-file-1');
  await page.getByRole('radio', { name: '项目', exact: true }).click();
  await expect(page.getByLabel('规则正文')).toHaveValue('项目规则正文');
  await checkAccessibility(page);
});

test('会话重命名可取消，批选采用独立复选框', async ({ page }) => {
  const mutations = await setup(page);
  const session = page.getByRole('button', { name: /设计检查/ }).first();
  await session.focus();
  await session.press('F2');
  await page.getByRole('textbox', { name: '重命名会话' }).fill('取消的标题');
  await page.keyboard.press('Escape');
  expect(mutations.filter((item) => item.body.title)).toHaveLength(0);
  await session.press('F2');
  await page.getByRole('textbox', { name: '重命名会话' }).fill('新的标题');
  await page.keyboard.press('Enter');
  await expect.poll(() => mutations.filter((item) => item.body.title).length).toBe(1);
  await page.getByRole('button', { name: '批量管理会话' }).click();
  await page.getByRole('checkbox', { name: /选择会话 新的标题/ }).check();
  await expect(page.getByText('1 已选')).toBeVisible();
  await page.getByRole('checkbox', { name: '全选', exact: true }).check();
  await expect(page.getByText('2 已选')).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

for (const width of [390, 900, 1440]) {
  test(`${width}px 页面布局、表单与详情可访问`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await openSettings(page);
    await checkAccessibility(page);
    await page.screenshot({ path: testInfo.outputPath('settings.png') });
    for (const name of ['模型与 Provider', '备用线路', '人设与提示词', '技能系统', '高级']) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await checkAccessibility(page);
    }
    await page.getByRole('button', { name: '关闭设置' }).click();
    for (const name of ['插件管理', '缓存与成本'] as const) {
      await openAdvancedPage(page, name);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
      await checkAccessibility(page);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      await page.getByRole('button', { name: '关闭页面，返回会话', exact: true }).click();
    }
  });
}

test('文件预览、编辑和全屏保存保持同一内容', async ({ page }) => {
  const mutations = await setup(page);
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByText('文件内容', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑 README.md' }).fill('# 保存的内容');
  await page.getByRole('textbox', { name: '编辑 README.md' }).press('Control+s');
  await expect.poll(() => mutations.find((item) => item.path === '/api/files/write')?.body.content).toBe('# 保存的内容');
  await expect(page.getByText('# 保存的内容', { exact: false })).toBeVisible();
  await checkAccessibility(page);
});
