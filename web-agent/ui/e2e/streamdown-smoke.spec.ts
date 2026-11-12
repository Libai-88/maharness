import { expect, test } from '@playwright/test';

test('Markdown 代码块与表格由 Streamdown 渲染', async ({ page }) => {
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
  await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: [
      'event: start', 'data: {"traceId":"streamdown"}', '',
      'event: delta', `data: ${JSON.stringify({ text: '## 结果\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 完成 |\n\n```ts\nconst ready = true;\n```' })}`, '',
      'event: done', `data: ${JSON.stringify({ content: '## 结果\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 完成 |\n\n```ts\nconst ready = true;\n```', usage: { input: 1, output: 1 }, cost: 0 })}`, '',
      'event: end', 'data: {}', '',
    ].join('\n'),
  }));
  await page.goto('/');
  await page.getByPlaceholder('跟小鲸说点什么…（按 / 看命令）').fill('渲染测试');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '结果' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '完成' })).toBeVisible();
  await expect(page.getByText('const ready = true;')).toBeVisible();
});
