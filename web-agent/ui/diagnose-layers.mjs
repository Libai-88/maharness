// ui/diagnose-layers.mjs —— 第三轮：fixed 浮层定位基准逃逸 / 模态遮罩范围 / 侧栏下拉裁切 实测
// 用法：node diagnose-layers.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const R = {};

const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { sel: s, rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, position: cs.position, z: cs.zIndex, viewport: `${innerWidth}x${innerHeight}` };
}, sel);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });
// 记录真实落到文档上的 click 目标，判断「点击穿透到谁」
await page.addInitScript(() => {
  window.__clicks = [];
  document.addEventListener('click', (e) => {
    const t = e.target;
    window.__clicks.push({ tag: t.tagName, cls: (t.getAttribute && t.getAttribute('class')) || '', text: (t.textContent || '').trim().slice(0, 14) });
  }, true);
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
R.viewport = await page.evaluate(() => `${innerWidth}x${innerHeight}`);

// ---- 1. 顶栏右侧按钮组的水平位置（space-between 单元素陷阱） ----
R.topbarLayout = await page.evaluate(() => {
  const tb = document.querySelector('.topbar');
  const right = document.querySelector('.topbar-right');
  const left = document.querySelector('.topbar-left');
  const rb = right?.getBoundingClientRect();
  const tbb = tb?.getBoundingClientRect();
  return {
    hasTopbarLeft: !!left, topbar: tbb ? `${Math.round(tbb.x)}..${Math.round(tbb.right)} (w=${Math.round(tbb.width)})` : null,
    topbarRight: rb ? `${Math.round(rb.x)}..${Math.round(rb.right)}` : null,
    shouldEndNear: tbb ? Math.round(tbb.right - 24) : null,
    justifyContent: tb ? getComputedStyle(tb).justifyContent : null,
  };
});

// ---- 2. 顶栏下拉：真实点击 + 穿透目标 ----
R.topbarMenus = [];
for (let i = 0; i < await page.locator('.topbar .menu').count(); i++) {
  const trig = page.locator('.topbar .menu').nth(i).locator('button').first();
  const label = (await trig.innerText()).replace(/\s+/g, ' ').slice(0, 24);
  await page.evaluate(() => { window.__clicks = []; });
  await trig.click({ timeout: 3000 }).catch((e) => R.topbarMenus.push({ i, label, triggerClickError: String(e).slice(0, 160) }));
  await page.waitForTimeout(500);
  const pop = await rectOf(page, '.topbar .menu .menu-pop');
  const item = page.locator('.topbar .menu .menu-pop .menu-item').nth(1);
  const itemTxt = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 16);
  let clickErr = null;
  if (await item.count()) {
    await page.evaluate(() => { window.__clicks = []; });
    await item.click({ timeout: 2500 }).then(() => 'ok').catch((e) => { clickErr = String(e).split('\n').slice(0, 6).join(' | '); });
    await page.waitForTimeout(600);
  }
  const clicks = await page.evaluate(() => window.__clicks);
  const after = (await trig.innerText().catch(() => '?')).replace(/\s+/g, ' ').slice(0, 24);
  R.topbarMenus.push({ i, label, popup: pop, triedItem: itemTxt, clickError: clickErr, firstRealClickTargets: clicks.slice(0, 3), triggerBefore: label, triggerAfter: after });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 820);
  await page.waitForTimeout(300);
}

