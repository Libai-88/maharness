// ui/diagnose-verify.mjs —— 验证拟定补丁能否一次性消掉全部实测症状（仅在浏览器内注入，不改源码）
// 拟定补丁：.topbar{z-index:60}  +  .tab-content 过渡结束后清除残留 filter
// 用法：node diagnose-verify.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const PATCH = `.topbar{z-index:60 !important}.tab-content{filter:none !important}`;
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

async function run(withPatch) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (withPatch) await page.addStyleTag({ content: PATCH });
  await page.waitForTimeout(1200);
  const r = {};

  // 1) 顶栏模式下拉：真点击
  await page.locator('.topbar .menu').first().locator('button').first().click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(450);
  r.modeMenuPopup = await page.evaluate(() => { const p = document.querySelector('.topbar .menu .menu-pop'); if (!p) return null; const b = p.getBoundingClientRect(); const it = p.querySelectorAll('.menu-item')[1]; if (!it) return { rect: `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}` }; const ib = it.getBoundingClientRect(); const ih = document.elementFromPoint(Math.round(ib.x + ib.width / 2), Math.round(ib.y + ib.height / 2)); return { rect: `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, itemPointOwnedBy: (ih && (it.contains(ih) || ih === it)) ? 'menu-item OK' : (ih ? ih.tagName.toLowerCase() + '.' + ((ih.getAttribute('class') || '').split(/\s+/)[0]) : 'null') }; });
  r.modeItemClick = await page.locator('.topbar .menu .menu-pop .menu-item').nth(1).click({ timeout: 2500 }).then(() => 'OK ✓').catch(() => 'FAIL ✗');
  await page.waitForTimeout(700);
  r.modeTriggerNow = (await page.locator('.topbar .menu').first().locator('button').first().innerText().catch(() => '?')).replace(/\s+/g, ' ');
  // 复位为普通模式
  await page.locator('.topbar .menu').first().locator('button').first().click({ timeout: 2000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.locator('.topbar .menu .menu-pop .menu-item').first().click({ timeout: 2000 }).then(() => 'reset-ok').catch(() => 'reset-fail');
  await page.waitForTimeout(500);

  // 2) 顶栏模型下拉
  const m2 = page.locator('.topbar .menu').nth(1).locator('button').first();
  if (await m2.count()) {
    await m2.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(450);
    r.modelItemClick = await page.locator('.topbar .menu .menu-pop .menu-item').nth(1).click({ timeout: 2500 }).then(() => 'OK ✓').catch(() => 'FAIL ✗');
    await page.waitForTimeout(900);
    r.modelTriggerNow = (await m2.innerText().catch(() => '?')).replace(/\s+/g, ' ').slice(0, 34);
    await page.keyboard.press('Escape');
  }

  // 3) 气泡菜单定位 + 遮罩覆盖范围
  const ub = page.locator('[data-testid=msg-bubble-user]').last();
  if (await ub.count()) {
    const b = await ub.boundingBox();
    const px = Math.round(b.x + b.width / 2), py = Math.round(b.y + b.height / 2);
    await page.mouse.click(px, py, { button: 'right' });
    await page.waitForTimeout(450);
    r.bubbleMenu = await page.evaluate(({ px, py }) => {
      const g = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, cx: Math.round(r.x + r.width / 2), bottom: Math.round(r.bottom) }; };
      return { click: [px, py], menu: g(document.querySelector('.wx-bubble-menu')), overlay: g(document.querySelector('.wx-menu-overlay')), overlayShouldBe: '0,0 1440x900' };
    }, { px, py });
    await page.mouse.click(120, 400);
    await page.waitForTimeout(400);
    r.bubbleMenu.closesOnSidebarClick = (await page.locator('.wx-menu-overlay').count()) === 0;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // 4) 命令面板模态覆盖
  const ta = page.locator('textarea').first();
  if (await ta.count()) {
    await ta.click().catch(() => undefined);
    await ta.type('/');
    await page.waitForTimeout(700);
    r.cmd = await page.evaluate(() => {
      const o = document.querySelector('.cmd-overlay'), p = document.querySelector('.cmd-panel');
      const g = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
      return { overlay: g(o), panel: g(p), overlayShouldBe: '0,0 1440x900', viewport: `${innerWidth}x${innerHeight}` };
    });
    await page.keyboard.press('Escape');
    await ta.fill('').catch(() => undefined);
  }

  // 5) 顶栏按钮组水平位置
  r.topbarRight = await page.evaluate(() => { const t = document.querySelector('.topbar'), rr = document.querySelector('.topbar-right'); if (!t || !rr) return null; const a = t.getBoundingClientRect(), b = rr.getBoundingClientRect(); return { topbar: `${Math.round(a.x)}..${Math.round(a.right)}`, right: `${Math.round(b.x)}..${Math.round(b.right)}`, expectedEnd: Math.round(a.right - 24) }; });

  await page.screenshot({ path: path.join(OUT, withPatch ? 'patched.png' : 'baseline.png'), fullPage: false });
  await browser.close();
  return r;
}

const before = await run(false);
const after = await run(true);
const out = { patch: PATCH, before, after };
fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
