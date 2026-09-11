// ui/diagnose-fix-hypothesis.mjs —— 反证实验：在浏览器里临时关掉两个可疑属性，看遮挡/点击失效是否消失
// 用法：node diagnose-fix-hypothesis.mjs [baseUrl]
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

async function hitCheck(page, label) {
  const r = await page.evaluate(() => {
    const pop = document.querySelector('.topbar .menu .menu-pop');
    if (!pop) return { noPopup: true };
    const items = [...pop.querySelectorAll('.menu-item')];
    return items.map((it) => {
      const b = it.getBoundingClientRect();
      const h = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      return { text: it.textContent.trim().slice(0, 10), ok: !!h && (it === h || it.contains(h)) };
    });
  });
  const popupRect = await page.evaluate(() => { const p = document.querySelector('.topbar .menu .menu-pop'); if (!p) return null; const r = p.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
  // Playwright 真点击能否命中
  let clickResult = 'skipped';
  const item = page.locator('.topbar .menu .menu-pop .menu-item').nth(1);
  if (await item.count()) {
    clickResult = await item.click({ timeout: 2500 }).then(() => 'OK').catch((e) => 'FAIL: ' + String(e).split('\n')[0]);
  }
  return { label, popupRect, items: r, playwrightClick: clickResult };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const openModeMenu = async () => {
  await page.locator('.topbar .menu').first().locator('button').first().click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(450);
};
const closeAll = async () => { await page.keyboard.press('Escape'); await page.mouse.click(700, 850); await page.waitForTimeout(300); };

// 基线（现状）
await openModeMenu();
results.push(await hitCheck(page, '基线：现状（涂鸦 filter 全开）'));
await closeAll();

// 实验 A：去掉 .topbar 的 filter
await page.addStyleTag({ content: '.topbar{filter:none !important}' });
await openModeMenu();
results.push(await hitCheck(page, '实验A：仅去掉 .topbar{filter}'));
await closeAll();
await page.evaluate(() => document.querySelectorAll('style[data-probe]').forEach((s) => s.remove()));
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1000);

// 实验 B：去掉 .tab-content 的残留 filter（Motion blur(0px)）
await page.addStyleTag({ content: '.tab-content{filter:none !important}' });
await openModeMenu();
results.push(await hitCheck(page, '实验B：仅去掉 .tab-content 残留 filter'));
await closeAll();

// 实验 C：见下方实验 D（fixed 浮层定位基准是否回到视口）

// 实验 D：气泡菜单定位是否回到点击点（只去掉 tab-content filter）
const ub = page.locator('[data-testid=msg-bubble-user]').last();
if (await ub.count()) {
  const b = await ub.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const m = document.querySelector('.wx-bubble-menu'), o = document.querySelector('.wx-menu-overlay');
    const g = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    return { menu: g(m), overlay: g(o) };
  });
  results.push({ label: '实验D：气泡菜单（点=' + JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }) + '）', tabFilterRemoved: true, ...after, expectOverlay: '0,0 1440x900' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
// 对照：恢复 tab-content filter 后再点一次
await page.addStyleTag({ content: '.tab-content{filter:blur(0px) !important}' });
if (await ub.count()) {
  const b = await ub.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const m = document.querySelector('.wx-bubble-menu'), o = document.querySelector('.wx-menu-overlay');
    const g = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    return { menu: g(m), overlay: g(o) };
  });
  results.push({ label: '对照：tab-content filter 保留时同一点击', ...after, expectOverlay: '0,0 1440x900' });
  await page.keyboard.press('Escape');
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'hypothesis.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
