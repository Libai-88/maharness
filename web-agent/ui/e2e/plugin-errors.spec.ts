import { expect, test, type Page } from '@playwright/test';

async function mockPluginShell(page: Page) {
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [{
    id: 'e2e-session', title: '插件错误测试', model: 'e2e-model', provider: 'e2e-provider',
    mode: 'normal', planPending: 0, archived: 0, pinned: 0, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/nav', (route) => route.fulfill({ json: { items: [] } }));
}

test('插件面板展示启动错误与修复建议', async ({ page }) => {
  await mockPluginShell(page);
  await page.route('**/api/plugins', (route) => route.fulfill({ json: [{
    id: 'broken-plugin',
    name: 'Broken Plugin',
    version: '0.1.0',
    state: 'error',
    caps: [],
    error: '缺少依赖插件：provider-demo',
    fixSuggestion: '请先安装并启用依赖插件「provider-demo」，然后重试。',
    essential: false,
    watched: true,
  }] }));
  await page.route('**/api/plugins/diagnostics', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/plugins/broken-plugin/config', (route) => route.fulfill({ json: { config: {}, schema: null } }));
  await page.route('**/api/plugins/broken-plugin/panel', (route) => route.fulfill({ status: 404, body: '' }));

  await page.goto('/');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.getByText('Broken Plugin')).toBeVisible();
  await page.getByText('Broken Plugin').click();
  const detail = page.locator('.manager-body');
  await expect(detail.getByText('错误：缺少依赖插件：provider-demo', { exact: false })).toBeVisible();
  await expect(detail.getByText('请先安装并启用依赖插件「provider-demo」，然后重试。', { exact: false })).toBeVisible();
});

test('插件失败后可通过重载恢复运行状态', async ({ page }) => {
  await mockPluginShell(page);
  let recovered = false;
  await page.route('**/api/plugins', (route) => route.fulfill({ json: [{
    id: 'recoverable-plugin',
    name: 'Recoverable Plugin',
    version: '0.1.0',
    state: recovered ? 'started' : 'error',
    caps: recovered ? ['tool'] : [],
    error: recovered ? undefined : '入口文件不存在',
    fixSuggestion: recovered ? undefined : '请检查 plugin.json 的 entry 字段。',
    essential: false,
    watched: true,
  }] }));
  await page.route('**/api/plugins/diagnostics', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/plugins/recoverable-plugin/config', (route) => route.fulfill({ json: { config: {}, schema: null } }));
  await page.route('**/api/plugins/recoverable-plugin/panel', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/plugins/recoverable-plugin/actions', async (route) => {
    recovered = true;
    await route.fulfill({ json: { ok: true, state: 'started' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByText('Recoverable Plugin').click();
  const detail = page.locator('.manager-body');
  await expect(detail.getByText('错误：入口文件不存在', { exact: false })).toBeVisible();
  await detail.getByRole('button', { name: '重载' }).click();
  await expect(page.getByText('运行中', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText('错误：入口文件不存在', { exact: false })).toHaveCount(0);
});
