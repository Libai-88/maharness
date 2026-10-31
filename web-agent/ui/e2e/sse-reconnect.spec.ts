import { expect, test, type Page } from '@playwright/test';

async function mockShell(page: Page) {
  const session = { id: 'sse-reconnect', title: 'SSE reconnect', model: 'e2e-model', provider: 'e2e-provider', mode: 'chat', planPending: 0, archived: 0, pinned: 0, createdAt: 1, updatedAt: 1 };
  await page.route('**/api/sessions', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [session] : session }));
  await page.route('**/api/sessions/sse-reconnect/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/sse-reconnect/checkpoint', (route) => route.fulfill({ json: { exists: false } }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{ id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model' }] }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{ id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model', enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0 }] }));
  await page.route('**/api/nav', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/plugins', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/plugins/diagnostics', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/plugins/goal-plan/plan?**', (route) => route.fulfill({ json: { plan: null } }));
}

// e2e 共用同一个临时数据目录，审计表跨运行累积。只统计 sinceTs 之后的事件，
// 避免历史事件挤占 limit=500 窗口导致本次运行的事件查不到。
async function lifecycleCounts(page: Page, sinceTs?: number): Promise<{ connected: number; disconnected: number }> {
  const response = await page.request.get('/api/security/audit?limit=500');
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { events?: { occurredAt?: number; object?: string; outcome?: string }[] };
  const events = (body.events ?? [])
    .filter((event) => event.object === '/api/events' && (!sinceTs || (event.occurredAt ?? 0) >= sinceTs));
  return {
    connected: events.filter((event) => event.outcome === 'connected').length,
    disconnected: events.filter((event) => event.outcome === 'disconnected').length,
  };
}

test('浏览器恢复联网后自动重建 SSE，服务端连接槽不泄漏', async ({ page, context }) => {
  test.setTimeout(45_000);
  await mockShell(page);
  const t0 = Date.now();
  await page.goto('/');
  await expect.poll(async () => (await lifecycleCounts(page, t0)).connected).toBeGreaterThan(0);
  const connected = await lifecycleCounts(page, t0);

  await context.setOffline(true);
  await expect.poll(async () => (await lifecycleCounts(page, t0)).disconnected).toBeGreaterThan(connected.disconnected);
  await context.setOffline(false);
  await expect.poll(async () => page.evaluate(() => navigator.onLine)).toBeTruthy();
  // Chromium's context network emulation does not consistently dispatch the
  // native `online` event, so deliver the browser lifecycle signal explicitly
  // after restoring transport. The production code still uses the real event.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await lifecycleCounts(page, t0)).connected).toBeGreaterThan(connected.connected);

  await page.close();
  await expect.poll(async () => {
    const closed = await lifecycleCounts(page, t0);
    return closed.connected - closed.disconnected;
  }).toBe(0);
});
