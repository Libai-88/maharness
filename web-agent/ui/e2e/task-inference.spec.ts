import { expect, test } from '@playwright/test';

const INPUT_PLACEHOLDER = '跟小马说点什么…（按 / 看命令）';

test('开放式目标先确认验收条件，再消费原目标执行', async ({ page }) => {
  const session = {
    id: 'e2e-goal-session',
    title: '目标任务',
    mode: 'goal',
    model: 'e2e-model',
    provider: 'e2e-provider',
    updatedAt: 0,
    createdAt: 0,
  };
  let chatCalls = 0;
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
  await page.route('**/api/sessions/e2e-goal-session/chat', async (route) => {
    requestBodies.push(String(route.request().postData() ?? ''));
    chatCalls += 1;
    const body = chatCalls === 1
      ? [
        'event: start',
        'data: {"traceId":"e2e-inference"}',
        '',
        'event: task_inference',
        'data: {"objective":"请整理项目报告","inference":{"confidence":0.45,"basis":"inferred","needsConfirmation":true,"rationale":"识别到行动意图，但未识别到可验证的完成标准"}}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n')
      : [
        'event: start',
        'data: {"traceId":"e2e-confirmed"}',
        '',
        'event: delta',
        'data: {"text":"报告已完成"}',
        '',
        'event: task_verified',
        'data: {"objective":"请整理项目报告","checks":[{"ok":true,"reason":"文件存在：reports/final.md"}],"evidence":[{"source":"filesystem","detail":"文件存在：reports/final.md","traceStepId":"verify-step"}]}',
        '',
        'event: done',
        'data: {"content":"报告已完成","usage":{"input":10,"output":5},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });

  await page.goto('/');
  const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
  await expect(input).toBeVisible();
  await input.fill('请整理项目报告');
  await input.press('Enter');

  const card = page.getByTestId('task-confirm-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('请整理项目报告');
  await expect(card).toContainText('未识别到可验证的完成标准');
  await expect(page.getByTestId('msg-bubble-assistant')).toHaveCount(0);

  await card.locator('textarea').fill('生成 reports/final.md，并确保文件存在');
  await page.getByTestId('task-confirm-submit').click();

  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('报告已完成');
  await expect(page.getByText('验收通过')).toBeVisible();
  expect(chatCalls).toBe(2);
  expect(requestBodies[0]).toContain('请整理项目报告');
  expect(requestBodies[1]).toContain('验收条件');
  expect(requestBodies[1]).toContain('reports/final.md');
});
