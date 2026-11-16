import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const today = new Date().toISOString().slice(0, 10);
const state = {
  v: 1, tasks: [{ id: 'task-a', title: '整理界面', prio: 2, due: today, start: '', done: false, pid: 'proj-a', createdAt: 1, updatedAt: 1, doneAt: null, rolls: 0, repeat: '', pomo: 1, subs: [{ t: '核对列宽', d: false }], tags: ['设计'], link: '', note: '', status: 'doing', est: 2 }], notes: [{ id: 'note-a', text: '把复盘做成图', tags: ['方法'], createdAt: 1, updatedAt: 1, _s: true }], projects: [{ id: 'proj-a', name: '界面重构', stage: '收尾', next: '跑验收', blocker: '', status: 'active', updatedAt: 1 }], diary: { [today]: '交付工作台' }, diaryTs: { [today]: 1 }, tomb: {}, bin: [], meta: { sample: false, itemsAtExport: 0, lastExport: null, lastOpen: today, created: 1, pomoLog: { [today]: 1 } },
};

async function setup(page: Page, { theme = 'light', lang = 'zh', width = 1440 } = {}) {
  await page.setViewportSize({ width, height: 900 });
  let snapshot = { revision: 1, data: structuredClone(state) };
  await page.route('**/api/plugins/workbench/wb/data', route => {
    if (route.request().method() === 'PUT') {
      const incoming = route.request().postDataJSON();
      if (incoming.revision !== snapshot.revision) return route.fulfill({status:409,json:{error:'工作台已变化'}});
      snapshot = {revision:snapshot.revision+1,data:incoming.data};
    }
    return route.fulfill({json:snapshot});
  });
  await page.addInitScript(({theme}) => {
    localStorage.setItem('maharness-theme', theme);
    localStorage.setItem('maharness-brand', 'moss');
  }, {theme});
  await page.goto(lang === 'en' ? '/workbench.html?lang=en' : '/workbench.html');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await expect(page.getByTestId('workbench-view')).toBeVisible();
  await expect(page.getByRole('button',{name:'应用存储',exact:true})).toBeVisible();
  return () => snapshot.data;
}

async function checkAccessibility(page: Page) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string }[] }[] }> } }).axe.run();
    return result.violations.filter(item => item.impact === 'critical' || item.impact === 'serious').map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('工作台记录、搜索、撤销和导入导出可用', async ({ page }) => {
  const saved = await setup(page);
  await expect(page.getByText('示例数据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByTestId('workbench-task')).toContainText('整理界面');
  await page.getByLabel('快速添加任务').fill('验收工作台 明天 !1 #界面重构 ~2');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByTestId('workbench-task').first()).toContainText('验收工作台');
  await page.getByRole('combobox', { name: '排序' }).click();
  await page.getByRole('option', { name: '按优先级', exact: true }).click();
  await expect(page.getByTestId('workbench-task').first()).toContainText('P1');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('workbench-task')).not.toContainText('验收工作台');
  await page.getByRole('button', { name: '复盘', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('界面重构');
  await page.getByRole('button', { name: '复制报告' }).click();
  await expect(page.locator('[data-sonner-toast]')).toContainText('报告已复制');
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  await expect(page.getByTestId('workbench-view')).toContainText('数据保存于应用存储');
  await page.getByRole('button', { name: '导出 JSON' }).click();
  await expect.poll(() => saved().meta.lastExport).toBeTruthy();
  await checkAccessibility(page);
});

test('全局搜索、快捷键、双语和响应式布局可用', async ({ page }, testInfo) => {
  await setup(page, { lang: 'en' });
  await expect(page.getByTestId('workbench-view').getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search tasks, projects or notes…').fill('整理');
  await page.getByRole('option', { name: /整理界面/ }).click();
  await expect(page.getByRole('combobox', { name: 'Project' })).toContainText('界面重构');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Alt+3');
  await expect(page.getByTestId('workbench-view').getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByLabel('Title')).toBeVisible();
  await page.keyboard.press('Escape');
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath('english.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeVisible();
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath('mobile.png') });
});

test('浏览器历史数据经确认导入应用存储，原备份保留', async ({ page }) => {
  const saved = await setup(page);
  const incoming = {...structuredClone(state),tasks:[{...state.tasks[0],id:'legacy-extra',title:'浏览器历史事项'}]};
  await page.evaluate(data=>localStorage.setItem('pd_workbench_v1',JSON.stringify(data)),incoming);
  await page.getByRole('button',{name:'数据与备份',exact:true}).click();
  await page.getByRole('button',{name:'导入浏览器历史',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toContainText('1 个事项');
  expect(saved().tasks.some(task=>task.id==='legacy-extra')).toBe(false);
  await page.getByRole('button',{name:'确认',exact:true}).click();
  await expect.poll(()=>saved().tasks.some(task=>task.id==='legacy-extra')).toBeTruthy();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('pd_workbench_v1')!).tasks[0].title)).toBe('浏览器历史事项');
  await checkAccessibility(page);
});

for (const theme of ['light', 'dark']) {
  test(`${theme} 工作台布局与可访问性`, async ({ page }, testInfo) => {
    await setup(page, { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('workbench-task')).toContainText('整理界面');
    await checkAccessibility(page);
    await page.screenshot({ path: testInfo.outputPath(`${theme}.png`) });
  });
}
