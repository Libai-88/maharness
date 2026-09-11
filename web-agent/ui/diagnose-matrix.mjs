// ui/diagnose-matrix.mjs —— 组合实验矩阵：逐个/组合消除可疑层叠属性，实测顶栏弹层能否恢复命中
// 用法：node diagnose-matrix.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { name: '基线（现状）', css: '' },
  { name: 'A 去 .topbar filter', css: '.topbar{filter:none !important}' },
  { name: 'A2 去 .topbar filter+rotate', css: '.topbar{filter:none !important;rotate:none !important;transform:none !important}' },
  { name: 'B 去 .tab-content filter', css: '.tab-content{filter:none !important}' },
  { name: 'C 去 .main/.app 之外全部：tab-content filter + topbar filter', css: '.topbar{filter:none !important;rotate:none !important}.tab-content{filter:none !important}' },
  { name: 'D .topbar 提级 z-index:500', css: '.topbar{z-index:500 !important}' },
  { name: 'E .topbar 提级 z-index:500（保留全部 filter）', css: '.topbar{z-index:500 !important}' },
  { name: 'F .menu-pop 改 fixed', css: '.topbar .menu .menu-pop{position:fixed !important}' },
];

const probe = () => {
  const pop = document.querySelector('.topbar .menu .menu-pop');
  if (!pop) return { noPopup: true };
  const items = [...pop.querySelectorAll('.menu-item')].map((it) => {
    const b = it.getBoundingClientRect();
    const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    const h = document.elementFromPoint(x, y);
    return { text: it.textContent.trim().slice(0, 8), ok: !!h && (it === h || it.contains(h)), by: h ? h.tagName.toLowerCase() + '.' + (h.getAttribute('class') || '').split(/\s+/)[0] : 'null' };
  });
  const fmt = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e);
    return { sel, pos: cs.position, z: cs.zIndex, filter: cs.filter === 'none' ? null : cs.filter.slice(0, 22), rotate: cs.rotate, transform: cs.transform === 'none' ? null : 'T', opacity: cs.opacity, willChange: cs.willChange === 'auto' ? null : cs.willChange, contain: cs.contain === 'none' ? null : cs.contain };
  };
  return { items, allOk: items.every((i) => i.ok), styles: [fmt('.topbar'), fmt('.topbar-right'), fmt('.menu'), fmt('.menu-pop'), fmt('.tab-content'), fmt('.main'), fmt('.app')] };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

for (const c of CASES) {
  await page.evaluate(() => document.getElementById('diag-override')?.remove());
  if (c.css) {
    await page.evaluate((css) => {
      const s = document.createElement('style'); s.id = 'diag-override'; s.textContent = css; document.head.appendChild(s);
    }, c.css);
  }
  // 关掉可能残留的菜单
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 860).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.locator('.topbar .menu').first().locator('button').first().click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const r = await page.evaluate(probe);
  // Playwright 真点击（含稳定性判定）
  let click = 'n/a';
  if (!r.noPopup) {
    click = await page.locator('.topbar .menu .menu-pop .menu-item').nth(1).click({ timeout: 2000 }).then(() => 'OK').catch((e) => 'FAIL ' + String(e).split('\n').slice(0, 1)[0] + ' || ' + String(e).split('\n').filter((l) => /intercept|stable|visible/.test(l)).join(' / ').replace(/\u001b\[\d+m/g, '').slice(0, 200));
    await page.waitForTimeout(400);
  }
  const modeNow = (await page.locator('.topbar .menu').first().locator('button').first().innerText().catch(() => '?')).replace(/\s+/g, ' ');
  results.push({ case: c.name, css: c.css || '(none)', ...r, playwrightClick: click, triggerNow: modeNow });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 860).catch(() => undefined);
  await page.waitForTimeout(250);
  // 每次点击后重新读一次触发器（若曾生效，模式会变）
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((r) => ({ case: r.case, allOk: r.allOk, items: r.items, click: r.playwrightClick, triggerNow: r.triggerNow, styles: r.styles })), null, 2));
