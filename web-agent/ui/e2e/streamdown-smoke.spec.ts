import { installRunMocks, mockTaskEvents } from './run-fixture';
import { expect, test } from '@playwright/test';

const INPUT_PLACEHOLDER = '跟 maharness 说点什么…（按 / 看命令）';

const MARKDOWN = ['## 结果', '', '| 项 | 值 |', '| --- | --- |', '| 状态 | 完成 |', '', '```ts', 'const ready = true;', '```'].join('\n');

test('Markdown 代码块与表格由 Streamdown 渲染', async ({ page }) => {
  await installRunMocks(page);
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: [
        {
          id: 'e2e-provider',
          label: 'E2E Provider',
          baseUrl: 'http://e2e.local',
          model: 'e2e-model',
          enabled: true,
          apiKeyMasked: 'sk-***',
          hasKey: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({
      json: [
        {
          id: 'e2e-provider@e2e-model',
          provider: 'e2e-provider',
          label: 'E2E Model',
          model: 'e2e-model',
        },
      ],
    }),
  );
  await mockTaskEvents(page, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'event: start',
        'data: {"traceId":"streamdown"}',
        '',
        'event: delta',
        `data: ${JSON.stringify({ text: MARKDOWN })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ content: MARKDOWN, usage: { input: 1, output: 1 }, cost: 0 })}`,
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n'),
    }),
  );

  await page.goto('/');
  await expect(page.getByTestId('chat-welcome').or(page.getByTestId('msg-bubble-assistant'))).toBeVisible();
  await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('渲染测试');
  // The composer only enables after providers/models resolve; pressing Enter on a
  // disabled composer silently drops the message and the stream never starts.
  await expect(page.getByTestId('send-btn')).toBeEnabled();
  await page.keyboard.press('Enter');

  const bubble = page.getByTestId('msg-bubble-assistant').last();
  await expect(bubble).toBeVisible();
  await expect(bubble.getByRole('heading', { name: '结果' })).toBeVisible();
  await expect(bubble.getByRole('cell', { name: '完成' })).toBeVisible();
  await expect(bubble.getByText('const ready = true;')).toBeVisible();
});
