// ui/diagnose-layers2.mjs —— 第四轮：文件页工作区下拉裁切 / 插件页待办详情遮罩 / 命令面板点外关闭 实测
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const R = {};

const clipAudit = () => {
  const m = document.querySelector('[data-probe="floating"]');
  if (!m) return { missing: true };
  const r = m.getBoundingClientRect();
  const clippers = [];
  const contexts = [];
  let c = m.parentElement;
  while (c) {
    const cs = getComputedStyle(c);
    const cr = c.getBoundingClientRect();
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      clippers.push({
        el: c.tagName.toLowerCase() + '.' + (c.getAttribute('class') || '').split(/\s+/)[0],
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        rect: `${Math.round(cr.x)},${Math.round(cr.y)} ${Math.round(cr.width)}x${Math.round(cr.height)}`,
        cutsTop: cr.top > r.top + 1 ? `${Math.round(cr.top - r.top)}px` : false,
        cutsLeft: cr.left > r.left + 1 ? `${Math.round(cr.left - r.left)}px` : false,
        cutsBottom: cr.bottom < r.bottom - 1 ? `${Math.round(r.bottom - cr.bottom)}px` : false,
        cutsRight: cr.right < r.right - 1 ? `${Math.round(r.right - cr.right)}px` : false,
      });
    }
    if (cs.filter !== 'none' || (cs.transform && cs.transform !== 'none') || (cs.rotate && cs.rotate !== 'none' && cs.rotate !== '0deg') || cs.perspective !== 'none' || cs.willChange.includes('filter') || cs.contain.includes('paint')) {
      contexts.push({ el: c.tagName.toLowerCase() + '.' + (c.getAttribute('class') || '').split(/\s+/)[0], filter: cs.filter === 'none' ? null : cs.filter.slice(0, 22), transform: cs.transform === 'none' ? null : 'yes', rotate: cs.rotate, contain: cs.contain });
    }
    c = c.parentElement;
  }
  const items = [...m.querySelectorAll('button, [role="menuitem"], input')].map((b) => {
    const br = b.getBoundingClientRect();
    const h = document.elementFromPoint(Math.round(br.x + br.width / 2), Math.round(br.y + br.height / 2));
    return { text: (b.textContent || b.placeholder || '').trim().slice(0, 16), reachable: !!h && (b === h || b.contains(h) || h.contains(b)), hitBy: h ? h.tagName.toLowerCase() + '.' + (h.getAttribute('class') || '').split(/\s+/)[0] : 'null' };
  });
  return { rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, position: getComputedStyle(m).position, z: getComputedStyle(m).zIndex, viewport: `${innerWidth}x${innerHeight}`, clippers, stackingContextAncestors: contexts, items };
};

const tag = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) e.setAttribute('data-probe', 'floating'); return !!e; }, sel);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// ---------- A. 命令面板：模态是否覆盖整屏 / 点侧栏能否关闭 ----------
const ta = page.locator('textarea').first();
if (await ta.count()) {
  await ta.click().catch(() => undefined);
  await ta.type('/');
  await page.waitForTimeout(800);
  await tag(page, '.cmd-overlay');
  R.cmdOverlay = await page.evaluate(clipAudit);
  R.cmdOverlay.panel = await page.evaluate(() => { const p = document.querySelector('.cmd-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
  // 点侧栏（遮罩之外）能否关闭
  await page.mouse.click(120, 300);
  await page.waitForTimeout(500);
  R.cmdOverlay.stillOpenAfterSidebarClick = await page.locator('.cmd-overlay').count() > 0;
  await page.evaluate(() => { const e = document.querySelector('.cmd-overlay'); if (e) { const r = e.getBoundingClientRect(); return; } });
  await page.keyboard.press('Escape');
  await ta.fill('').catch(() => undefined);
  await page.waitForTimeout(400);
  // 遮罩自身能否关闭（点遮罩空白处）
  await ta.click().catch(() => undefined);
  await ta.type('/');
  await page.waitForTimeout(700);
  if (await page.locator('.cmd-overlay').count()) {
    const or_ = await page.locator('.cmd-overlay').boundingBox();
    await page.mouse.click(or_.x + 12, or_.y + 12);
    await page.waitForTimeout(400);
    R.cmdOverlay.closeByBackdropInsideContent = (await page.locator('.cmd-overlay').count()) === 0;
  }
  await page.keyboard.press('Escape');
  await ta.fill('').catch(() => undefined);
}

// ---------- B. 文件页工作区下拉（.ws-menu z:60，祖先是否裁切） ----------
await page.locator('.sidebar button', { hasText: '文件' }).first().click().catch(() => undefined);
await page.waitForTimeout(1600);
R.filesTab = { foundPicker: await page.locator('.ws-picker').count(), foundLayout: await page.locator('.files-layout').count() };
if (await page.locator('.ws-picker').count()) {
  await page.locator('.ws-picker').first().click({ timeout: 3000 }).catch((e) => R.filesTab.pickerClickError = String(e).slice(0, 200));
  await page.waitForTimeout(600);
  await tag(page, '.ws-menu');
  R.wsMenu = await page.evaluate(clipAudit);
}

// ---------- C. 插件页 → 待办看板 → 详情遮罩（.tb-detail-overlay fixed z:200） ----------
await page.locator('.sidebar button', { hasText: '插件' }).first().click().catch(() => undefined);
await page.waitForTimeout(1600);
const todoCard = page.locator('.plugin-card', { hasText: 'todo' }).first();
R.pluginsTab = { cards: await page.locator('.plugin-card').count() };
if (await todoCard.count()) {
  await todoCard.click({ timeout: 3000 }).catch((e) => R.pluginsTab.cardClickError = String(e).slice(0, 200));
  await page.waitForTimeout(1200);
  const card = page.locator('.tb-card').first();
  if (await card.count()) {
    await card.click({ timeout: 3000 }).catch((e) => R.pluginsTab.todoCardError = String(e).slice(0, 200));
    await page.waitForTimeout(800);
    await tag(page, '.tb-detail-overlay');
    R.todoDetailOverlay = await page.evaluate(clipAudit);
    R.todoDetailOverlay.detailPanel = await page.evaluate(() => { const p = document.querySelector('.tb-detail'); if (!p) return null; const r = p.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    await page.keyboard.press('Escape');
  } else {
    R.todoDetailOverlay = { skipped: '看板无卡片可点开' };
  }
}

await browser.close();
R.errs = errs;
fs.writeFileSync(path.join(OUT, 'layers2.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 2));
