// ui/diagnose-stop-health.mjs —— 隔离实验：用「当前可用」的 provider 做主线路，
// 只做一次"发消息 → 中途停下"，验证「用户取消」不会被记成 provider 故障。
// 为什么需要隔离：主线路 deepseek 的密钥本身正在失败（另一个探针里出现了 failover 提示），
// 那种情况下横幅会出现，但原因与"停止"无关——必须换一条正常的线路才能证明修复有效。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const PROVIDER = 'free-085k';
const MODEL = 'MiniMax-M2.7:free';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);

const healthBefore = await page.evaluate(async (p) => (await (await fetch('/api/providers')).json()).find((x) => x.id === p)?.health ?? null, PROVIDER);
console.log('实验前 health:', JSON.stringify(healthBefore));

const sid = await page.evaluate(async ({ p, m }) => {
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m, provider: p }) });
  const s = await r.json();
  await fetch(`/api/sessions/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: p, model: m }) });
  return s.id;
}, { p: PROVIDER, m: MODEL });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /新会话/.test(e.textContent))?.click(); });
await page.waitForTimeout(1200);

const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('慢慢地把「你好」这两个字展开成一段很长的欢迎词，分很多段写，越慢越好。');
await page.keyboard.press('Enter');

// 等到真的开始出字
let got = false;
for (let i = 0; i < 60; i++) {
  got = await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-row.them .wx-bubble')].pop(); return !!b && b.textContent.trim().length > 4; });
  if (got) break;
  await page.waitForTimeout(400);
}
if (!got) {
  const h = await page.evaluate(async (p) => (await (await fetch('/api/providers')).json()).find((x) => x.id === p)?.health ?? null, PROVIDER);
  console.log('未能开始出字（线路本身有问题），实验结论：不确定。当前 health =', JSON.stringify(h));
}
await page.evaluate(() => document.querySelector('.send-btn.stop')?.click());
await page.waitForTimeout(2200);

const after = await page.evaluate(async (p) => ({
  authBanner: document.querySelectorAll('.sess-banner.auth').length,
  banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 44)),
  retryNotice: [...document.querySelectorAll('.msg-row.them')].some((r) => /换 .* 再说一遍|没接上/.test(r.textContent || '')),
  stoppedRows: [...document.querySelectorAll('.wx-stopped')].length,
  toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim().slice(0, 40)),
  health: (await (await fetch('/api/providers')).json()).find((x) => x.id === p)?.health ?? null,
}), PROVIDER);

check('出字后停下：留下温和说明，代码路径正确', after.stoppedRows > 0, { stoppedRows: after.stoppedRows });
check('停下未触发 failover（没有"换线路"提示）', after.retryNotice === false, { retryNotice: after.retryNotice });
check('停下未把 provider 记成故障（health.authFailed 为假）', !after.health?.authFailed, { health: after.health });
check('停下未弹 provider 故障提示（无 auth 横幅 / toast）', after.authBanner === 0 && after.toasts.length === 0, { authBanner: after.authBanner, toasts: after.toasts, banners: after.banners });

await page.evaluate(async (id) => { await fetch(`/api/sessions/${id}`, { method: 'DELETE' }); }, sid);
await browser.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'stop-health.json'), JSON.stringify({ healthBefore, total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
