import { installRunMocks, mockTaskEvents } from './run-fixture';
import { expect, test } from '@playwright/test';

const INPUT_PLACEHOLDER = '跟 maharness 说点什么…（按 / 看命令）';

test('开放式目标直接执行，不强制推断验收或额外确认', async ({ page }) => {
  const session = {
    id: 'e2e-goal-session',
    title: '目标任务',
    mode: 'goal',
    model: 'e2e-model',
    provider: 'e2e-provider',
    updatedAt: 0,
    createdAt: 0,
  };
  const fixture = await installRunMocks(page);
  const requestBodies: string[] = [];

  await page.route('**/api/sessions', (route) => route.fulfill({ json: [session] }));
  await page.route('**/api/sessions/e2e-goal-session/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/e2e-goal-session/checkpoint', (route) => route.fulfill({ json: { exists: false } }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{ id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model' }] }));
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/nav', (route) => route.fulfill({ json: { items: [] } }));
  await mockTaskEvents(page, async route => {
    requestBodies.push(String(route.request().postData() ?? ''));
    await route.fulfill({ body: [
      'event: start', 'data: {"traceId":"goal-native"}', '',
      'event: done', 'data: {"content":"报告已完成","usage":{"input":10,"output":5},"cost":0}', '', '',
    ].join('\n') });
  });
  await page.goto('/');
  const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
  await expect(input).toBeEnabled();
  await input.fill('请整理项目报告'); await input.press('Enter');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('报告已完成');
  await expect(page.getByTestId('task-confirm-card')).toHaveCount(0);
  await expect(page.getByTestId('run-controls')).toContainText('尚未验证');
  expect(fixture.creates).toBe(1);
  expect(JSON.parse(requestBodies[0])).not.toHaveProperty('acceptance');
});
