// ui/diagnose-paint-order.mjs —— 用 elementsFromPoint 打出指定点的真实绘制顺序，找出「盖在弹层上面的到底是谁」
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

await page.locator('.topbar .menu').first().locator('button').first().click({ timeout: 3000 });
await page.waitForTimeout(500);

const dump = await page.evaluate(() => {
  const fmt = (e) => {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return {
      el: e.tagName.toLowerCase() + (e.getAttribute('class') ? '.' + e.getAttribute('class').trim().split(/\s+/).slice(0, 3).join('.') : ''),
      pos: cs.position, z: cs.zIndex, opacity: cs.opacity,
      filter: cs.filter === 'none' ? null : cs.filter.slice(0, 26),
      transform: cs.transform === 'none' ? null : 'T',
      rotate: (!cs.rotate || cs.rotate === 'none' || cs.rotate === '0deg') ? null : cs.rotate,
      pe: cs.pointerEvents === 'auto' ? null : cs.pointerEvents,
      ov: (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') ? `${cs.overflowX}/${cs.overflowY}` : null,
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      appRegion: cs.webkitAppRegion || null,
    };
  };
  const pop = document.querySelector('.topbar .menu .menu-pop');
  const item = pop.querySelector('.menu-item');
  const b = item.getBoundingClientRect();
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  const stack = document.elementsFromPoint(x, y).slice(0, 14).map(fmt);
  // 弹层自身是否被祖先裁掉 / 是否有 ancestor 的 overflow 把它切了
  const ancestors = [];
  let c = pop;
  while (c) { ancestors.push(fmt(c)); c = c.parentElement; }
  return { point: [x, y], itemRect: `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, stack, popupAncestors: ancestors };
});

fs.writeFileSync(path.join(OUT, 'paint-order.json'), JSON.stringify(dump, null, 2));
console.log(JSON.stringify(dump, null, 2));
await browser.close();
