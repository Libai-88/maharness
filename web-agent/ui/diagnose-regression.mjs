// ui/diagnose-regression.mjs —— 遮挡 / 点击失效 回归体检（源码已修，验证真·构建产物，不注入任何覆盖样式）
// 用法：node diagnose-regression.mjs [baseUrl] ；退出码 0=全绿 1=有红
// 原则：只点「当前已选中项」，不改用户的会话模式与模型绑定
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + JSON.stringify(detail) : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);

// ---------- 0. 首屏：.tab-content 过渡结束后不应残留 filter ----------
const tc = await page.evaluate(() => { const e = document.querySelector('.tab-content'); if (!e) return null; const cs = getComputedStyle(e); return { filter: cs.filter, rotate: cs.rotate, transform: cs.transform, opacity: cs.opacity }; });
check('首屏过渡后 .tab-content 无残留 filter（不再劫持 fixed 基准）', tc && (tc.filter === 'none'), tc);

// ---------- 1. 顶栏「模式」下拉：命中 + 真点击 + 弹出后关闭 ----------
const topMenuCount = await page.locator('.topbar .menu').count();
check('顶栏存在模式/模型两个下拉', topMenuCount >= 2, { topMenuCount });
for (let i = 0; i < topMenuCount; i++) {
  const trig = page.locator('.topbar .menu').nth(i).locator('button').first();
  const name = (await trig.innerText()).replace(/\s+/g, ' ').slice(0, 18);
  await trig.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const hit = await page.evaluate(() => {
    const p = document.querySelector('.topbar .menu .menu-pop');
    if (!p) return { noPopup: true };
    const items = [...p.querySelectorAll('.menu-item')];
    const own = items.map((it) => { const b = it.getBoundingClientRect(); const h = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)); return !!h && (it === h || it.contains(h)); });
    const r = p.getBoundingClientRect();
    return { allOwned: own.length > 0 && own.every(Boolean), count: own.length, popup: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, insideViewport: r.x >= 0 && r.right <= innerWidth };
  });
  check(`顶栏下拉#${i}「${name}」菜单项全部可命中`, hit.allOwned, hit);
  const sel = page.locator('.topbar .menu .menu-pop .menu-item.selected').first();
  const target = (await sel.count()) ? sel : page.locator('.topbar .menu .menu-pop .menu-item').first();
  const clicked = await target.click({ timeout: 2500 }).then(() => true).catch((e) => { check(`顶栏下拉#${i} 真点击`, false, String(e).split('\n').slice(0, 3).join(' / ')); return false; });
  await page.waitForTimeout(500);
  if (clicked) check(`顶栏下拉#${i}「${name}」点击后弹层自动关闭`, (await page.locator('.topbar .menu .menu-pop').count()) === 0);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 860).catch(() => undefined);
  await page.waitForTimeout(250);
}

// ---------- 2. 顶栏按钮组右对齐 ----------
const layout = await page.evaluate(() => { const t = document.querySelector('.topbar'), r = document.querySelector('.topbar-right'); if (!t || !r) return null; const a = t.getBoundingClientRect(), b = r.getBoundingClientRect(); return { topbarEnd: Math.round(a.right), rightEnd: Math.round(b.right), gapToEdge: Math.round(a.right - b.right) }; });
check('顶栏按钮组贴右端（不再压到侧栏/聊天区分界）', layout && layout.gapToEdge >= 20 && layout.gapToEdge <= 30, layout);

