// ui/diagnose-stacking.mjs —— 浮层层级（stacking context）逃逸探针 + 点击功能验证
// 用法：node diagnose-stacking.mjs [baseUrl]
// 对每个浮层：1) 列出祖先链上所有「创建层叠上下文」的属性 2) 中心点命中测试 3) 真实点击后验证状态是否变化
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

/** 在页面内：给一个选择器，返回其浮层的层叠逃逸诊断 */
function layerProbe(selector) {
  return (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true, sel };
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const desc = (n) => {
      if (!n) return 'null';
      if (n === document.body) return 'body';
      const cn = n.getAttribute('class');
      return `<${n.tagName.toLowerCase()}>${cn ? ' .' + cn.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
    };
    const reasons = [];
    const anc = [];
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      const why = [];
      if (cs.position !== 'static' && cs.zIndex !== 'auto') why.push(`z-index:${cs.zIndex}`);
      if (cs.filter && cs.filter !== 'none') why.push(`filter:${cs.filter.slice(0, 24)}`);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') why.push(`backdrop-filter`);
      if (parseFloat(cs.opacity) < 1) why.push(`opacity:${cs.opacity}`);
      if (cs.transform && cs.transform !== 'none') why.push(`transform`);
      if (cs.rotate && cs.rotate !== 'none' && cs.rotate !== '0deg') why.push(`rotate:${cs.rotate}`);
      if (cs.willChange && cs.willChange !== 'auto') why.push(`will-change:${cs.willChange}`);
      if (cs.isolation !== 'auto') why.push('isolation');
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') why.push(`mix-blend:${cs.mixBlendMode}`);
      if (cs.contain && !/(^|\s)none/.test(cs.contain)) why.push(`contain:${cs.contain}`);
      if (cs.webkitAppRegion && cs.webkitAppRegion !== 'no-drag') why.push('app-region');
      const ors = [];
      if (cs.overflowX !== 'visible') ors.push('x:' + cs.overflowX);
      if (cs.overflowY !== 'visible') ors.push('y:' + cs.overflowY);
      const cr = cur.getBoundingClientRect();
      const clipped = ors.length && (r.x < cr.x - 1 || r.y < cr.y - 1 || r.right > cr.right + 1 || r.bottom > cr.bottom + 1);
      if (why.length || ors.length) {
        anc.push({ el: desc(cur), stackingContext: why.join(' '), overflow: ors.join(' ') || 'visible', clipRect: `${Math.round(cr.x)},${Math.round(cr.y)} ${Math.round(cr.width)}x${Math.round(cr.height)}`, popupOutsideIt: !!clipped, pos: cs.position });
      }
      if (why.length) reasons.push(desc(cur) + ' → ' + why.join(' '));
      cur = cur.parentElement;
    }
    return {
      sel, rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      center: [cx, cy], hitAtCenter: desc(hit),
      ownsPoint: !hit ? false : (hit === el || el.contains(hit) || hit.contains(el)),
      trappedByStackingContexts: reasons,
      ancestorStackingAudit: anc,
    };
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const out = { base: BASE, sketchyInDom: await page.evaluate(() => !!document.querySelector('#sketchy')), checks: [], errs };
const probe = async (label, sel) => { const r = await page.evaluate(layerProbe(sel), sel); out.checks.push({ label, ...r }); return r; };

// ---------- 1. 顶栏「模式」下拉 ----------
const topMenus = page.locator('.topbar .menu');
const n = await topMenus.count();
for (let i = 0; i < n; i++) {
  const trigger = topMenus.nth(i).locator('button').first();
  const triggerText = (await trigger.innerText()).replace(/\s+/g, ' ');
  await trigger.click({ timeout: 3000 }).catch((e) => out.checks.push({ label: `topbar-menu#${i} 打不开`, error: String(e).slice(0, 200) }));
  await page.waitForTimeout(500);
  const p = await probe(`顶栏菜单#${i}「${triggerText}」`, '.topbar .menu .menu-pop');
  p.layerCountInDom = await page.locator('.topbar .menu .menu-pop').count();
  // 功能验证：点第一个菜单项，看触发器文字是否变化
  const item = page.locator('.topbar .menu .menu-pop .menu-item').first();
  const itemText = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ');
  const before = triggerText;
  const clickable = await item.isEnabled().catch(() => false);
  await item.click({ timeout: 2500 }).then(() => 'ok').catch((e) => String(e).slice(0, 220));
  await page.waitForTimeout(900);
  const after = (await trigger.innerText().catch(() => '?')).replace(/\s+/g, ' ');
  out.checks.push({
    label: `顶栏菜单#${i} 点击「${itemText}」功能验证`, clickable, before, after,
    tookEffect: before !== after,
    note: '模型菜单选同一项不会变文字，故同时看 hit 归属',
  });
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.click(700, 800).catch(() => undefined);
  await page.waitForTimeout(300);
}

// ---------- 2. 输入栏模型 pill（drop-up） ----------
const pill = page.locator('.composer .menu button').first();
if (await pill.count()) {
  const pt = (await pill.innerText()).replace(/\s+/g, ' ');
  await pill.click({ timeout: 3000 }).catch((e) => out.checks.push({ label: 'composer pill 打不开', error: String(e).slice(0, 200) }));
  await page.waitForTimeout(500);
  await probe('输入栏模型 pill 下拉（drop-up）', '.composer .menu .menu-pop');
  // 与消息区/轨迹面板的命中关系
  const itemBox = await page.locator('.composer .menu .menu-pop .menu-item').first().boundingBox().catch(() => null);
  if (itemBox) {
    const hitInfo = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const chain = [];
      let c = el;
      while (c && chain.length < 6) { const cs = getComputedStyle(c); chain.push({ el: c.tagName + (c.getAttribute('class') ? '.' + c.getAttribute('class').trim().split(/\s+/)[0] : ''), pos: cs.position, z: cs.zIndex, filter: cs.filter === 'none' ? null : cs.filter.slice(0, 20) }); c = c.parentElement; }
      return chain;
    }, { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 });
    out.checks.push({ label: '输入栏 pill 下拉项中心命中链', hitInfo });
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.click(700, 300).catch(() => undefined);
}

