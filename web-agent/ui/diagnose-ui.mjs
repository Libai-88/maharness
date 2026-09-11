// ui/diagnose-ui.mjs —— 前端遮挡 / 点击失效 自动体检脚本（诊断用，非 e2e 断言）
// 用法：node diagnose-ui.mjs [baseUrl]
//   1) 打开页面，收集 console / pageerror
//   2) 命中测试：每个可交互控件中心点 elementFromPoint，找出「点击被谁抢走」
//   3) 遮挡矩阵：所有具定位+层级的可见浮层，两两求交集面积，报告互相压盖
//   4) 关键状态截图（首屏 / 各下拉菜单展开 / 各 Tab）
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

async function audit(page, label) {
  const res = await page.evaluate(() => {
    const desc = (el) => {
      if (!el) return 'null';
      if (el === document.body) return 'body';
      if (el === document.documentElement) return 'html';
      const cn = el.getAttribute('class');
      const cls = cn && cn.trim() ? '.' + cn.trim().split(/\s+/).join('.') : '';
      const id = el.id ? '#' + el.id : '';
      const testid = el.dataset && el.dataset.testid ? `[t=${el.dataset.testid}]` : '';
      const txt = (el.textContent || '').trim().slice(0, 16).replace(/\s+/g, ' ');
      return `<${el.tagName.toLowerCase()}${id}${cls}${testid}>${txt ? ' "' + txt + '"' : ''}`;
    };
    const chain = (el) => {
      const out = [];
      let cur = el;
      while (cur && cur !== document.documentElement && out.length < 8) {
        const cs = getComputedStyle(cur);
        const r = cur.getBoundingClientRect();
        out.push({
          el: desc(cur), position: cs.position, z: cs.zIndex,
          opacity: cs.opacity, pe: cs.pointerEvents,
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        });
        cur = cur.parentElement;
      }
      return out;
    };
    const blocked = [];
    const seen = new Set();
    const sel = 'button, a[href], input:not([type=hidden]), textarea, select, [role="button"], [role="menuitem"], [role="tab"]';
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return;
      if (cs.pointerEvents === 'none') return;
      if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) return;
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (!hit) return;
      if (hit === el || el.contains(hit) || hit.contains(el)) return;
      const key = desc(el) + '||' + desc(hit);
      if (seen.has(key)) return;
      seen.add(key);
      blocked.push({ control: desc(el), rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, at: [x, y], blockedBy: desc(hit), blockedChain: chain(hit) });
    });
    // 浮层清单 + 两两遮挡矩阵
    const layers = [];
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute' && cs.position !== 'sticky') return;
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      if (cs.position !== 'fixed' && cs.zIndex === 'auto') return;
      layers.push({ el: desc(el), position: cs.position, z: cs.zIndex, x: r.x, y: r.y, w: r.width, h: r.height });
    });
    const overlaps = [];
    for (let i = 0; i < layers.length; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        const a = layers[i], b = layers[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 4 || oy <= 4) continue;
        const area = ox * oy;
        const smaller = Math.min(a.w * a.h, b.w * b.h);
        if (area / smaller < 0.15) continue;
        overlaps.push({
          pct: Math.round((area / smaller) * 100),
          pair: a.el + '  ✕  ' + b.el,
          aZ: a.z, bZ: b.z, aPos: a.position, bPos: b.position,
          aRect: `${Math.round(a.x)},${Math.round(a.y)} ${Math.round(a.w)}x${Math.round(a.h)}`,
          bRect: `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`,
        });
      }
    }
    return { viewport: `${innerWidth}x${innerHeight}`, blocked, layers: layers.map((l) => ({ el: l.el, z: l.z, position: l.position, rect: `${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.w)}x${Math.round(l.h)}` })), overlaps };
  });
  await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  return { label, ...res };
}

const reports = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
reports.push(await audit(page, '01-home'));

// 顶栏下拉逐个展开
const menuCount = await page.locator('.topbar .menu').count();
for (let i = 0; i < menuCount; i++) {
  const btn = page.locator(`.topbar .menu >> nth=${i} >> button`).first();
  const label = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 16);
  await btn.click({ timeout: 3000 }).catch((e) => reports.push({ label: `menu-click-fail#${i}:${label}`, error: String(e).slice(0, 240) }));
  await page.waitForTimeout(450);
  reports.push(await audit(page, `10-menu${i}-${label || 'unnamed'}`));
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.mouse.click(700, 450).catch(() => undefined);
  await page.waitForTimeout(300);
}

// 各主 Tab
const tabNames = ['会话', '文件', '插件', '统计', '设置', '工作台'];
for (const t of tabNames) {
  const loc = page.locator('.sidebar button', { hasText: t }).first();
  if (!(await loc.count())) continue;
  const before = await page.evaluate(() => location.href);
  await loc.click({ timeout: 4000 }).catch((e) => reports.push({ label: `tab-click-fail:${t}`, error: String(e).slice(0, 240) }));
  await page.waitForTimeout(1300);
  const r = await audit(page, `20-tab-${t}`);
  r.urlChanged = before !== (await page.evaluate(() => location.href));
  reports.push(r);
}

await browser.close();

const summary = {
  base: BASE,
  consoleMsgs: [...new Set(consoleMsgs)].slice(0, 40),
  states: reports.map((r) => ({
    label: r.label,
    error: r.error,
    urlChanged: r.urlChanged,
    blockedCount: r.blocked ? r.blocked.length : 0,
    blocked: (r.blocked || []).map((b) => ({ control: b.control, rect: b.rect, at: b.at, blockedBy: b.blockedBy, byChain: b.blockedChain.slice(0, 4) })),
    layerCount: r.layers ? r.layers.length : 0,
    overlaps: (r.overlaps || []).slice(0, 25),
  })),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
