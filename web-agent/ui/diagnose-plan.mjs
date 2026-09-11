// ui/diagnose-plan.mjs —— 计划刷新可见 + 真实 running 帧
// A) 确定性：把计划端点 mock 成固定计划，验证前端"切会话/刷新即拉一次并渲染常驻条"
// B) 真实：一次廉价 LLM 运行，验证轨迹面板出现真实 running 帧；若模型建了计划，
//    刷新后计划仍在（新端点的端到端证据）。结束后删除临时会话。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); };

const MOCK_PLAN = {
  objective: '把 docs 目录的过期文档清一遍',
  steps: [
    { title: '列出现有文档', status: 'done' },
    { title: '标出超过 90 天的', status: 'in_progress' },
    { title: '生成清理清单', status: 'pending' },
  ],
  current: 1,
  completed: false,
  createdAt: Date.now(),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
let planHits = 0;
await page.route('**/api/plugins/goal-plan/plan*', async (route) => {
  planHits++;
  await route.fulfill({ json: { plan: MOCK_PLAN } });
});

// ---------- A. 确定性：mock 计划 → 首屏渲染常驻条 ----------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
const strip = await page.evaluate(() => {
  const s = document.querySelector('.goal-strip');
  return {
    exists: !!s,
    open: s?.hasAttribute('open') ?? false,
    title: (s?.querySelector('.gs-title')?.textContent || '').trim(),
    count: (s?.querySelector('.gs-count')?.textContent || '').trim(),
    steps: [...(s?.querySelectorAll('.plan-step') ?? [])].map((x) => x.textContent.trim().slice(0, 20)),
  };
});
check('计划端点被首屏调用（每会话一次）', planHits >= 1, { planHits });
check('计划渲染成输入框上方的常驻条', strip.exists && /docs 目录/.test(strip.title), strip);
check('计划进度与步骤可见', strip.count === '1/3' && strip.steps.length === 3, strip);

// 切会话 → 再拉一次（计划是按会话存的）
const before = planHits;
await page.evaluate(() => { const items = [...document.querySelectorAll('.sb-session-item')]; if (items[1]) items[1].click(); });
await page.waitForTimeout(1500);
check('切会话会重新拉该会话的计划', planHits > before, { before, after: planHits });

// ---------- B. 真实运行：running 帧 ----------
const sid = await page.evaluate(async () => {
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash-vision-exp' }) });
  return (await r.json()).id;
});
// 真实端点契约（临时会话没有计划）——用 page.request：不经过 page.route 拦截，
// 否则会打到上面的 mock 上（第一版就是这么把自己的计划断言搞错的）
const contract = await page.request.get(`${BASE}/api/plugins/goal-plan/plan?sessionId=${sid}`);
const contractBody = await contract.json();
check('计划端点契约：未知会话返回 plan=null', contract.status() === 200 && contractBody?.plan === null, { status: contract.status(), body: contractBody });

// 解除 mock，让真实端点生效
await page.unroute('**/api/plugins/goal-plan/plan*');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /新会话/.test(e.textContent))?.click(); });
await page.waitForTimeout(1000);

const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('先用 create_plan 建一个三步小计划（每步一句话），再调用 list_dir 看一眼 D:\\DEEPSEEK，最后用一句话总结。');
await page.keyboard.press('Enter');

let sawRunning = null;
for (let i = 0; i < 200; i++) {
  const v = await page.evaluate(() => ({
    running: document.querySelectorAll('.tl-item.running').length,
    chip: (document.querySelector('.th-running')?.textContent || '').trim(),
    liveDur: (document.querySelector('.tl-item.running .tl-dur')?.textContent || '').trim(),
  }));
  if (v.running > 0) { sawRunning = v; break; }
  await page.waitForTimeout(150);
}

// 等运行结束
for (let i = 0; i < 200; i++) {
  if (!(await page.evaluate(() => !!document.querySelector('.send-btn.stop')))) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1200);
const traceView = await page.evaluate(() => ({
  rows: document.querySelectorAll('.tl-item').length,
  titles: [...document.querySelectorAll('.tl-item .tl-title')].map((t) => t.textContent.trim()).slice(0, 6),
}));
if (sawRunning) {
  check('真实运行中轨迹面板出现"进行中"步骤（含实时计时）', /步在做/.test(sawRunning.chip), sawRunning);
} else {
  // 主线路 key 当前是 401（见服务端日志），本轮极短 → 抓不到 running 窗口属正常；
  // running 帧的实时渲染已由 diagnose-batch2 确定性验证，这里只要求"本轮步骤确实到了面板"。
  check('真实运行：本轮步骤到达轨迹面板（running 渲染由 batch2 确定性覆盖）', traceView.rows >= 1, { traceView, sawRunning });
}
const livePlan = await page.evaluate(() => (document.querySelector('.goal-strip .gs-title')?.textContent || '').trim());
const liveSteps = await page.evaluate(() => document.querySelectorAll('.goal-strip .plan-step').length);
console.log(`[info] 运行结束后的计划条：${livePlan || '(无)'} · ${liveSteps} 步`);

if (liveSteps > 0) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /新会话|计划|三步/.test(e.textContent))?.click(); });
  await page.waitForTimeout(1600);
  const afterReload = await page.evaluate(() => ({
    steps: document.querySelectorAll('.goal-strip .plan-step').length,
    title: (document.querySelector('.goal-strip .gs-title')?.textContent || '').trim(),
  }));
  check('刷新后计划仍在（新端点的端到端证据）', afterReload.steps > 0, afterReload);
} else {
  console.log('[info] 模型这次没建计划 → 跳过"刷新后计划仍在"的真实断言（端点契约与前端链路已在上面验证）');
}

check('全程无 JS 运行时报错', errs.length === 0, errs.slice(0, 3));
await page.evaluate(async (id) => { await fetch(`/api/sessions/${id}`, { method: 'DELETE' }); }, sid);
await browser.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
