import { expect, test } from '@playwright/test';
import { chatPlaceholder, frames, installRunMocks, mockTaskEvents, sendTask, setupTaskPage } from './run-fixture';

const placeholder = chatPlaceholder;
test('首个会话创建完成前保留输入，完成后只发送一次', async ({ page }) => {
  const fixture = await installRunMocks(page);
  let releaseSession!: () => void;
  const sessionReady = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    await sessionReady;
    return route.fulfill({ json: { id: 'first-session', title: '新会话', model: 'e2e-model', createdAt: 0, updatedAt: 0 } });
  });
  await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: [{ id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model' }] }),
  );
  await page.route('**/api/providers', (route) =>
    route.fulfill({ json: [{ id: 'e2e-provider', label: 'E2E Provider', model: 'e2e-model', enabled: true, hasKey: true }] }),
  );
  await mockTaskEvents(page, (route) => route.fulfill({ body: done('收到首次请求。') }));
  await page.goto('/');
  const input = page.getByPlaceholder(placeholder);
  await input.fill('保留首次输入');
  await expect(page.getByTestId('send-btn')).toBeDisabled();
  await input.press('Enter');
  await expect(input).toHaveValue('保留首次输入');
  expect(fixture.creates).toBe(0);
  releaseSession();
  await expect(page.getByTestId('send-btn')).toBeEnabled();
  await input.press('Enter');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('收到首次请求。');
  expect(fixture.creates).toBe(1);
});

const done = (content: string) =>
  frames([
    ['start', { traceId: 'task-trace' }],
    ['delta', { text: content }],
    ['done', { content, usage: { input: 10, output: 5 }, cost: 0 }],
  ]);

test('短问答由持久任务事件完成，回答结束与验收独立显示', async ({ page }) => {
  const fixture = await setupTaskPage(page);
  await mockTaskEvents(page, (route) => route.fulfill({ body: done('短问答完成。') }));
  await sendTask(page, '介绍项目');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('短问答完成。');
  await expect(page.getByTestId('run-controls')).toContainText('执行完成');
  await expect(page.getByTestId('run-controls')).toContainText('尚未验证');
  await expect(page.locator('.stream-cursor')).toHaveCount(0);
  expect(fixture.creates).toBe(1);
});

test('历史断点经用户核对后以新任务续接，不重放旧工具', async ({ page }) => {
  const fixture = await setupTaskPage(page);
  await page.route('**/api/sessions/task-session/checkpoint', (route) =>
    route.fulfill({
      json: { exists: true, legacy: true, turn: 3, objective: '核对报告', history: [{ role: 'tool', content: '旧写入已发生' }] },
    }),
  );
  await page.reload();
  await mockTaskEvents(page, (route) => route.fulfill({ body: done('新任务完成。') }));
  await page.getByRole('button', { name: '查看历史断点' }).click();
  await expect(page.getByRole('button', { name: '作为新任务继续' })).toBeDisabled();
  await page.getByLabel('续接目标').fill('核对已有报告后继续');
  await page.getByRole('checkbox', { name: '我已核对先前操作及其实际结果' }).click();
  await page.getByRole('button', { name: '作为新任务继续' }).click();
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('新任务完成。');
  expect(fixture.creates).toBe(1);
});

test('文件任务的工具观察和最终答案可见', async ({ page }) => {
  await setupTaskPage(page);
  await mockTaskEvents(page, (route) =>
    route.fulfill({
      body: frames([
        ['start', { traceId: 'file-trace' }],
        ['tool_start', { id: 'read', name: 'read_file', args: { path: 'notes.md' } }],
        ['tool_result', { id: 'read', name: 'read_file', summary: '读取 notes.md', ok: true }],
        ['done', { content: '文件读取完成。', usage: { input: 20, output: 5 }, cost: 0 }],
      ]),
    }),
  );
  await sendTask(page, '读取 notes.md');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('文件读取完成。');
  await expect(page.getByTestId('tool-step').first()).toBeVisible();
});

test('补充要求不会创建第二任务，取消后进入终态', async ({ page }) => {
  const fixture = await setupTaskPage(page);
  await mockTaskEvents(page, (route) =>
    route.fulfill({
      body: frames([
        ['start', { traceId: 'active' }],
        ['delta', { text: '持续执行中' }],
      ]),
    }),
  );
  await sendTask(page, '执行长任务');
  await expect(page.getByTestId('run-controls')).toContainText('执行中');
  await page.getByRole('button', { name: '补充或新建任务', exact: true }).click();
  await page.getByLabel('当前任务要求').fill('同时检查类型');
  const supplement = page.waitForRequest((request) => request.url().endsWith('/messages') && request.method() === 'POST');
  await page.getByRole('button', { name: '补充当前任务', exact: true }).click();
  expect((await supplement).postDataJSON()).toEqual({ message: '同时检查类型' });
  expect(fixture.creates).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('run-controls')).toContainText('已取消');
  await expect(page.locator('.stream-cursor')).toHaveCount(0);
});

test('中断任务只在用户操作后恢复，并从新事件游标继续', async ({ page }) => {
  const fixture = await setupTaskPage(page);
  await mockTaskEvents(page, (route) =>
    route.fulfill({
      body: frames([
        ['start', { traceId: 'interrupted' }],
        ['error', { error: '执行轮数到达边界', kind: 'max-turns' }],
      ]),
    }),
  );
  await sendTask(page, '处理长任务');
  await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible();
  const request = page.waitForRequest((request) => request.url().endsWith('/resume'));
  await page.getByRole('button', { name: '继续任务', exact: true }).click();
  await request;
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('恢复后的答复。');
  expect(fixture.creates).toBe(1);
});

test('事件连接失败重试使用已有任务；重载也不会再次创建执行', async ({ page }) => {
  const fixture = await setupTaskPage(page);
  await mockTaskEvents(page, (route) =>
    route.fulfill({
      body: frames([
        ['start', { traceId: 'reconnect' }],
        ['delta', { text: '持续执行中' }],
      ]),
    }),
  );
  let disconnected = false;
  await page.route('**/api/v2/runs/*/events', (route) => {
    if (!disconnected) {
      disconnected = true;
      return route.abort('connectionreset');
    }
    return route.fallback();
  });
  await sendTask(page, '执行并保持连接');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('持续执行中');
  expect(fixture.creates).toBe(1);
  await page.reload();
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('持续执行中');
  expect(fixture.creates).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('run-controls')).toContainText('已取消');
});