// ---- 3. 气泡菜单（position:fixed 在带 filter 的祖先内 → 定位基准被劫持） ----
const ub = page.locator('[data-testid=msg-bubble-user]').last();
R.bubbleMenu = { skipped: '无用户气泡' };
if (await ub.count()) {
  const box = await ub.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(500);
  const menu = await rectOf(page, '.wx-bubble-menu');
  const overlay = await rectOf(page, '.wx-menu-overlay');
  const clickPt = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  R.bubbleMenu = { clickPt, menu, overlay, items: await page.evaluate(() => [...document.querySelectorAll('.wx-bubble-menu button')].map((b) => { const r = b.getBoundingClientRect(); const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return { text: b.textContent.trim().slice(0, 6), reachable: !!h && (b === h || b.contains(h)) , hit: h ? h.tagName + '.' + ((h.getAttribute('class') || '').split(/\s+/)[0]) : 'null' }; })) };
  // 点遮罩外的侧栏，看遮罩能否关闭（遮罩若只覆盖 tab-content 则关不掉）
  await page.mouse.click(120, 400);
  await page.waitForTimeout(400);
  R.bubbleMenu.closedBySidebarClick = (await page.locator('.wx-menu-overlay').count()) === 0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// ---- 4. 斜杠命令面板（.cmd-overlay z:100 在 .chat-area overflow:hidden 内） ----
const ta = page.locator('textarea').first();
R.cmdPalette = { skipped: '无输入框' };
if (await ta.count()) {
  await ta.click().catch(() => undefined);
  await ta.type('/');
  await page.waitForTimeout(700);
  const ov = await rectOf(page, '.cmd-overlay');
  R.cmdPalette = { overlay: ov, exists: !!ov, coversViewport: ov ? ov.rect.startsWith('0,0') : false, panel: await rectOf(page, '.cmd-panel') };
  await page.keyboard.press('Escape');
  await ta.fill('');
  await page.waitForTimeout(300);
}

// ---- 5. 侧栏工作区下拉是否被 overflow:hidden 裁切（文件页） ----
await page.locator('.sidebar button', { hasText: '文件' }).first().click().catch(() => undefined);
await page.waitForTimeout(1500);
const wsWrap = page.locator('.ws-menu-wrap').first();
if (await wsWrap.count()) {
  await wsWrap.locator('button').first().click({ timeout: 3000 }).catch((e) => R.wsMenu = { clickError: String(e).slice(0, 200) });
  await page.waitForTimeout(500);
  R.wsMenu = await page.evaluate(() => {
    const m = document.querySelector('.ws-menu');
    const sb = document.querySelector('.sidebar') || m?.closest('[class*=ws-]')?.closest('div');
    if (!m) return { missing: true };
    const r = m.getBoundingClientRect();
    const host = m.closest('.sidebar');
    const hr = host?.getBoundingClientRect();
    const clipInfo = [];
    let c = m.parentElement;
    while (c) { const cs = getComputedStyle(c); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clipInfo.push({ el: c.tagName + '.' + (c.getAttribute('class') || '').split(/\s+/)[0], overflow: cs.overflowX + '/' + cs.overflowY, rect: `${Math.round(c.getBoundingClientRect().x)},${Math.round(c.getBoundingClientRect().y)} ${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}` }); c = c.parentElement; }
    const items = [...m.querySelectorAll('button')].map((b) => { const br = b.getBoundingClientRect(); const h = document.elementFromPoint(Math.round(br.x + br.width / 2), Math.round(br.y + br.height / 2)); return { text: b.textContent.trim().slice(0, 14), reachable: !!h && (b === h || b.contains(h)) }; });
    return { rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, z: getComputedStyle(m).zIndex, clippers: clipInfo, items };
  });
}

// ---- 6. 待办看板详情遮罩（tb-detail-overlay z:200）----
await page.locator('.sidebar button', { hasText: '会话' }).first().click().catch(() => undefined);
await page.waitForTimeout(1200);
R.misc = await page.evaluate(() => {
  const list = [];
  document.querySelectorAll('*').forEach((e) => {
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed' && cs.display !== 'none') {
      const r = e.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) list.push(`${e.tagName.toLowerCase()}.${(e.getAttribute('class') || '').split(/\s+/)[0]} z:${cs.zIndex} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  });
  return list;
});

// ---- 7. 轨迹面板开关：功能验证 ----
await page.waitForTimeout(200);
const before = await page.locator('.trail-panel').count();
const toggleBtn = page.locator('.topbar .tb-icon-btn');
R.trailToggle = { before };
if (await toggleBtn.count()) {
  await toggleBtn.first().click({ timeout: 3000 }).catch((e) => R.trailToggle.error = String(e).slice(0, 200));
  await page.waitForTimeout(800);
  R.trailToggle.afterClick = await page.locator('.trail-panel').count();
}

await browser.close();
R.errs = errs;
fs.writeFileSync(path.join(OUT, 'layers.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 2));
