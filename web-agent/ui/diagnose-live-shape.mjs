// ui/diagnose-live-shape.mjs —— 实时链路形态验收（零 token，脚本化 SSE）
// 验收"刷新前后一致"的另一半：实时路径必须产出与 replayMessages 相同的形状——
//   1) 中间轮的英文工作日志进"旁白"，不进正文气泡（旧版会先冒英文、再被 done 抽换）
//   2) 工具卡说人话（中文动作 + 剥掉 {ok,data} 信封）
//   3) 子代理 = 群成员：入群条 + 成员开口说答案（而不是念 JSON）
//   4) 不留空气泡
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

const FINAL = '我看了一下：目录里有 a、b 两个文件夹，另外小队数出 7 个 .md 文件。';
const NARRATION = 'We need to first list the files before answering the user.';
const MEMBER_JSON = '{"ok":true,"data":{"answer":"一共 7 个 .md 文件"}}';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  (async () => {
    send('start', { traceId: 'live-shape' });
    await new Promise((r) => setTimeout(r, 120));
    send('delta', { text: NARRATION });
    await new Promise((r) => setTimeout(r, 120));
    // 第一次工具：普通工具卡
    send('tool_start', { id: 'call_1', name: 'list_dir', args: { path: 'D:\\DEEPSEEK' } });
    await new Promise((r) => setTimeout(r, 120));
    send('tool_result', { id: 'call_1', name: 'list_dir', summary: '{"ok":true,"data":{"entries":["a","b"]}}', ok: true, stored: false });
    await new Promise((r) => setTimeout(r, 120));
    // 第二次：子代理（群成员）
    send('delta', { text: 'Now I will ask a helper to count the markdown files.' });
    await new Promise((r) => setTimeout(r, 120));
    send('tool_start', { id: 'call_2', name: 'run_subagent', args: { objective: '数一数 .md 文件' } });
    await new Promise((r) => setTimeout(r, 120));
    send('tool_result', { id: 'call_2', name: 'run_subagent', summary: MEMBER_JSON, ok: true, stored: false });
    await new Promise((r) => setTimeout(r, 120));
    send('delta', { text: FINAL });
    await new Promise((r) => setTimeout(r, 120));
    send('done', { content: FINAL, reasoning: '先把目录列出来，再让帮手数文件。', usage: { input: 120, output: 40 }, cost: 0.00021, cached: false });
    send('end', {});
    res.end();
  })();
});
await new Promise((r) => server.listen(4020, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/api/sessions/*/chat', (route) => route.continue({ url: 'http://127.0.0.1:4020/chat' }));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('看看这个目录，再帮我数一下 md 文件');
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);

const s = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.messages-inner .msg-row')];
  const them = rows.filter((r) => !r.classList.contains('me') && !r.classList.contains('sys'));
  return {
    body: (document.querySelector('[data-testid=msg-bubble-assistant]')?.textContent || '').trim(),
    bodyHasEnglish: /We need to|Now I will/i.test(document.querySelector('[data-testid=msg-bubble-assistant]')?.textContent || ''),
    narration: [...document.querySelectorAll('.wx-narration .wn-body p')].map((p) => p.textContent.trim()),
    narrationSummary: (document.querySelector('.wx-narration > summary')?.textContent || '').trim(),
    toolCards: [...document.querySelectorAll('.tool-card')].map((t) => ({ name: (t.querySelector('.tool-name')?.textContent || '').trim(), raw: t.querySelector('.tool-name')?.getAttribute('title'), said: (t.querySelector('.t-out')?.textContent || '').trim(), jsonLeak: /^\{/.test((t.querySelector('.t-out')?.textContent || '').trim()) })),
    memberBubbles: [...document.querySelectorAll('.wx-member-speech')].map((m) => ({ name: (m.querySelector('.wx-member-name')?.textContent || '').trim(), text: (m.querySelector('.wx-member-text')?.textContent || '').trim() })),
    joinRows: [...document.querySelectorAll('.wx-sys-msg.join')].map((e) => e.textContent.trim()),
    emptyBubbles: them.filter((r) => !(r.querySelector('.wx-bubble')?.textContent || '').trim()).length,
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    costChip: [...document.querySelectorAll('.ma-cost')].map((e) => e.getAttribute('title')),
    streamingLeft: !!document.querySelector('.send-btn.stop'),
  };
});

check('正文只有最终答复（英文工作日志不再混进气泡）', s.body === FINAL && !s.bodyHasEnglish, { body: s.body.slice(0, 40), english: s.bodyHasEnglish });
check('中间轮的话进了"旁白"（可展开、不抢正文）', s.narration.length === 2 && s.narration[0].startsWith('We need'), { narration: s.narration, summary: s.narrationSummary });
check('工具卡说人话（中文动作 + 剥掉 JSON 信封）', s.toolCards.some((t) => t.name === '看一眼目录' && t.raw === 'list_dir' && t.said === '看一眼目录：办好了' && !t.jsonLeak), s.toolCards);
check('子代理 = 群成员：入群条出现一次', s.joinRows.length === 1 && /加入了群聊/.test(s.joinRows[0]), s.joinRows);
check('群成员开口说答案（不是 JSON）', s.memberBubbles.length === 1 && s.memberBubbles[0].text === '一共 7 个 .md 文件', s.memberBubbles);
check('没有空气泡', s.emptyBubbles === 0, { emptyBubbles: s.emptyBubbles });
check('群聊态出现在会话头', /群聊/.test(s.headerSub), { headerSub: s.headerSub });
check('流式结束后按钮回到可发状态', s.streamingLeft === false, {});
check('花费信息只出现在悬停 chip 上', s.costChip.length === 1 && /花费 \$0\.0002/.test(s.costChip[0] || ''), s.costChip);

await page.screenshot({ path: path.join(OUT, 'live-shape.png') });
await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'live-shape.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