// ---------- 3. 表情面板 ----------
const emojiBtn = page.locator('[data-testid=emoji-btn]');
if (await emojiBtn.count()) {
  await emojiBtn.first().click({ timeout: 3000 }).catch((e) => out.checks.push({ label: '表情键点击失败', error: String(e).slice(0, 200) }));
  await page.waitForTimeout(500);
  await probe('表情面板（composer 内 absolute）', '.emoji-panel');
  await page.mouse.click(700, 300).catch(() => undefined);
  await page.waitForTimeout(250);
}

// ---------- 4. 气泡长按菜单（fixed + overlay） ----------
const bubble = page.locator('[data-testid=msg-bubble-assistant]').last();
if (await bubble.count()) {
  const box = await bubble.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.waitForTimeout(500);
    await probe('气泡操作菜单（fixed z400）', '.wx-bubble-menu');
    await probe('气泡菜单遮罩（fixed z390）', '.wx-menu-overlay');
    const itemHit = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.wx-bubble-menu button')];
      return items.map((it) => {
        const r = it.getBoundingClientRect();
        const h = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        return { text: it.textContent.trim().slice(0, 8), ok: !!h && (it === h || it.contains(h)) };
      });
    });
    out.checks.push({ label: '气泡菜单项逐个命中', itemHit });
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.mouse.click(700, 800).catch(() => undefined);
  }
}

// ---------- 5. 轨迹面板开关 + 面板互压 ----------
const trailBtn = page.locator('.topbar .tb-icon-btn').first();
if (await trailBtn.count()) {
  await trailBtn.click({ timeout: 3000 }).catch((e) => out.checks.push({ label: '轨迹面板开关点击失败', error: String(e).slice(0, 200) }));
  await page.waitForTimeout(700);
  out.checks.push({ label: '轨迹面板开关后 trail-panel 数量', trailPanels: await page.locator('.trail-panel').count() });
  await trailBtn.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

// ---------- 6. 侧栏会话项 / 各按钮全量命中复检 ----------
out.checks.push({ label: '当前 DOM 中所有浮层清单', value: await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return (cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex !== 'auto' && cs.display !== 'none'; }).map((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}.${(e.getAttribute('class') || '').split(/\s+/)[0]} z:${cs.zIndex} pos:${cs.position} ${Math.round(r.width)}x${Math.round(r.height)}`; })) });

await browser.close();
fs.writeFileSync(path.join(OUT, 'stacking.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
