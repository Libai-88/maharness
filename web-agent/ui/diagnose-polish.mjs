// ui/diagnose-polish.mjs —— 「像跟朋友聊天」改造的验收探针（零 token：全部走本地挂起 SSE + 既有历史）
// 断言四件事：
//   1) 刷新前后形态一致（空气泡消失 / 工具卡跨刷新存活 / 群成员不再散伙）
//   2) 用户点「停下」→ 温和的话，而不是红字「连接中断」
//   3) 侧栏是"最后一句话"的摘要 + 微信式时间；不再有 ¥/$ 混用与双份"正在输入"
//   4) 删除确认走应用内弹层（不再弹原生 confirm）
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

// 本地挂起 SSE：让"停止"可被确定性触发（不依赖真实模型）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { traceId: 'polish-probe' });
  let n = 0;
  const w = setInterval(() => { n++; if (n <= 8) send('delta', { text: `还在说第${n}句，` }); }, 600);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 3000);
  res.on('close', () => { clearInterval(w); clearInterval(hb); });
});
await new Promise((r) => server.listen(4010, '127.0.0.1', r));

const snap = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.messages-inner .msg-row')];
  const them = rows.filter((r) => !r.classList.contains('me') && !r.classList.contains('sys'));
  const bubbleText = (r) => (r.querySelector('.wx-bubble')?.textContent || '').trim();
  return {
    emptyBubbles: them.filter((r) => !bubbleText(r)).length,
    toolCards: [...document.querySelectorAll('.tool-card')].map((t) => ({
      name: (t.querySelector('.tool-name')?.textContent || '').trim(),
      raw: t.querySelector('.tool-name')?.getAttribute('title') || '',
      status: (t.querySelector('.tool-status')?.textContent || '').trim(),
      said: (t.querySelector('.t-out')?.textContent || '').trim().slice(0, 40),
    })),
    narration: document.querySelectorAll('.wx-narration').length,
    memberSpeech: document.querySelectorAll('.wx-member-speech').length,
    joinRows: [...document.querySelectorAll('.wx-sys-msg.join')].map((e) => e.textContent.trim()),
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    headerOffline: !!document.querySelector('.wx-header-sub.off'),
    typingInHeader: (document.querySelector('.wx-header-sub')?.textContent || '').includes('正在输入'),
    typingInMeta: document.querySelectorAll('.msg-meta .wx-typing').length,
    activePreview: (document.querySelector('.sb-session-item.active .wx-sb-preview')?.textContent || '').trim(),
    sidebarTime: (document.querySelector('.sb-session-item .time')?.textContent || '').trim(),
    costChips: [...document.querySelectorAll('.ma-cost')].map((e) => ({ text: e.textContent.trim(), title: e.getAttribute('title') })),
    yen: (document.body.innerText.match(/¥[0-9.]+/g) || []).slice(0, 3),
    goalStrip: document.querySelectorAll('.goal-strip').length,
    redErrorRow: [...document.querySelectorAll('.wx-failure')].map((e) => e.textContent.trim().slice(0, 30)),
    stoppedRow: [...document.querySelectorAll('.wx-stopped')].map((e) => e.textContent.trim().slice(0, 30)),
    banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 50)),
    msgRowCount: rows.length,
  };
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.type()); await d.dismiss(); });
await page.route('**/api/sessions/*/chat', (route) => route.continue({ url: 'http://127.0.0.1:4010/chat' }));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// ---------- 1. 历史会话（含工具调用）刷新前后一致 ----------
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /你好呀/.test(e.textContent || ''))?.click(); });
await page.waitForTimeout(1500);
const before = await snap(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /你好呀/.test(e.textContent || ''))?.click(); });
await page.waitForTimeout(1500);
const after = await snap(page);
const same = JSON.stringify(before) === JSON.stringify(after);
check('刷新前后界面完全一致（无形态漂移）', same, same ? 'identical' : { before, after });
check('历史里的"空气泡"已消失', after.emptyBubbles === 0, { emptyBubbles: after.emptyBubbles });
check('工具卡跨刷新存活且说人话', after.toolCards.length > 0 && after.toolCards.every((t) => t.name && !/^[a-z_]+$/.test(t.name) && t.said && !t.said.startsWith('{')), after.toolCards);
check('单条花费不再糊在脸上（只在悬停 chip 里）', after.costChips.length > 0 && after.costChips.every((c) => /\$/.test(c.title || '')), after.costChips);
check('全站无 ¥/$ 混用（只剩 $）', after.yen.length === 0, { yen: after.yen });
check('侧栏摘要 = 最后一句话（不再是「私聊」）', after.activePreview.length > 0 && after.activePreview !== '私聊', after.activePreview);

// ---------- 2. 点「停下」的语义 ----------
const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('随便聊两句看看');
await page.keyboard.press('Enter');
await page.waitForTimeout(2600);
const mid = await snap(page);
check('流式期间会话头只说一次"正在输入"', mid.typingInHeader && mid.typingInMeta === 0, { header: mid.typingInHeader, meta: mid.typingInMeta });
await page.evaluate(() => document.querySelector('.send-btn.stop')?.click());
await page.waitForTimeout(2500);
const stopped = await snap(page);
check('停下后留一句温和的话（而非红色报错）', stopped.stoppedRow.length > 0 && stopped.redErrorRow.length === 0, { stoppedRow: stopped.stoppedRow, red: stopped.redErrorRow });
check('停下后输入区可继续使用', await page.evaluate(() => !document.querySelector('textarea')?.disabled && !!document.querySelector('.send-btn, .emoji-btn')), {});
check('停下不产生"连接中断"这类技术文案', !(await page.evaluate(() => document.body.innerText.includes('连接中断'))), {});

// ---------- 3. 删除确认走应用内弹层 ----------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.locator('.sb-session-item').first().hover();
await page.waitForTimeout(300);
await page.locator('.sb-session-item').first().locator('[aria-label="删除"]').click();
await page.waitForTimeout(500);
check('删除确认是应用内弹层（未触发原生 confirm）', dialogs.length === 0 && (await page.locator('.cf-box').count()) === 1, { dialogs, box: await page.locator('.cf-box').count() });
await page.locator('.cf-cancel').click();
await page.waitForTimeout(900);
check('取消后弹层关闭且会话仍在', (await page.locator('.cf-box').count()) === 0 && (await page.locator('.sb-session-item').count()) > 0, { box: await page.locator('.cf-box').count(), sessions: await page.locator('.sb-session-item').count() });

await page.screenshot({ path: path.join(OUT, 'polish-after.png') });
await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'polish.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
