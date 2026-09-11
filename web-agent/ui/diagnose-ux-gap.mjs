// ui/diagnose-ux-gap.mjs —— 「微信式体验」违和感实测：停止语义 / 刷新前后形态漂移 / 侧栏摘要 / 货币符号
// 用法：node diagnose-ux-gap.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.resolve('diag-out');
fs.mkdirSync(OUT, { recursive: true });
const R = {};

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
      head: txt.slice(0, 22),
      tools: r.querySelectorAll('.tool-card').length,
      memberSpeech: r.querySelectorAll('.wx-member-speech').length,
      think: r.querySelectorAll('.think-card').length,
      usageLine: (r.querySelector('.msg-extra:last-of-type')?.textContent || '').trim().slice(0, 60),
    };
  });
  return {
    rows,
    toolCards: document.querySelectorAll('.tool-card').length,
    memberSpeech: document.querySelectorAll('.wx-member-speech').length,
    joinMsgs: [...document.querySelectorAll('.wx-sys-msg')].filter((e) => /加入了群聊/.test(e.textContent || '')).map((e) => e.textContent.trim()),
    headerSub: (document.querySelector('.wx-header-sub')?.textContent || '').trim(),
    headerTitle: (document.querySelector('.wx-header-title')?.textContent || '').trim(),
    sidebarPreview: (document.querySelector('.sb-session-item.active .wx-sb-preview')?.textContent || '').trim(),
    sidebarTime: (document.querySelector('.sb-session-item.active .time')?.textContent || '').trim(),
    composerCost: (document.querySelector('.comp-cost')?.textContent || '').trim(),
    emptyBubbleCount: rows.filter((x) => x.empty).length,
  };
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

// ---------- 1. 「刷新前后形态漂移」：切到有工具调用的历史会话 → 快照 → 刷新 → 快照 ----------
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /你好呀/.test(e.textContent || ''))?.click(); });
await page.waitForTimeout(1500);
R.beforeReload = await snap(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => { [...document.querySelectorAll('.sb-session-item')].find((e) => /你好呀/.test(e.textContent || ''))?.click(); });
await page.waitForTimeout(1500);
R.afterReload = await snap(page);
R.drift = {
  工具卡数_实时vs刷新: [R.beforeReload.toolCards, R.afterReload.toolCards],
  群成员发言_实时vs刷新: [R.beforeReload.memberSpeech, R.afterReload.memberSpeech],
  入群系统条_实时vs刷新: [R.beforeReload.joinMsgs.length, R.afterReload.joinMsgs.length],
  会话头_实时vs刷新: [R.beforeReload.headerSub, R.afterReload.headerSub],
  空气泡数_实时vs刷新: [R.beforeReload.emptyBubbleCount, R.afterReload.emptyBubbleCount],
  消息行数_实时vs刷新: [R.beforeReload.rows.length, R.afterReload.rows.length],
};

// ---------- 2. 「点停止 → 显示连接中断」 ----------
await page.route('**/api/sessions/*/chat', async (route) => {
  const res = await new Promise((resolve) => {
    const chunks = [
      'event: start\ndata: {"traceId":"ux-t"}\n\n',
      'event: delta\ndata: {"text":"我帮你看看这个目录，先列一下文件。"}\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        // 保持挂起：模拟" agent 还在想/正在执行长任务"，由用户主动点停止
        const t = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(': ping\n\n')); } catch { clearInterval(t); } }, 1000);
        route._cleanup = () => clearInterval(t);
      },
    });
    resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  });
  await route.fulfill({ response: res });
});
const ta = page.locator('textarea').first();
await ta.click();
await ta.fill('测试一下停止语义');
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
R.duringStream = await snap(page);
R.stopBtnVisible = await page.locator('.send-btn.stop').count();
await page.locator('.send-btn.stop').first().click().catch(() => undefined);
await page.waitForTimeout(1800);
R.afterStop = await page.evaluate(() => ({
  bubbles: [...document.querySelectorAll('.msg-row.them .wx-bubble')].map((b) => b.textContent.trim().slice(0, 40)),
  errorText: (document.querySelector('.msg-row.them .assistant-text[style*="red"], .msg-row.them div[style*="--red"]')?.textContent || '').trim(),
  errorTexts: [...document.querySelectorAll('.msg-row.them')].map((r) => [...r.querySelectorAll('div')].filter((d) => /red|错误|中断|失败/.test(d.getAttribute('style') || '') + /连接中断/.test(d.textContent || '')).map((d) => d.textContent.trim().slice(0, 30))).flat(),
  inputDisabled: !!document.querySelector('textarea')?.disabled,
  stillStreaming: !!document.querySelector('.send-btn.stop'),
  banners: [...document.querySelectorAll('.sess-banner')].map((b) => b.textContent.trim().slice(0, 60)),
  toasts: [...document.querySelectorAll('.sonner-toast, [data-sonner-toast]')].map((t) => t.textContent.trim().slice(0, 60)),
}));

// ---------- 3. 侧栏摘要与时间文案（全量样本） ----------
R.sidebar = await page.evaluate(() => [...document.querySelectorAll('.sb-session-item')].map((e) => ({
  name: (e.querySelector('.name')?.textContent || '').trim(),
  preview: (e.querySelector('.wx-sb-preview')?.textContent || '').trim(),
  time: (e.querySelector('.time')?.textContent || '').trim(),
})));

// ---------- 4. 货币符号与"账单腔"清点 ----------
R.currency = await page.evaluate(() => {
  const t = document.body.innerText;
  const pick = (re) => (t.match(re) || []).slice(0, 6);
  return { yen: pick(/¥[0-9.]+/g), dollar: pick(/\$[0-9.]+/g), tokens: pick(/[↑↓][0-9]+ ?tokens?/g), usageLines: [...document.querySelectorAll('.msg-row .msg-extra')].map((e) => e.textContent.trim()).slice(0, 5) };
});

// ---------- 5. 删除确认走原生 confirm()？ ----------
R.nativeConfirm = await page.evaluate(() => {
  const src = [...document.querySelectorAll('.sb-session-item [aria-label="删除"]')].length;
  return { deleteButtonsInSidebar: src, note: '代码里用 window.confirm（见 Sidebar.tsx doBatchDelete / onDelete）' };
});

await browser.close();
fs.writeFileSync(path.join(OUT, 'ux-gap.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 2));
