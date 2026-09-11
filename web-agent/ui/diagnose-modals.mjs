// ui/diagnose-modals.mjs —— 定向复验两个「曾被 filter 劫持包含块」的浮层：文件全屏查看器 / 待办详情遮罩
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

const g = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return { rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, position: cs.position, z: cs.zIndex, centerOwned: !!h && (e === h || e.contains(h)) };
}, sel);

// A. 文件页：打开任意文件 → 全屏查看器
await page.locator('.sidebar button', { hasText: '文件' }).first().click();
await page.waitForTimeout(1600);
const fileNode = page.locator('.file-tree-pane .ft-item, .file-tree-pane [class*=file]').first();
if (await fileNode.count()) { await fileNode.click({ timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(1500); }
const fsBtn = page.locator('button[title="全屏"]');
if (await fsBtn.count()) {
  await fsBtn.first().click({ timeout: 3000 }).catch((e) => console.log('全屏按钮点击失败', String(e).slice(0, 160)));
  await page.waitForTimeout(800);
}
console.log('file-viewer.fullscreen =', JSON.stringify(await g('.file-viewer.fullscreen')), '| viewport=1440x900');
console.log('  其关闭/全屏按钮可点 =', await page.locator('button[title="全屏"], button[title="退出全屏"]').first().click({ timeout: 2000 }).then(() => true).catch(() => false));
await page.waitForTimeout(500);

// B. 插件页 → todo 看板 → 卡片详情遮罩
await page.locator('.sidebar button', { hasText: '插件' }).first().click();
await page.waitForTimeout(1600);
const cards = await page.locator('.plugin-card').count();
let opened = false;
for (let i = 0; i < cards && !opened; i++) {
  const t = (await page.locator('.plugin-card').nth(i).innerText()).replace(/\s+/g, ' ');
  if (/todo|待办/i.test(t)) { await page.locator('.plugin-card').nth(i).click({ timeout: 3000 }).catch(() => undefined); opened = true; }
}
await page.waitForTimeout(1800);
const tb = page.locator('.tb-card').first();
if (await tb.count()) { await tb.click({ timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(900); }
console.log('todo 详情遮罩 .tb-detail-overlay =', JSON.stringify(await g('.tb-detail-overlay')));
console.log('  详情面板 .tb-detail =', JSON.stringify(await g('.tb-detail')));
const inputs = await page.evaluate(() => [...document.querySelectorAll('.tb-detail input, .tb-detail textarea, .tb-detail button')].map((e) => { const r = e.getBoundingClientRect(); const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return { t: (e.value || e.textContent || e.placeholder || '').trim().slice(0, 10), ok: !!h && (e === h || e.contains(h)) }; }));
console.log('  详情内控件可命中 =', JSON.stringify(inputs));
console.log('errs =', JSON.stringify(errs));
await browser.close();
