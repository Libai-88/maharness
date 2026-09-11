// ui/e2e/bubble-menu.spec.ts —— 微信式气泡菜单 / 引用回复 / 表情面板 E2E 冒烟
// 触发路径覆盖三种确定性方式：真长按（mouse.down + 延时 + mouse.up）、右键、键盘（Shift+F10 / Enter）
// 数据自给自足：models/providers/chat 全部 route-mock——CI 空库（data/ 被忽略）与本地有历史两种状态行为一致
import { expect, test, type Page } from '@playwright/test';

const INPUT_PLACEHOLDER = '跟小马说点什么…（按 / 看命令）';

/** mock 流式接口：绕开真实 LLM（断言 UI 组合与渲染，不落库、不耗 token） */
function mockChatStream(page: Page) {
  return page.route('**/api/sessions/*/chat', async (route) => {
    const body = [
      'event: start',
      'data: {"traceId":"e2e-t"}',
      '',
      'event: delta',
      'data: {"text":"收到，这是一条 mock 回复。"}',
      '',
      'event: done',
      'data: {"content":"收到，这是一条 mock 回复。","usage":{"input":10,"output":5},"cost":0}',
      '',
      'event: end',
      'data: {}',
      '',
    ].join('\n');
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
}

/** 让 textarea 可用（hasModels）：mock 一个 provider + 一个 model */
async function mockModelApis(page: Page) {
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
}

/** 统一前置：mock 模型接口 + 首屏就绪 + 保证至少有一轮对话气泡（空库时自动种子一条 mock 对话） */
async function setup(page: Page) {
  await mockModelApis(page);
  await page.goto('/');
  await expect
    .poll(async () => {
      const bubbles = await page.getByTestId('msg-bubble-assistant').or(page.getByTestId('msg-bubble-user')).count();
      const hasHero = await page.locator('.brand-hero').count();
      return bubbles + hasHero;
    })
    .toBeGreaterThan(0);
  if ((await page.getByTestId('msg-bubble-assistant').count()) === 0) {
    await mockChatStream(page);
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('e2e 种子消息');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('收到，这是一条 mock 回复。');
  }
}

test.describe('气泡长按菜单（微信式）', () => {
  test('真长按 480ms 呼出菜单，点外部关闭', async ({ page }) => {
    await setup(page);
    const bubble = page.getByTestId('msg-bubble-assistant').last();
    const box = await bubble.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await page.locator('.wx-menu-overlay').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('bubble-menu')).toHaveCount(0);
  });

  test('右键呼出菜单（桌面等价手势）', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await expect(page.getByTestId('menu-quote')).toBeVisible();
  });

  test('键盘 Shift+F10 与 Enter 均可呼出', async ({ page }) => {
    await setup(page);
    const bubble = page.getByTestId('msg-bubble-assistant').last();
    await bubble.focus();
    await bubble.press('Shift+F10');
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await page.locator('.wx-menu-overlay').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('bubble-menu')).toHaveCount(0);
    await bubble.focus();
    await bubble.press('Enter');
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
  });

  test('菜单「引用」→ 引用条出现 → 取消消失', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await page.getByTestId('menu-quote').click();
    const bar = page.getByTestId('quote-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.qb-author')).toContainText('小马');
    await page.getByTestId('quote-cancel').click();
    await expect(bar).toHaveCount(0);
  });

  test('用户气泡菜单有「重新发送」与「删除」', async ({ page }) => {
    await setup(page);
    const userBubble = page.getByTestId('msg-bubble-user').last();
    if ((await userBubble.count()) === 0) test.skip(true, '当前会话无用户消息');
    await userBubble.click({ button: 'right' });
    await expect(page.getByTestId('menu-resend')).toBeVisible();
    await expect(page.getByTestId('menu-remove')).toBeVisible();
  });

  test('「删除」仅从当前视图移除该气泡', async ({ page }) => {
    await setup(page);
    const userBubble = page.getByTestId('msg-bubble-user').last();
    if ((await userBubble.count()) === 0) test.skip(true, '当前会话无用户消息');
    const before = await page.getByTestId('msg-bubble-user').count();
    await userBubble.click({ button: 'right' });
    await page.getByTestId('menu-remove').click();
    await expect(page.getByTestId('msg-bubble-user')).toHaveCount(before - 1);
  });
});

test.describe('引用回复上送（mock 流式）', () => {
  test('发送带引用的消息：气泡含引用块、引用条清理、mock 回复渲染', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await page.getByTestId('menu-quote').click();
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('引用测试正文');
    await page.keyboard.press('Enter');
    // 用户气泡 = 引用块 + 正文
    await expect(page.getByTestId('msg-bubble-user').last()).toContainText('【引用 小马】');
    await expect(page.getByTestId('msg-bubble-user').last()).toContainText('引用测试正文');
    // 引用条随发送清理；mock 回复到达
    await expect(page.getByTestId('quote-bar')).toHaveCount(0);
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('收到，这是一条 mock 回复。');
  });
});

test.describe('输入区活感', () => {
  test('空输入显示表情键 → 输入后切换为发送', async ({ page }) => {
    await setup(page);
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
    await expect(page.getByTestId('emoji-btn')).toBeVisible();
    await input.fill('你好');
    await expect(page.getByTestId('send-btn')).toBeVisible();
    await input.fill('');
    await expect(page.getByTestId('emoji-btn')).toBeVisible();
  });

  test('表情面板：打开、插入、再点收起（微信式连挑不关）', async ({ page }) => {
    await setup(page);
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
    await page.getByTestId('emoji-btn').click();
    const panel = page.getByTestId('emoji-panel');
    await expect(panel).toBeVisible();
    await panel.locator('button').first().click();
    await expect(input).not.toHaveValue('');
    // 选完不关：连着挑几个是常态，再点一次表情键才收起
    await expect(panel).toBeVisible();
    await panel.locator('button').nth(1).click();
    const two = await input.inputValue();
    expect(two.length).toBeGreaterThan(1);
    await page.getByTestId('emoji-btn').click();
    await expect(panel).toHaveCount(0);
  });
});
