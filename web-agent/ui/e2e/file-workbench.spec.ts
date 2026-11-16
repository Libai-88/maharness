import { expect, test, type Page } from '@playwright/test';
import { installRunMocks, mockTaskEvents } from './run-fixture';
import type { Material } from '../src/material-api';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const version = 'a'.repeat(64);
const material: Material = { id: 'material-1', version, name: '课程资料.docx', path: 'imports/material-1/课程资料.docx', format: 'docx', size: 100, workspace: 'fixture', createdAt: 0 };
test('Real plugin startup exposes the shared document service and lightweight academic tools', async ({ request }) => {
  const capabilities = await request.get('/api/materials/capabilities'); expect(capabilities.ok()).toBe(true); expect((await capabilities.json()).document).toBe(true);
  const tools = await (await request.get('/api/tools')).json();
  for (const name of ['read_document', 'read_document_content', 'create_document', 'patch_document', 'search_papers', 'verify_reference']) expect(tools.some((tool: { name: string }) => tool.name === name)).toBe(true);
  const skills = await (await request.get('/api/skills')).json();
  for (const name of ['paper-reading', 'paper-comparison', 'paper-discovery', 'reference-checking']) expect(skills.installed.some((skill: { name: string }) => skill.name === name)).toBe(true);
});
async function setup(page: Page) {
  const fixture = await installRunMocks(page); fixture.materials.set(material.id, material);
  await page.route('**/api/sessions', route => route.fulfill({ json: [{ id: 'workbench', title: '办公学习', provider: 'e2e-provider', model: 'e2e-model', createdAt: 0, updatedAt: 0 }] }));
  await page.route('**/api/sessions/*/messages', route => route.fulfill({ json: [] }));
  await page.route('**/api/models', route => route.fulfill({ json: [{ id: 'e2e-provider@e2e-model', label: 'E2E', model: 'e2e-model', provider: 'e2e-provider' }] }));
  await page.route('**/api/providers', route => route.fulfill({ json: [{ id: 'e2e-provider', label: 'E2E', model: 'e2e-model', enabled: true, hasKey: true }] }));
  await page.route('**/api/materials/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: { document: true, search: true, ocr: { image: false, pdf: false, status: 'not_configured', config: {} } } });
    if (url.pathname.endsWith('/preview')) return route.fulfill({ json: { format: material.format, version, editable: true, warnings: ['内容预览，不代表原始分页或完整版式'], total: 1, blocks: [{ id: 'word/document.xml#0', type: 'paragraph', text: '第一篇研究的结果来自样本对比。', anchor: { version, blockId: 'word/document.xml#0' } }] } });
    if (url.pathname.endsWith('/content')) return route.fulfill({ body: Buffer.from('downloaded document'), contentType: 'application/octet-stream' });
    return route.fulfill({ json: material });
  });
  await mockTaskEvents(page, route => route.fulfill({ body: `event: done\ndata: ${JSON.stringify({ content: `[来源](#material=${material.id}&version=${version}&block=word/document.xml%230)`, usage: { input: 10, output: 2 }, cost: 0 })}\n\n` }));
  await page.goto('/'); await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  return fixture;
}
test('Office and learning examples populate an editable draft without starting a run', async ({ page }) => {
  const fixture = await setup(page); await page.getByRole('button', { name: '读懂并对比论文', exact: true }).click(); await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('读懂并对比论文'); expect(fixture.creates).toBe(0);
});
test('Upload, task references, source preview, download and page refresh work together', async ({ page }) => {
  const fixture = await setup(page); let body: Record<string, unknown> | undefined;
  await mockTaskEvents(page, route => { body = route.request().postDataJSON(); return route.fulfill({ body: `event: done\ndata: ${JSON.stringify({ content: `[来源](#material=${material.id}&version=${version}&block=word/document.xml%230)`, usage: { input: 1, output: 1 }, cost: 0 })}\n\n` }); });
  await page.getByLabel('上传任务文件').setInputFiles({ name: material.name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('button', { name: '移除附件 课程资料.docx' })).toBeVisible(); await page.getByRole('textbox', { name: '消息', exact: true }).fill('解释这份资料并标注来源'); await page.getByTestId('send-btn').click();
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('来源'); expect(body?.materials).toEqual([{ id: material.id, version }]);
  await page.getByRole('link', { name: '来源', exact: true }).click(); await expect(page.getByTestId('material-viewer')).toContainText('第一篇研究');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载文件', exact: true }).click(); expect((await download).suggestedFilename()).toBe(material.name);
  const folder = resolve('..', 'evals', 'reports', 'workbench'); mkdirSync(folder, { recursive: true }); await page.screenshot({ path: resolve(folder, 'document-preview.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await page.reload(); await expect(page.getByRole('button', { name: material.name, exact: true })).toBeVisible(); expect(fixture.creates).toBe(1);
});
test('Stale source content shows a version error without silently replacing it', async ({ page }) => {
  await setup(page); await page.route('**/api/materials/*/preview?*', route => route.fulfill({ status: 409, json: { error: '文件版本已变化，请重新选择文件' } }));
  await page.evaluate(({ id, version }) => { location.hash = `material=${id}&version=${version}&block=word/document.xml%230`; }, material); await expect(page.getByTestId('material-viewer')).toContainText('文件版本已变化');
});
test('Attachment limits fail before uploading and keep the task draft', async ({ page }) => {
  const fixture = await setup(page); await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留此要求'); await page.getByLabel('上传任务文件').setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `file${i}.md`, mimeType: 'text/markdown', buffer: Buffer.from('x') }))); await expect(page.getByText('单次任务最多附加 10 个文件')).toBeVisible(); await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留此要求'); expect(fixture.creates).toBe(0);
});
test('Workspace picker attaches a file without typing an absolute path', async ({ page }) => {
  await setup(page); await page.route('**/api/files/tree?*', route => route.fulfill({ json: { path: '.', entries: [{ name: material.name, type: 'file', size: 100 }] } })); await page.getByRole('button', { name: '选择工作区文件' }).click(); await page.getByRole('button', { name: `📄 ${material.name}` }).click(); await expect(page.getByRole('button', { name: '移除附件 课程资料.docx' })).toBeVisible();
});
test('Task artifacts open directly and can become the next task input', async ({ page }) => {
  await setup(page); await page.route('**/api/v2/runs/*/artifacts', route => route.fulfill({ json: [{ id: 'artifact-1', runId: 'fixture-1', callId: 'tool-1', kind: 'file', label: '结果.docx', ref: 'outputs/fixture-1/result.docx', createdAt: 0 }] }));
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('创建文档'); await page.getByTestId('send-btn').click(); await page.getByRole('button', { name: '预览 / 继续处理' }).click(); await expect(page.getByTestId('material-viewer')).toBeVisible(); await page.getByRole('button', { name: '用此文件提问 / 引用选中文字' }).click(); await expect(page.getByRole('button', { name: '移除附件 课程资料.docx' })).toBeVisible();
});
test('Mobile task input and content preview fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page); await page.getByLabel('上传任务文件').setInputFiles({ name: material.name, mimeType: 'application/octet-stream', buffer: Buffer.from('x') }); await page.getByRole('button', { name: material.name, exact: true }).click(); await expect(page.getByTestId('material-viewer')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('Empty OCR configuration is visible without promising recognition', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: /设置/ }).first().click(); await expect(page.getByText('图片 OCR：未配置')).toBeVisible(); await expect(page.getByText('扫描 PDF：未配置')).toBeVisible();
});
test('Bundled PDF viewer renders original pages and follows a page source', async ({ page }) => {
  await setup(page);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const value of ['First page', 'Second page']) { const stream = `BT /F1 18 Tf 20 350 Td (${value}) Tj ET`; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const source = { ...material, name: '原页.pdf', format: 'pdf' };
  await page.route('**/api/materials/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/content')) return route.fulfill({ body: Buffer.from(pdf), contentType: 'application/pdf' });
    if (path.endsWith('/preview')) return route.fulfill({ json: { format: 'pdf', version, warnings: [], editable: false, total: 1, blocks: [{ id: 'page:2', type: 'page', text: 'Second page', anchor: { version, blockId: 'page:2', page: 2 } }] } });
    return route.fulfill({ json: source });
  });
  await page.evaluate(({ id, version }) => { location.hash = `material=${id}&version=${version}&block=page%3A2&page=2`; }, source);
  await expect(page.getByLabel('PDF 原页预览')).toContainText('2 / 2');
  const canvas = page.getByLabel('PDF 第 2 页');
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBe(375);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => [...element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data].filter((value, index) => index % 4 !== 3 && value < 100).length)).toBeGreaterThan(100);
  await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(page.getByLabel('PDF 原页预览')).toContainText('1 / 2');
});

for (const scenario of [
  { name: 'PDF 表格提取结果', format: 'xlsx', text: 'Books · 200', rows: [['项目', '金额'], ['Books', '200']] },
  { name: '数据整理结果', format: 'csv', text: '费用合计 300', rows: [['类别', '合计'], ['费用', '300']] },
  { name: '演示文稿修改结果', format: 'pptx', text: '已阅读 3 篇论文', slide: 1 },
  { name: '论文对比笔记', format: 'md', text: '论文甲：观察研究，样本量 20；论文乙：随机试验，样本量 40。' },
  { name: '参考文献差异与导出', format: 'bib', text: '年份 different：提供 2025，注册题录 2024。仅核验题录。' },
  { name: '批量文件整理清单', format: 'md', text: '整理完成：a.txt、b.txt' },
]) test(`任务场景界面回放：${scenario.name}`, async ({ page }) => {
  await setup(page); const result = { ...material, name: `结果.${scenario.format}`, format: scenario.format };
  await page.route('**/api/v2/runs/*/artifacts', route => route.fulfill({ json: [{ id: 'scenario-result', runId: 'fixture-1', callId: 'scenario', kind: 'file', label: result.name, ref: `outputs/fixture-1/${result.name}`, createdAt: 0 }] }));
  await page.route('**/api/materials/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/preview')) return route.fulfill({ json: { format: result.format, version, warnings: ['内容预览'], total: 1, editable: false, blocks: [{ id: 'result:1', type: scenario.rows ? 'table' : 'paragraph', text: scenario.text, rows: scenario.rows, anchor: { version, blockId: 'result:1', slide: scenario.slide } }] } });
    if (path.endsWith('/content')) return route.fulfill({ body: Buffer.from(scenario.text), contentType: 'application/octet-stream' });
    return route.fulfill({ json: result });
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(scenario.name); await page.getByTestId('send-btn').click();
  await page.getByRole('button', { name: '预览 / 继续处理', exact: true }).click(); await expect(page.getByTestId('material-viewer')).toContainText(scenario.text);
  if (scenario.rows) await expect(page.getByTestId('material-viewer').getByRole('table')).toBeVisible();
  if (scenario.slide) await expect(page.getByTestId('material-viewer')).toContainText('幻灯片 1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载文件', exact: true }).click(); expect((await downloading).suggestedFilename()).toBe(result.name);
});

test('Draft cards collapse saved revisions, survive refresh and retain downloadable partial results', async ({ page }) => {
  const fixture = await setup(page);
  await mockTaskEvents(page, route => route.fulfill({ body: `event: error\ndata: ${JSON.stringify({ error: '模型请求超时', kind: 'max-turns' })}\n\n` }));
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('写一篇长笔记'); await page.getByTestId('send-btn').click();
  await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible();
  const runId = [...fixture.runs.keys()][0];
  const artifacts = [1, 2].map(n => ({ id: `draft-${n}`, runId, callId: `save-${n}`, kind: 'file', label: `笔记${n}.docx`, ref: `outputs/${runId}/笔记${n}.docx`, createdAt: n, metadata: { status: 'draft', format: 'docx', draftId: 'notes', draftVersion: String(n).repeat(64), count: n } }));
  await page.route('**/api/v2/runs/*/artifacts', route => route.fulfill({ json: artifacts }));
  await page.reload(); const card = page.getByTestId('run-file'); await expect(card).toHaveCount(1); await expect(card).toContainText('草稿'); await expect(card).toContainText('已保存 2 个内容块'); await expect(card).toContainText('笔记2.docx');
  const download = page.waitForEvent('download'); await card.getByRole('button', { name: '下载', exact: true }).click(); await download;
  await card.getByRole('button', { name: '预览 / 继续处理', exact: true }).click(); await expect(page.getByTestId('material-viewer')).toContainText('内容预览');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  artifacts.push({ ...artifacts[1], id: 'final', label: '最终笔记.docx', metadata: { ...artifacts[1].metadata, status: 'final' } });
  await page.reload(); await expect(page.getByTestId('run-file')).toHaveCount(2); await expect(page.getByTestId('run-file').filter({ hasText: '最终文件' })).toContainText('最终笔记.docx');
});
