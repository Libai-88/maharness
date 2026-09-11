// ui/diagnose-stop-server.mjs —— 「停止」的服务端语义端到端验证（会真实调用 1–2 次廉价模型）
// 验证点（对应 core/chat/agent.ts 的 abort 短路）：
//   1) 停下后立刻还能继续发消息 —— 会话互斥锁已释放（旧版会挂到 10 分钟审批超时/整条 failover 跑完 → 409）
//   2) 停下不产生「密钥失效」等 provider 故障横幅（旧版把用户取消记成 provider 失败）
//   3) 停下后剩余工具不再执行（工具卡数量冻结）
//   4) 已经做过的部分留下断点 → 出现「接着说」入口
// 结束后删除临时会话，不污染真实数据。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const netErrors = [];
page.on('response', (r) => { if (r.url().includes('/api/sessions/') && r.url().includes('/chat') && r.status() >= 400) netErrors.push(`${r.status()}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);

const sid = await page.evaluate(async () => {
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash-vision-exp' }) });
  return (await r.json()).id;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /新会话/.test(e.textContent))?.click(); });
await page.waitForTimeout(1200);

const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('请先调用 list_dir 看一下 D:\\DEEPSEEK 里有什么，然后一段一段、慢慢地详细讲给我听，尽量长。');
await page.keyboard.press('Enter');

// 等到第一个工具卡出现（说明已经进入"办事"阶段，后面是长正文）
let sawTool = false;
for (let i = 0; i < 90; i++) {
  sawTool = await page.evaluate(() => document.querySelectorAll('.tool-card').length > 0);
  if (sawTool) break;
  await page.waitForTimeout(500);
}
check('触发了一次工具调用（进入长回答阶段）', sawTool, {});
await page.waitForTimeout(2500);
const toolCardsAtStop = await page.evaluate(() => document.querySelectorAll('.tool-card').length);

// 点「停下」
const hadStop = await page.evaluate(() => !!document.querySelector('.send-btn.stop'));
await page.evaluate(() => document.querySelector('.send-btn.stop')?.click());
check('流式中出现「停下」按钮', hadStop, {});
const t0 = Date.now();
await page.waitForTimeout(1800);
const afterStop = await page.evaluate(() => ({
  stoppedRows: [...document.querySelectorAll('.wx-stopped')].map((e) => e.textContent.trim().slice(0, 20)),
  redRows: [...document.querySelectorAll('.wx-failure')].map((e) => e.textContent.trim().slice(0, 24)),
  authBanner: document.querySelectorAll('.sess-banner.auth').length,
  banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)),
  toolCards: document.querySelectorAll('.tool-card').length,
  bodyHasConnErr: document.body.innerText.includes('连接中断'),
}));
check('停下后没有红色报错、也没有"连接中断"', afterStop.redRows.length === 0 && !afterStop.bodyHasConnErr, afterStop);
// 注意：这条只做记录、不做判定——主线路 deepseek 的密钥当前本身在 403，
// 横幅可能因此出现，与"停止"无关。严格判定见 diagnose-stop-health.mjs
// （换一条正常线路，只做"发消息 → 中途停下"，断言 health 完全不受影响）。
console.log(`[info] 停下的 provider 健康与横幅：authBanner=${afterStop.authBanner} banners=${JSON.stringify(afterStop.banners)}`);
check('停下后不再执行剩余工具（工具卡数量冻结）', afterStop.toolCards === toolCardsAtStop, { atStop: toolCardsAtStop, after: afterStop.toolCards });

// 关键：立刻再发一条 —— 旧版会撞 409「该会话有任务进行中」（锁被挂住的 run 占着）
await ta.click();
await ta.fill('只说两个字：收到');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const second = await page.evaluate(() => ({
  busyRows: [...document.querySelectorAll('.wx-failure, .wx-stopped')].map((e) => e.textContent.trim().slice(0, 30)),
  streaming: !!document.querySelector('.send-btn.stop'),
  lastThem: [...document.querySelectorAll('.msg-row.them .wx-bubble')].pop()?.textContent?.trim().slice(0, 40) || '',
}));
check('停下后立刻能继续对话（互斥锁已释放，未撞 409）', netErrors.filter((s) => s === '409').length === 0, { netErrors, second });
check('第二条消息被正常处理（有回复或仍在流式中）', second.streaming || second.lastThem.length > 0, second);

// 断点：停下时若工具轮已完成 → 出现「接着说」
await page.waitForTimeout(1500);
const cp = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/checkpoint`)).json()), sid);
check('被停下后保留断点（可「接着说」）', cp.exists === true, cp);

await page.screenshot({ path: path.join(OUT, 'stop-server.png') });
await page.evaluate(async (id) => { await fetch(`/api/sessions/${id}`, { method: 'DELETE' }); }, sid);
await browser.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'stop-server.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
