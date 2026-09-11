// ui/diagnose-live.mjs —— 真实端到端一次对话：实时演出 → 刷新后形态漂移 → 中途停止的语义
// ⚠️ 会真的调用一次 LLM（临时会话，跑完自动删除）。用法：node diagnose-live.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const R = { ts: Date.now() };

const PROMPT = '请先调用 list_dir 列出 D:\\DEEPSEEK 根目录，然后调用 run_subagent 让它帮你数一数这个目录里有多少个 .md 文件，最后用两三句话告诉我结果。';

const snap = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.messages-inner .msg-row')].map((r) => {
    const me = r.classList.contains('me');
    const sys = r.classList.contains('sys');
    const bubble = r.querySelector('.wx-bubble, .user-bubble, .wx-sys-msg');
    const txt = (bubble?.textContent || '').trim();
    return {
      kind: sys ? 'sys' : me ? 'me' : 'them',
      empty: txt.length === 0,
      len: txt.length,
      head: txt.slice(0, 26).replace(/\s+/g, ' '),
      tools: [...r.querySelectorAll('.tool-card')].map((t) => (t.querySelector('.tool-name')?.textContent || '') + '/' + (t.querySelector('.tool-status')?.textContent || '').trim()),
      members: [...r.querySelectorAll('.wx-member-speech')].map((t) => (t.querySelector('.wx-member-name')?.textContent || '') + ': ' + (t.querySelector('.wx-member-text')?.textContent || '').slice(0, 24)),
      think: r.querySelectorAll('.think-card').length,
      usage: (r.querySelector('.msg-extra')?.textContent || '').trim().slice(0, 48),
    };
  });
  return {
    rows,
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    joinMsgs: [...document.querySelectorAll('.wx-sys-msg')].map((e) => e.textContent.trim()).filter((t) => /加入了群聊/.test(t)),
    emptyBubbles: rows.filter((x) => x.empty).length,
    banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 70)),
    toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim().slice(0, 60)),
    sidebar: [...document.querySelectorAll('.sb-session-item')].map((e) => `${(e.querySelector('.name')?.textContent || '').trim()} | ${(e.querySelector('.wx-sb-preview')?.textContent || '').trim()} | ${(e.querySelector('.time')?.textContent || '').trim()}`),
    stopBtn: !!document.querySelector('.send-btn.stop'),
    typing: (document.querySelector('.wx-typing')?.textContent || '').trim(),
  };
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const net = [];
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) net.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 建临时会话
const sid = await page.evaluate(async (p) => {
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p }) });
  return (await r.json()).id;
}, 'deepseek-v4-flash-vision-exp');
R.tempSession = sid;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate((id) => { [...document.querySelectorAll('.sb-session-item')].find((e) => e.getAttribute('aria-current') === 'true' || true)?.click(); }, sid);
// 直接按标题选中新会话（标题尚未生成为「新会话」）
await page.evaluate(() => { const items = [...document.querySelectorAll('.sb-session-item')]; items.sort((a, b) => a.textContent.length - b.textContent.length); items.find((e) => /新会话/.test(e.textContent))?.click(); });
await page.waitForTimeout(1500);
R.firstContact = await snap(page);

// ---------- A. 完整跑一次（不打断）----------
await page.locator('textarea').first().click();
await page.locator('textarea').first().fill(PROMPT);
const t0 = Date.now();
await page.keyboard.press('Enter');
// 等首个 delta 出现，记录"发出后多久开始有字"（首字延迟）
let firstTokenAt = null;
for (let i = 0; i < 240; i++) {
  const has = await page.evaluate(() => { const b = document.querySelector('.msg-row.them:last-child .wx-bubble'); return b && b.textContent.trim().length > 0; });
  if (has) { firstTokenAt = Date.now() - t0; break; }
  await page.waitForTimeout(250);
}
R.firstTokenMs = firstTokenAt;
// 等整轮完成（停止按钮消失）
let doneAt = null;
for (let i = 0; i < 400; i++) {
  const streaming = await page.evaluate(() => !!document.querySelector('.send-btn.stop'));
  if (!streaming) { doneAt = Date.now() - t0; break; }
  await page.waitForTimeout(500);
}
R.totalMs = doneAt;
R.liveMid = await page.evaluate(() => ({ headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim() }));
R.live = await snap(page);
await page.screenshot({ path: path.join(OUT, 'live-after.png') });

// ---------- B. 刷新同一会话：看形态漂移 ----------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /目录|list_dir|数一数|根目录/.test(e.textContent))?.click(); });
await page.waitForTimeout(1500);
R.refreshed = await snap(page);
R.drift = {
  实时_入群条: R.live.joinMsgs, 刷新后_入群条: R.refreshed.joinMsgs,
  实时_成员发言: R.live.rows.flatMap((r) => r.members), 刷新后_成员发言: R.refreshed.rows.flatMap((r) => r.members),
  实时_工具卡: R.live.rows.flatMap((r) => r.tools), 刷新后_工具卡: R.refreshed.rows.flatMap((r) => r.tools),
  实时_空气泡: R.live.emptyBubbles, 刷新后_空气泡: R.refreshed.emptyBubbles,
  实时_会话头: R.live.headerSub, 刷新后_会话头: R.refreshed.headerSub,
  实时_用量行: R.live.rows.map((r) => r.usage).filter(Boolean), 刷新后_用量行: R.refreshed.rows.map((r) => r.usage).filter(Boolean),
  实时_消息行数: R.live.rows.length, 刷新后_消息行数: R.refreshed.rows.length,
};
await page.screenshot({ path: path.join(OUT, 'after-refresh.png') });

// ---------- C. 中途停止：语义与残留 ----------
await page.locator('textarea').first().click();
await page.locator('textarea').first().fill('再详细说说你在上一步里都做了什么，尽量长一点，分点讲。');
const t1 = Date.now();
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);
R.stopMidSnapshot = await snap(page);
await page.evaluate(() => document.querySelector('.send-btn.stop')?.click());
await page.waitForTimeout(2500);
R.afterStop = await snap(page);
R.afterStop.elapsedToStop = Date.now() - t1;
await page.screenshot({ path: path.join(OUT, 'after-stop.png') });

R.netErrors = net;

// ---------- 清理临时会话 ----------
await page.evaluate(async (id) => { await fetch(`/api/sessions/${id}`, { method: 'DELETE' }); }, sid);
await browser.close();
fs.writeFileSync(path.join(OUT, 'live.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify({ firstTokenMs: R.firstTokenMs, totalMs: R.totalMs, drift: R.drift, afterStop: { errorRows: R.afterStop.rows.filter((r) => r.kind === 'them').map((r) => ({ empty: r.empty, head: r.head, usage: r.usage })), banners: R.afterStop.banners, toasts: R.afterStop.toasts, sidebar: R.afterStop.sidebar, stopBtn: R.afterStop.stopBtn }, netErrors: R.netErrors }, null, 2));
