// ui/diagnose-batch2.mjs —— 第二批改动的验收（零 token：本地脚本化 SSE 同时驱动 chat 与 events 两条流）
// 验收点：
//   1) 轨迹面板出现"进行中"步骤（running 帧），且 settle 帧原地覆盖（不重复堆两条）
//   2) parallel.progress 进入白名单并渲染成"小队进度"（1/3 交回 · 正在做：…）
//   3) 审批：GET /api/approvals 契约可用；approval.requested 帧（含 sessionId/expiresAt）
//      让审批卡带"等了 N 秒 · 还剩 N 分钟"出现（= 刷新回放机制的前端那一半）
//   4) 断线可见：events 连接断开后会话头改说人话（而不是"实时"灯常亮）
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

// 应用会自动选中会话列表的第一条：审批/进度事件必须挂到它身上才会显示在当前窗口
const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
const activeSession = sessions[0]?.id;
if (!activeSession) { console.error('没有可用会话'); process.exit(1); }

const NUM = 4040;
let eventsRes = null;
const sseFrames = (res, type, data, traceId) => {
  try { res.write(`event: event\ndata: ${JSON.stringify({ type, traceId, data, ts: Date.now() })}\n\n`); } catch { /* closed */ }
};
const chatFrames = (res, ev, data) => {
  try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
};

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    eventsRes = res;
    req.on('close', () => { if (eventsRes === res) eventsRes = null; });
    return;
  }
  // ---- /chat：一次"带小队 + 长回答"的脚本化 run（永不自己结束，由测试推进） ----
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (ev, data) => chatFrames(res, ev, data);
  send('start', { traceId: 'mock-trace' });
  await new Promise((r) => setTimeout(r, 150));
  send('delta', { text: 'Let me look at the directory first.' });
  await new Promise((r) => setTimeout(r, 150));
  send('tool_start', { id: 'c1', name: 'list_dir', args: { path: 'D:\\DEEPSEEK' } });
  await new Promise((r) => setTimeout(r, 150));
  send('tool_result', { id: 'c1', name: 'list_dir', summary: '{"ok":true,"data":{"entries":["a","b"]}}', ok: true });
  await new Promise((r) => setTimeout(r, 150));
  // 小队：保持 running（进度由 /events 推送）
  send('tool_start', { id: 'c2', name: 'run_parallel', args: { tasks: [{ objective: '查主题甲' }, { objective: '查主题乙' }, { objective: '查主题丙' }] } });
  globalThis.__chatRes = res;
});
await new Promise((r) => server.listen(NUM, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
await page.route('**/api/sessions/*/chat', (route) => route.continue({ url: `http://127.0.0.1:${NUM}/chat` }));
await page.route('**/api/events', (route) => route.continue({ url: `http://127.0.0.1:${NUM}/events` }));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// ---------- 3a. GET /api/approvals 契约 ----------
const ap = await page.evaluate(async () => {
  const r = await fetch('/api/approvals');
  return { status: r.status, body: await r.json() };
});
check('GET /api/approvals 可用（返回 pending 数组）', ap.status === 200 && Array.isArray(ap.body?.pending), ap);

// ---------- 发一条消息，让脚本化 run 起来 ----------
const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('帮我分头查三个主题');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);

// ---------- 1. 轨迹：running 帧 → 面板出现"进行中"；settle 帧原地覆盖 ----------
for (let i = 0; i < 20 && !eventsRes; i++) await page.waitForTimeout(100);
eventsRes && sseFrames(eventsRes, 'trace.step', { id: 'T1', traceId: 'mock-trace', turn: 0, type: 'tool_call', name: 'list_dir', status: 'running', ts: Date.now() }, 'mock-trace');
await page.waitForTimeout(500);
const runningView = await page.evaluate(() => ({
  runningRows: document.querySelectorAll('.tl-item.running').length,
  headerChip: (document.querySelector('.th-running')?.textContent || '').trim(),
  liveDots: document.querySelectorAll('.tl-live').length,
  title: (document.querySelector('.tl-item .tl-title')?.textContent || '').trim(),
}));
check('轨迹面板出现"进行中"步骤（running 帧生效）', runningView.runningRows === 1 && runningView.liveDots === 1 && /步在做/.test(runningView.headerChip), runningView);
check('工具步骤显示中文动作（不是函数名）', runningView.title === '看一眼目录', runningView);

sseFrames(eventsRes, 'trace.step', { id: 'T1', traceId: 'mock-trace', turn: 0, type: 'tool_call', name: 'list_dir', status: 'done', ts: Date.now() - 900, durationMs: 900, outputSummary: '2 个条目', endTs: Date.now() }, 'mock-trace');
await page.waitForTimeout(500);
const settledView = await page.evaluate(() => ({
  rows: document.querySelectorAll('.tl-item').length,
  runningRows: document.querySelectorAll('.tl-item.running').length,
  headerChip: document.querySelectorAll('.th-running').length,
  body: (document.querySelector('.tl-item .tl-body')?.textContent || '').trim(),
}));
check('settle 帧原地覆盖（同一 step 不堆两条）', settledView.rows === 1 && settledView.runningRows === 0 && settledView.headerChip === 0, settledView);
check('settle 帧带回结果摘要', /2 个条目/.test(settledView.body), settledView);

// ---------- 2. 小队进度 ----------
sseFrames(eventsRes, 'parallel.progress', { phase: 'start', taskId: 'p1', objective: '查主题甲', sessionId: activeSession, total: 3, index: 0 });
sseFrames(eventsRes, 'parallel.progress', { phase: 'start', taskId: 'p2', objective: '查主题乙', sessionId: activeSession, total: 3, index: 1 });
sseFrames(eventsRes, 'parallel.progress', { phase: 'done', taskId: 'p1', objective: '查主题甲', sessionId: activeSession, total: 3, index: 0 });
await page.waitForTimeout(700);
const squadView = await page.evaluate(() => ({
  progress: (document.querySelector('.wx-member-progress .wmp-text')?.textContent || '').trim(),
  barWidth: document.querySelector('.wx-member-progress .wmp-track i')?.style?.width || '',
  memberName: (document.querySelector('.wx-member-speech .wx-member-name')?.textContent || '').trim(),
}));
check('小队进度渲染（几路交回 + 正在做哪一路）', /1\/3 交回/.test(squadView.progress) && /正在做：查主题乙/.test(squadView.progress), squadView);
check('进度条宽度按比例（1/3）', squadView.barWidth === '33%', squadView);
check('成员气泡是"并行小队"', /小队/.test(squadView.memberName), squadView);

// ---------- 3b. 审批回放（含等待时长） ----------
const expiresAt = Date.now() + 8 * 60_000;
sseFrames(eventsRes, 'approval.requested', { approvalId: 'ap-1', name: 'write_file', summary: '要往 D:\\DEEPSEEK\\note.md 写一点东西', sessionId: activeSession, createdAt: Date.now() - 65_000, expiresAt });
await page.waitForTimeout(700);
const apView = await page.evaluate(() => ({
  cards: document.querySelectorAll('.approval-card').length,
  title: (document.querySelector('.approval-card .a-title')?.textContent || '').replace(/\s+/g, ' ').trim(),
  wait: (document.querySelector('.approval-card .a-wait')?.textContent || '').trim(),
  okBtn: (document.querySelector('.approval-card .btn-primary')?.textContent || '').trim(),
}));
check('审批卡按会话回到当前窗口（刷新回放机制的前端那一半）', apView.cards === 1, apView);
check('审批卡说人话（谁想干什么 + 等了多久/还剩多久）', /小马想请你点头/.test(apView.title) && /等了 1 分钟/.test(apView.wait) && /还剩/.test(apView.wait), apView);
check('审批动作是人话按钮', apView.okBtn.includes('可以，去做吧'), apView);

// ---------- 4. 断线可见 ----------
eventsRes?.end();
await page.waitForTimeout(900);
const offline = await page.evaluate(() => ({
  header: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
  isOff: !!document.querySelector('.wx-header-sub.off'),
}));
check('events 断开后界面改说人话（不再假装实时）', offline.isOff && /重连|连线/.test(offline.header), offline);

check('全程无 JS 运行时报错', errs.length === 0, errs.slice(0, 3));

await page.screenshot({ path: path.join(OUT, 'batch2.png') });
await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'batch2.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