// ---------- 3. 气泡菜单：定位基准回到视口 + 点侧栏可关 ----------
const ub = page.locator('[data-testid=msg-bubble-user]').last();
if (await ub.count()) {
  const b = await ub.boundingBox();
  const px = Math.round(b.x + b.width / 2), py = Math.round(b.y + b.height / 2);
  await page.mouse.click(px, py, { button: 'right' });
  await page.waitForTimeout(500);
  const m = await page.evaluate(({ px, py }) => {
    const menu = document.querySelector('.wx-bubble-menu'), ov = document.querySelector('.wx-menu-overlay');
    const g = (e) => e ? e.getBoundingClientRect() : null;
    const mr = g(menu), orr = g(ov);
    return {
      click: [px, py],
      menuCx: mr ? Math.round(mr.x + mr.width / 2) : null, menuBottom: mr ? Math.round(mr.bottom) : null,
      overlayRect: orr ? `${Math.round(orr.x)},${Math.round(orr.y)} ${Math.round(orr.width)}x${Math.round(orr.height)}` : null,
      viewport: `${innerWidth}x${innerHeight}`,
      items: [...document.querySelectorAll('.wx-bubble-menu button')].map((x) => { const r = x.getBoundingClientRect(); const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return { t: x.textContent.trim().slice(0, 4), ok: !!h && x.contains(h) }; }),
    };
  }, { px, py });
  check('气泡菜单出现在点击点正上方（偏差 ≤ 8px）', m.menuCx !== null && Math.abs(m.menuCx - px) <= 8 && Math.abs(m.menuBottom - (py - 6)) <= 8, m);
  check('气泡菜单遮罩覆盖整个视口', m.overlayRect === `0,0 ${m.viewport.replace('x', 'x')}`.replace('0,0 1440x900', '0,0 1440x900') && m.overlayRect.startsWith('0,0'), { overlayRect: m.overlayRect, viewport: m.viewport });
  check('气泡菜单项逐个可命中', m.items.length > 0 && m.items.every((i) => i.ok), m.items);
  await page.mouse.click(120, 420);
  await page.waitForTimeout(400);
  check('点侧栏（遮罩上）即可关闭气泡菜单', (await page.locator('.wx-menu-overlay').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
} else {
  check('气泡菜单用例（需已有对话）', false, '当前会话无用户气泡，跳过');
}

// ---------- 4. 斜杠命令面板：模态覆盖视口且面板不被裁切 ----------
const ta = page.locator('textarea').first();
if (await ta.count()) {
  await ta.click().catch(() => undefined);
  await ta.type('/');
  await page.waitForTimeout(900);
  const cmd = await page.evaluate(() => {
    const o = document.querySelector('.cmd-overlay'), p = document.querySelector('.cmd-panel');
    if (!o || !p) return { noPalette: true, overlay: !!o, panel: !!p };
    const or_ = o.getBoundingClientRect(), pr = p.getBoundingClientRect();
    return { overlay: `${Math.round(or_.x)},${Math.round(or_.y)} ${Math.round(or_.width)}x${Math.round(or_.height)}`, panel: `${Math.round(pr.x)},${Math.round(pr.y)} ${Math.round(pr.width)}x${Math.round(pr.height)}`, panelFullyVisible: pr.x >= 0 && pr.y >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight, panelCentered: Math.abs((pr.x + pr.width / 2) - innerWidth / 2) < 8, viewport: `${innerWidth}x${innerHeight}` };
  });
  check('命令面板遮罩覆盖视口 + 面板不被 overflow 裁切', cmd.overlay && cmd.overlay.startsWith('0,0') && cmd.panelFullyVisible && cmd.panelCentered, cmd);
  await page.keyboard.press('Escape');
  await ta.fill('').catch(() => undefined);
  await page.waitForTimeout(300);
}

// ---------- 5. 轨迹面板开关仍有效（回归不被顶栏 z-index 改动影响） ----------
const before = await page.locator('.trail-panel').count();
await page.locator('.topbar .tb-icon-btn').first().click({ timeout: 3000 }).catch(() => undefined);
await page.waitForTimeout(800);
const mid = await page.locator('.trail-panel').count();
await page.locator('.topbar .tb-icon-btn').first().click({ timeout: 3000 }).catch(() => undefined);
await page.waitForTimeout(800);
const after = await page.locator('.trail-panel').count();
check('轨迹面板开关：开→关→开', before === 1 && mid === 0 && after === 1, { before, mid, after });

// ---------- 6. 各 Tab 全量命中扫描（无穿透、无互相压盖） ----------
for (const t of ['文件', '插件', '统计', '设置', '工作台', '会话']) {
  const loc = page.locator('.sidebar button', { hasText: t }).first();
  if (!(await loc.count())) continue;
  await loc.click({ timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(1400);
  const sweep = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, [role="button"], [role="menuitem"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05 || cs.pointerEvents === 'none') return;
      if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) return;
      const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      if (h && h !== el && !el.contains(h) && !h.contains(el)) bad.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(/\s+/)[0]} ← ${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(/\s+/)[0]}`);
    });
    const fixedLayers = [...document.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return cs.position === 'fixed' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05 && e.getBoundingClientRect().width > 40; }).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}.${(e.getAttribute('class') || '').split(/\s+/)[0]} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    return { bad: bad.slice(0, 12), badCount: bad.length, fixedLayers };
  });
  check(`「${t}」页无可点击穿透控件`, sweep.badCount === 0, sweep.badCount ? sweep.bad : { controls: 'ok', fixedLayers: sweep.fixedLayers });
}

// ---------- 7. 非涂鸦品牌下顶栏定位基准 ----------
for (const brand of ['ink', 'moss', 'doodle']) {
  await page.evaluate((b) => { localStorage.setItem('maharness-brand', b); }, brand);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const hd = await page.evaluate(() => { const t = document.querySelector('.topbar'), h = document.querySelector('.wx-header-center'); if (!t || !h) return null; const a = t.getBoundingClientRect(), b = h.getBoundingClientRect(); return { topbarCx: Math.round(a.x + a.width / 2), headerCx: Math.round(b.x + b.width / 2), topbarFilter: getComputedStyle(t).filter.slice(0, 20), topbarZ: getComputedStyle(t).zIndex }; });
  check(`品牌=${brand}：会话标题相对顶栏居中`, hd && Math.abs(hd.topbarCx - hd.headerCx) <= 4, hd);
}
await page.evaluate(() => localStorage.setItem('maharness-brand', 'doodle'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

check('无 JS 运行时报错', errs.length === 0, errs.slice(0, 6));
await page.screenshot({ path: path.join(OUT, 'regression-final.png') });
await browser.close();

const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'regression.json'), JSON.stringify({ ts: Date.now(), total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
