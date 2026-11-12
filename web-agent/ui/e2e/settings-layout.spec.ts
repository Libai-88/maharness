import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const provider = { id: 'design', label: '设计模型', baseUrl: 'https://example.test/v1', model: 'design-model', protocol: 'openai', enabled: true, hasKey: true, apiKeyMasked: 'sk-***', createdAt: 1, updatedAt: 8 };
const initialConfig = {
  revision: 'config-1', context: { maxTokens: 60000, truncateInject: true }, cache: { l1Threshold: 0.58, l2TtlMin: 30, l3Enabled: true },
  agent: { modelRouting: {}, reasoningBudget: 1000, reasoningTotalBudget: 4000, thinkInEnglish: true }, provider: {},
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

test('上下文滑杆提交一次设置并保持键盘可用', async ({ page }) => {
  const mutations = await setup(page);
  await openSettings(page, '上下文管理');
  const slider = page.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuenow', '0.58');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect.poll(() => mutations.filter((item) => item.path === '/api/config').length).toBe(1);
  await expect(slider).toHaveAttribute('aria-valuenow', '0.59');
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
    for (const name of ['模型与 Provider', '模型路由', '人设与提示词', '技能系统', '高级']) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await checkAccessibility(page);
    }
    await page.getByRole('button', { name: '关闭设置' }).click();
    for (const name of ['插件', '统计']) {
      if (width < 768) await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(name === '插件' ? '插件管理' : '缓存与成本');
      await checkAccessibility(page);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
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
