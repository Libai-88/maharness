import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { TodoCard } from '../src/types';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function setup(page: Page, theme = 'light') {
  let cards: TodoCard[] = [
    { id: 'task-1', title: '检查消息布局', desc: '保留中文与工具输出', status: 'todo', priority: 'high', source: 'human', order: 0, createdAt: 1, updatedAt: 1 },
    { id: 'task-2', title: '构建前端', status: 'doing', priority: 'medium', source: 'agent', order: 1, createdAt: 1, updatedAt: 1 },
  ];
  const mutations: { method: string; body: Record<string, unknown> }[] = [];
  await page.addInitScript((value) => { localStorage.setItem('maharness-theme', value); localStorage.setItem('maharness-brand', 'moss'); }, theme);
  await page.route('**/api/plugins/todo/board/cards**', async (route) => {
    const request = route.request();
    const method = request.method();
    const body = method === 'GET' ? {} : request.postDataJSON() ?? {};
    const id = new URL(request.url()).pathname.split('/').pop();
    if (method !== 'GET') mutations.push({ method, body });
    if (method === 'POST') cards = [...cards, { ...cards[0], ...body, id: 'task-new', source: 'human', status: 'todo' }];
    if (method === 'PATCH') cards = cards.map((card) => card.id === id ? { ...card, ...body } : card);
    if (method === 'DELETE') cards = cards.filter((card) => card.id !== id);
    return route.fulfill({ json: method === 'GET' ? { cards } : { ok: true } });
  });
  await page.goto('/api/plugins/todo/board/page');
  await expect(page).toHaveURL(/\/todo\.html$/);
  await expect(page.getByRole('heading', { name: '待办看板' })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查消息布局', exact: true })).toBeVisible();
  return mutations;
}

async function checkAccessibility(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string }[] }[] }> } }).axe.run();
    return result.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious').map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('看板新建、搜索、编辑、清空描述与删除保持 API 契约', async ({ page }) => {
  const mutations = await setup(page);
  await page.getByLabel('新任务标题').fill('新增任务');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('button', { name: '新增任务', exact: true })).toBeVisible();
  await page.getByLabel('搜索任务').fill('消息');
  await expect(page.getByRole('button', { name: '构建前端', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查消息布局', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('检查新布局');
  await page.getByLabel('描述', { exact: true }).clear();
  await page.getByRole('combobox', { name: '编辑任务状态' }).click();
  await page.getByRole('option', { name: '完成', exact: true }).click();
  await checkAccessibility(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(mutations.find((item) => item.method === 'PATCH')?.body).toEqual({ title: '检查新布局', desc: '', status: 'done', priority: 'high' });
  await page.getByLabel('搜索任务').clear();
  await expect(page.locator('[data-status="done"]')).toContainText('检查新布局');
  await page.getByRole('button', { name: '删除任务 检查新布局', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查新布局', exact: true })).toHaveCount(0);
});

test('看板拖动卡片与键盘状态选择均可移动任务', async ({ page }) => {
  const mutations = await setup(page);
  const handle = await page.getByRole('button', { name: '拖动任务 检查消息布局', exact: true }).boundingBox();
  const target = await page.locator('[data-status="blocked"]').boundingBox();
  if (!handle || !target) throw new Error('拖拽区域不可见');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => mutations.some((item) => item.body.status === 'blocked')).toBe(true);
  await expect(page.locator('[data-status="blocked"]')).toContainText('检查消息布局');
  await page.getByRole('combobox', { name: '检查消息布局 状态', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: '完成', exact: true }).click();
  await expect(page.locator('[data-status="done"]')).toContainText('检查消息布局');
});

test('看板筛选来源与状态，Sheet 可使用 Escape 退出', async ({ page }) => {
  await setup(page);
  await page.getByRole('combobox', { name: '筛选任务来源' }).click();
  await page.getByRole('option', { name: '模型', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查消息布局', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '构建前端', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('combobox', { name: '筛选任务状态' }).click();
  await page.getByRole('option', { name: '进行中', exact: true }).click();
  await expect(page.locator('section[data-status]')).toHaveCount(1);
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px 看板布局与可访问性`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await checkAccessibility(page);
      await page.screenshot({ path: testInfo.outputPath('board.png') });
    });
  }
}
