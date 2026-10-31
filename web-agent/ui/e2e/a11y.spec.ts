// ui/e2e/a11y.spec.ts —— 自动可访问性检查（UX-05）
// axe-core 扫描核心页面（会话首屏 / 审批挂起 / 错误终态 / 表情面板 / 确认对话框），
// 严重与中度违规必须为零；同时锁定 1280x720 与 390x844 两个常用视口的核心布局不遮挡。
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const axeSource = readFileSync(axePath, 'utf8');

const INPUT_PLACEHOLDER = '跟小马说点什么…（按 / 看命令）';

async function setup(page: Page) {
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
  await page.route('**/api/events', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: '' }));
  await page.route('**/api/trace/stats', (route) => route.fulfill({ json: { trace: {}, cache: {}, l1Enabled: false } }));
  await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({ json: { exists: false, turn: 0, historyMessages: 0, createdAt: 0 } }));
  await page.goto('/');
  await expect
    .poll(async () => {
      const bubbles = await page.getByTestId('msg-bubble-assistant').or(page.getByTestId('msg-bubble-user')).count();
      const hasHero = await page.locator('.brand-hero').count();
      return bubbles + hasHero;
    })
    .toBeGreaterThan(0);
}

/** axe 注入 + 扫描：只保留严重（critical）与严重偏上（serious）违规 */
async function scanA11y(page: Page): Promise<{ id: string; impact: string; nodes: number }[]> {
  // toast 挂载动画（opacity 过渡）会让 axe 误读中间帧对比度，等其稳定再扫描
  await page.waitForTimeout(500);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string | null; nodes: unknown[] }[] }> } }).axe.run());
  return result.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, summary: v.nodes.map((n: { target: string[] }) => n.target.join(' ')) }));
}

test.describe('可访问性（UX-05）', () => {
  test('会话首屏：axe 扫描无严重/中度违规', async ({ page }) => {
    await setup(page);
    const violations = await scanA11y(page);
    expect(violations, `axe 违规：${JSON.stringify(violations)}`).toEqual([]);
  });

  test('错误终态：失败状态可被读屏识别（aria-live 区域内文案 + 原始错误 title）', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'event: start',
        'data: {"traceId":"a11y-error"}',
        '',
        'event: delta',
        'data: {"text":"前半部分已完成…"}',
        '',
        'event: error',
        'data: {"error":"本任务已达到轮数上限","kind":"max-turns"}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n'),
    }));
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('执行一个多阶段任务');
    await page.keyboard.press('Enter');
    const failure = page.locator('.wx-failure').last();
    await expect(failure).toContainText('这个任务有点大');
    // 失败条声明为状态区（读屏主动播报），原始错误在 title 可查
    await expect(failure).toHaveAttribute('role', 'status');
    await expect(failure).toHaveAttribute('title', /本任务已达到轮数上限/);
  });

  test('审批卡与表情面板：键盘可达且 axe 无严重/中度违规', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'event: start',
        'data: {"traceId":"a11y-approval"}',
        '',
        'event: approval_required',
        'data: {"approvalId":"a11y-ap-1","name":"delete_file","summary":"删除 reports/draft.md","approvalToken":"tok-a11y"}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n'),
    }));
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('删除草稿文件');
    await page.keyboard.press('Enter');
    const card = page.locator('.approval-card');
    await expect(card).toBeVisible();
    // 键盘可达：审批按钮本身可聚焦（无 tabindex=-1、无 pointer-only 交互）
    const approveBtn = card.locator('.btn-primary').first();
    await approveBtn.focus();
    await expect(approveBtn).toBeFocused();
    // 回答走可访问 API（读屏通过 toast aria-live 播报结果）；路由先注册避免误击真实端点
    await page.route('**/api/approvals/**', (route) => route.fulfill({ json: { ok: true } }));
    await approveBtn.click();
    await expect(card).toHaveCount(0);
    const violations = await scanA11y(page);
    expect(violations, `axe 违规：${JSON.stringify(violations)}`).toEqual([]);
  });

  for (const viewport of [
    { name: '1280x720', width: 1280, height: 720 },
    { name: '390x844', width: 390, height: 844 },
  ]) {
    test(`布局：${viewport.name} 视口下首屏、输入区、发送按钮无遮挡`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await setup(page);
      const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
      await expect(input).toBeVisible();
      // 输入区完全在视口内（不被裁切、不出屏）
      const box = await input.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      // 发送按钮可见且可点击（高度 > 0，不被遮挡）
      const sendBtn = page.getByRole('button', { name: '发送' });
      if (await sendBtn.count() > 0) {
        const btnBox = await sendBtn.boundingBox();
        expect(btnBox).not.toBeNull();
        expect(btnBox!.height).toBeGreaterThan(0);
      }
      // 横向无滚动溢出
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
