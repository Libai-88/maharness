// ui/diagnose-stop.mjs —— 零成本确定性复现「用户点停止」的前端语义（不花 token，本地挂起 SSE 服务）
// 原理：本地起一个"只发开头、永不结束"的 SSE 服务，把页面的 chat 请求改写过去，再点停止看界面留下什么。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { traceId: 'stop-probe' });
  let n = 0;
  const w = setInterval(() => {
    n++;
    if (n <= 6) send('delta', { text: `第${n}次心跳还在跑，` });
    else send('tool_start', { name: 'list_dir', args: { path: 'D:\\DEEPSEEK' } });
  }, 700);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 3000);
  res.on('close', () => { clearInterval(w); clearInterval(hb); });
});
await new Promise((r) => server.listen(3999, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/api/sessions/*/chat', (route) => route.continue({ url: 'http://127.0.0.1:3999/chat' }));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /你好呀|在吗/.test(e.textContent || ''))?.click(); });
await page.waitForTimeout(1200);

const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('随便说点什么');
await page.keyboard.press('Enter');
await page.waitForTimeout(2600);

const during = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.msg-row.them')].pop();
  return {
    stopBtn: !!document.querySelector('.send-btn.stop'),
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    typingBadge: (document.querySelector('.wx-typing')?.textContent || '').trim(),
    bubbleText: (row?.querySelector('.wx-bubble')?.textContent || '').trim().slice(0, 60),
    textareaDisabled: !!document.querySelector('textarea')?.disabled,
    toolCards: document.querySelectorAll('.tool-card').length,
  };
});

await page.evaluate(() => document.querySelector('.send-btn.stop')?.click());
await page.waitForTimeout(400);
const immediately = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.msg-row.them')].pop();
  return { rowText: (row?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160), emptyBubble: !(row?.querySelector('.wx-bubble')?.textContent || '').trim() };
});
await page.waitForTimeout(3000);
const after = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.msg-row.them')];
  const row = rows[rows.length - 1];
  const divs = row ? [...row.querySelectorAll('div')].map((d) => ({ cls: (d.getAttribute('class') || '').trim(), style: (d.getAttribute('style') || '').trim(), text: (d.textContent || '').trim().slice(0, 60) })) : [];
  return {
    lastRowDivs: divs,
    banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)),
    toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim().slice(0, 80)),
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    canSend: !!(document.querySelector('.send-btn') || document.querySelector('.emoji-btn')),
    composerState: document.querySelector('.composer-toolbar .comp-right')?.textContent?.trim().slice(0, 40),
    emptyBubbleCount: rows.filter((r) => !(r.querySelector('.wx-bubble')?.textContent || '').trim()).length,
    toolCards: document.querySelectorAll('.tool-card').length,
    runningTools: document.querySelectorAll('.tool-card.running').length,
  };
});

await page.screenshot({ path: path.join(OUT, 'stop-semantics.png') });
await browser.close();
server.close();
const out = { during, immediately, after };
fs.writeFileSync(path.join(OUT, 'stop.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
