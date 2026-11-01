// ui/e2e/plugin-trust.spec.ts —— 插件信任等级明示（SEC-05）：
// 三种渲染形态的隔离语义在插件页头可见，iframe 容器带 sandbox 属性。
import { expect, test, type Page } from '@playwright/test';

const NAV_ITEM = {
  key: 'plugin:demo-board',
  pluginId: 'demo-board',
  pluginName: 'Demo Board',
  label: '看板',
  icon: null,
  order: 1,
  mode: 'iframe',
  url: 'http://127.0.0.1:1/plugin-demo/index.html',
  moduleUrl: null,
  statusUrl: null,
  statusIntervalMs: 0,
};

async function mockShell(page: Page) {
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [{
    id: 'e2e-session', title: '信任等级测试', model: 'e2e-model', provider: 'e2e-provider',
    mode: 'normal', planPending: 0, archived: 0, pinned: 0, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/nav', (route) => route.fulfill({ json: { items: [NAV_ITEM] } }));
}

test('iframe 插件页头明示沙箱信任等级，iframe 带 sandbox 属性', async ({ page }) => {
  await mockShell(page);
  await page.goto('/');
  await page.getByRole('button', { name: '看板' }).click();
  const trust = page.locator('.plugin-tab-trust');
  await expect(trust).toContainText('iframe 沙箱');
  await expect(trust).toHaveAttribute('data-trust', 'iframe');
  await expect(trust).toHaveAttribute('title', /sandbox/);
  const iframe = page.locator('iframe.plugin-tab-iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads');
  // 沙箱属性不含 allow-top-navigation / allow-popups-to-escape-sandbox：
  // 插件页面无法接管宿主导航或脱离沙箱弹窗
  const sandbox = await iframe.getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-top-navigation');
});

test('panel 插件页头明示净化片段信任等级', async ({ page }) => {
  await mockShell(page);
  await page.route('**/api/nav', (route) => route.fulfill({
    json: { items: [{ ...NAV_ITEM, key: 'plugin:demo-panel', pluginId: 'demo-panel', pluginName: 'Demo Panel', label: '面板', mode: 'panel', url: '/api/plugins/demo-panel/panel' }] },
  }));
  await page.route('**/api/plugins/demo-panel/panel', (route) => route.fulfill({
    json: { title: '演示面板', html: '<p>面板内容</p>' },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '面板', exact: true }).click();
  const trust = page.locator('.plugin-tab-trust');
  await expect(trust).toContainText('净化片段');
  await expect(trust).toHaveAttribute('data-trust', 'panel');
  await expect(page.locator('.plugin-panel-body')).toContainText('面板内容');
});
