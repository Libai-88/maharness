// ui/e2e/main-flows.spec.ts —— 三条主流程的端到端契约（UX-01）
// 短问答 / 文件任务 / 长任务（含取消与恢复入口）：断言页面终态与服务端 SSE 终态一致，
// 无悬空 streaming 状态（输入区复位、无残留流式光标）。
import { expect, test, type Page } from '@playwright/test';

const INPUT_PLACEHOLDER = '跟小鲸说点什么…（按 / 看命令）';

async function setup(page: Page) {
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
  await page.route('**/api/events', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: '' }));
  await page.route('**/api/trace/stats', (route) => route.fulfill({ json: { trace: {}, cache: {}, l1Enabled: false } }));
  await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({ json: { exists: false, turn: 0, historyMessages: 0, createdAt: 0 } }));
  await page.goto('/');
  await expect
    .poll(async () => {
      const bubbles = await page.getByTestId('msg-bubble-assistant').or(page.getByTestId('msg-bubble-user')).count();
      const hasHero = await page.locator('.brand-hero').count();
      return bubbles + hasHero;
    })
    .toBeGreaterThan(0);
}

function sseBody(lines: string[]): string {
  return lines.join('\n');
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(INPUT_PLACEHOLDER).fill(text);
  await page.keyboard.press('Enter');
}

/** 终态一致性断言：气泡含最终内容、无残留流式光标、发送按钮已复位 */
async function expectSettled(page: Page, content: string) {
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText(content);
  await expect(page.locator('.stream-cursor')).toHaveCount(0);
  await expect(page.getByTestId('send-btn')).toBeVisible();
}

test.describe('三条主流程（UX-01）', () => {
  test('短问答：纯文本问答，页面终态与 done 帧一致', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"flow-qa"}',
        '',
        'event: delta',
        'data: {"text":"北京今天是晴天。"}',
        '',
        'event: done',
        'data: {"content":"北京今天是晴天。","usage":{"input":6,"output":3},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '北京天气怎么样');
    await expectSettled(page, '北京今天是晴天。');
  });

  test('文件任务：工具卡随 tool_result 定格，最终答复与 done 帧一致', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"flow-file"}',
        '',
        'event: tool_start',
        'data: {"id":"ft-1","name":"read_file","args":{"path":"notes.md"}}',
        '',
        'event: tool_result',
        'data: {"id":"ft-1","name":"read_file","summary":"读取 notes.md（1.2KB）","ok":true}',
        '',
        'event: done',
        'data: {"content":"已读完 notes.md，共 3 条要点。","usage":{"input":40,"output":18},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '帮我读一下 notes.md');
    const toolCard = page.locator('.tool-card, [class*="tool"]').filter({ hasText: '读一个文件' }).first();
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('已读完 notes.md，共 3 条要点。');
    // 工具卡终态：完成状态，非 running
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toBeVisible();
    await expect(toolCard).toBeVisible();
  });

  test('长任务：错误终态同步为页面失败状态，无无限 loading', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"flow-long"}',
        '',
        'event: delta',
        'data: {"text":"前半部分已完成…"}',
        '',
        'event: error',
        'data: {"error":"本任务已达到轮数上限","kind":"max-turns"}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '执行一个多阶段任务');
    // 服务端 kind=max-turns → humanize 文案；原始错误保留在 title（页面终态与 SSE 终态一致映射）
    const failure = page.locator('.wx-failure').last();
    await expect(failure).toContainText('这个任务有点大');
    await expect(failure).toHaveAttribute('title', /本任务已达到轮数上限/);
    // 失败前内容保留可见 + 流式复位（无残留光标，发送可用）
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('前半部分已完成…');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toBeVisible();
  });

  test('长任务取消：2 秒内出现停止终态与恢复入口', async ({ page }) => {
    test.setTimeout(30_000);
    // fetch mock：发出 start+delta 后保持流打开，客户端 abort 信号到达时关闭——
    // 模拟「任务还在跑」而非「流提前断掉」，停止路径才能走 aborted 语义
    await page.addInitScript(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/chat')) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode('event: start\ndata: {"traceId":"flow-cancel"}\n\nevent: delta\ndata: {"text":"长任务进行中…"}\n\n'));
              const signal = (init as RequestInit | undefined)?.signal;
              if (signal) signal.addEventListener('abort', () => { try { controller.close(); } catch { /* 已关闭 */ } }, { once: true });
            },
          });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return orig(input, init);
      };
    });
    await setup(page);
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({
      json: { exists: true, turn: 1, historyMessages: 4, createdAt: Date.now() },
    }));
    await send(page, '跑一个长任务');
    const stopBtn = page.getByRole('button', { name: '停止' });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click({ force: true });
    const startedAt = Date.now();
    // 用户停止：温和的停止文案（不报红错）+ 断点恢复入口立即出现
    await expect(page.locator('.wx-stopped')).toContainText('你打断了');
    await expect(page.locator('.sess-banner.resume')).toContainText('上次做到第 2 轮停下了');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

test.describe('全流程状态链（UX-02）', () => {
  test('目标条 → 审批 → 结果 → 阻塞 → 恢复入口的完整链路', async ({ page }) => {
    // 服务端状态自给自足：计划、审批清单、断点均由 route mock 承载（SSE 事件驱动 UI 状态）
    let turn = 0;
    await page.route('**/api/plugins/goal-plan/plan*', (route) => route.fulfill({
      json: { plan: {
        objective: '整理季度报告并交付',
        steps: [
          { title: '读取数据源', status: 'done' },
          { title: '生成报告草稿', status: 'in_progress' },
          { title: '交付确认', status: 'todo' },
        ],
        current: 1, completed: false, createdAt: Date.now(),
      } },
    }));
    await page.route('**/api/approvals**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { pending: [] } });
    });
    await setup(page);
    // checkpoint 路由必须在 setup 之后注册（Playwright 后注册的路由优先，
    // setup 里注册了 exists:false 的兜底）
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({
      json: { exists: turn > 0, turn, historyMessages: turn * 3, createdAt: Date.now() },
    }));
    // 第一轮：审批挂起 → 批准 → 完成（结果终态）
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux02-run"}',
        '',
        'event: tool_start',
        'data: {"id":"ap-1","name":"write_file","args":{"path":"report.md"}}',
        '',
        'event: approval_required',
        'data: {"approvalId":"ux02-ap-1","name":"write_file","summary":"写入文件需要审批","approvalToken":"tok-ux02-1"}',
        '',
        'event: tool_result',
        'data: {"id":"ap-1","name":"write_file","summary":"已写入 report.md","ok":true}',
        '',
        'event: done',
        'data: {"content":"报告已生成交付。","usage":{"input":50,"output":20},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '整理季度报告');

    // 目标条：plan.updated 广播或 planApi 轮询 — 直接断言既有 plan 加载渲染
    const goalStrip = page.locator('.goal-strip');
    await expect(goalStrip).toContainText('目标进行中');
    await expect(goalStrip).toContainText('整理季度报告并交付');
    await expect(goalStrip).toContainText('1/3');

    // 审批卡：SSE approval_required → 卡片出现 → 批准（带一次性凭据）
    const approvalCard = page.locator('.approval-card');
    await expect(approvalCard).toBeVisible();
    const approvalReq = page.waitForRequest((r) => r.url().includes('/api/approvals/') && r.method() === 'POST');
    await approvalCard.locator('button').first().click();
    await approvalReq;

    // 结果终态：气泡 = done 帧 content，无残留流式状态
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('报告已生成交付。');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);

    // 第二轮：阻塞（error 帧）→ 恢复入口出现
    turn = 2;
    await page.unroute('**/api/sessions/*/chat');
    // 服务端崩溃式中断：error 帧后无 end（流直接断开）→ onEnd 不清断点，checkpoint 拉取保住恢复入口
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux02-run-2"}',
        '',
        'event: delta',
        'data: {"text":"交付环节被卡住…"}',
        '',
        'event: error',
        'data: {"error":"交付确认超时，任务已暂停","kind":"deadline"}',
        '',
      ]),
    }));
    await send(page, '继续交付');
    // 截断兜底：error 后无 end → 「话说到一半断了」（errSeen 置位后实际不触发，
    // 这里 mock 流天然结束触发的兜底文案；title 保留最后一条错误原文）
    await expect(page.locator('.wx-failure').last()).toContainText('这件事我没办成');
    // 恢复入口：checkpoint.exists=true（turn=2）→ 「接着说」
    await expect(page.locator('.sess-banner.resume')).toContainText('上次做到第 3 轮停下了');
  });
});

test.describe('状态覆盖（UX-03）', () => {
  test('空数据：无历史会话时展示品牌首屏，无 loading 悬空', async ({ page }) => {
    // 全空 mock：无历史会话、无模型 → 自动建一个会话，首屏 brand-hero 提示引导配置模型
    await page.route('**/api/sessions', (route) => route.fulfill({
      json: route.request().method() === 'GET' ? [] : { id: 'empty-e2e', title: '新会话', model: '', provider: '', mode: 'chat', planPending: 0, archived: 0, pinned: 0, createdAt: 1, updatedAt: 1 },
    }));
    await page.route('**/api/sessions/empty-e2e/messages', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/models', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/providers', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/events', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: '' }));
    await page.route('**/api/trace/stats', (route) => route.fulfill({ json: { trace: {}, cache: {}, l1Enabled: false } }));
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({ json: { exists: false, turn: 0, historyMessages: 0, createdAt: 0 } }));
    await page.goto('/');
    await expect(page.locator('.brand-hero')).toBeVisible();
    await expect(page.locator('.brand-note')).toContainText('还没给我配模型');
    // 无 loading 悬空：首屏稳定后不再有 aria-busy 区域
    await expect(page.locator('.view-loading')).toHaveCount(0);
  });

  test('断线：SSE 中断后头部横幅与实时灯同步进入重连态', async ({ page }) => {
    await setup(page);
    // 浏览器 offline 事件 → subscribeEvents 主动关闭连接并置 down
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    // 离线横幅：聊天页头部状态字切换为断线提示（实时灯在非聊天页展示）
    await expect(page.locator('.wx-header-sub.off')).toContainText('跟后端的连线断了一下');
  });

  test('Provider 错误：provider.error 事件触发告警提示与 Provider 列表刷新', async ({ page }) => {
    await setup(page);
    // 全局事件流返回一条 provider.error 帧（服务端真实格式：event: event + data: {type, data}）
    await page.unroute('**/api/events');
    const providerErrorFrame = `event: event\ndata: ${JSON.stringify({ type: 'provider.error', data: { providerId: 'p1', providerLabel: 'Test Provider', authFailed: false, error: '连接超时' } })}\n\n`;
    await page.route('**/api/events', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: providerErrorFrame }));
    // 页面收到事件后：Provider 列表刷新 + warning toast
    const providerRefresh = page.waitForRequest((r) => r.url().includes('/api/providers') && r.method() === 'GET');
    await page.reload();
    await providerRefresh;
    await expect(page.locator('[data-sonner-toast][data-type="warning"], .sonner-toast-warning').first()).toContainText('Test Provider');
  });

  test('工具失败：tool_result ok=false 定格为「没成」错误卡，流式复位无悬空', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux03-tool-fail"}',
        '',
        'event: tool_start',
        'data: {"id":"tf-1","name":"read_file","args":{"path":"missing.md"}}',
        '',
        'event: tool_result',
        'data: {"id":"tf-1","name":"read_file","summary":"文件不存在：missing.md","ok":false}',
        '',
        'event: done',
        'data: {"content":"这个文件我找不到，先停下来了。","usage":{"input":10,"output":4},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '读一下 missing.md');
    const toolCard = page.locator('.tool-card.err');
    await expect(toolCard).toContainText('没成');
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('这个文件我找不到');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toBeVisible();
  });

  test('部分成功：task_partial 帧展示「部分完成」验收卡并保留未满足条件', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux03-partial"}',
        '',
        'event: delta',
        'data: {"text":"报告主体已生成，附录还在补。"}',
        '',
        'event: task_partial',
        'data: {"objective":"生成完整报告","checks":[{"ok":true,"reason":"正文存在：report.md"},{"ok":false,"reason":"附录缺失：appendix.md"}],"evidence":[{"source":"filesystem","detail":"正文存在：report.md","traceStepId":"partial-step-1"}]}',
        '',
        'event: done',
        'data: {"content":"报告主体已生成，附录还在补。","usage":{"input":30,"output":15},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '生成完整报告');
    const verification = page.locator('.wx-verification');
    await expect(verification).toContainText('部分完成');
    await expect(verification).toContainText('1/2');
    await expect(verification).toContainText('附录缺失：appendix.md');
    await expect(verification).toHaveAttribute('open', '');
    await expectSettled(page, '报告主体已生成，附录还在补。');
  });
});

test.describe('交互通道（UX-04）', () => {
  test('键盘取消：Esc 在流式期间触发停止，2 秒内出现停止终态与恢复入口', async ({ page }) => {
    test.setTimeout(30_000);
    // 与鼠标取消相同的服务端语义：start+delta 后保持流打开，abort 关闭
    await page.addInitScript(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/chat')) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode('event: start\ndata: {"traceId":"ux04-cancel"}\n\nevent: delta\ndata: {"text":"长任务进行中…"}\n\n'));
              const signal = (init as RequestInit | undefined)?.signal;
              if (signal) signal.addEventListener('abort', () => { try { controller.close(); } catch { /* 已关闭 */ } }, { once: true });
            },
          });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return orig(input, init);
      };
    });
    await setup(page);
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({
      json: { exists: true, turn: 1, historyMessages: 4, createdAt: Date.now() },
    }));
    await send(page, '跑一个长任务');
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible();
    await page.keyboard.press('Escape');
    const startedAt = Date.now();
    await expect(page.locator('.wx-stopped')).toContainText('你打断了');
    await expect(page.locator('.sess-banner.resume')).toContainText('上次做到第 2 轮停下了');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test('键盘审批：Enter 激活「可以，去做吧」并携带一次性凭据', async ({ page }) => {
    await setup(page);
    const responses: { approved: boolean; approvalToken?: string }[] = [];
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux04-approval"}',
        '',
        'event: approval_required',
        'data: {"approvalId":"ux04-ap-1","name":"delete_file","summary":"删除 reports/draft.md","approvalToken":"ux04-token"}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await page.route('**/api/approvals/ux04-ap-1', async (route) => {
      responses.push(route.request().postDataJSON() as { approved: boolean; approvalToken?: string });
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await send(page, '删除草稿文件');
    const approveBtn = page.locator('.approval-card').getByRole('button', { name: '可以，去做吧' });
    await expect(approveBtn).toBeVisible();
    await approveBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.approval-card')).toHaveCount(0);
    expect(responses).toEqual([{ approved: true, approvalToken: 'ux04-token' }]);
  });

  test('键盘继续：Tab+Enter 激活「接着说」恢复断点', async ({ page }) => {
    await setup(page);
    // 初始加载不拉 checkpoint；与 UX-02 相同：错误流触发 onError 后拉取
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({
      status: 200,
      json: { exists: true, turn: 2, historyMessages: 6, createdAt: Date.now() },
    }));
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"ux04-resume-interrupt"}',
        '',
        'event: delta',
        'data: {"text":"任务被卡住了…"}',
        '',
        'event: error',
        'data: {"error":"执行被打断","kind":"deadline"}',
        '',
      ]),
    }));
    await send(page, '先跑一段然后被打断');
    // 错误回调拉取 checkpoint → 恢复横幅出现
    await expect(page.locator('.sess-banner.resume')).toContainText('上次做到第 3 轮停下了');
    const requests: Record<string, unknown>[] = [];
    await page.unroute('**/api/sessions/*/chat');
    await page.route('**/api/sessions/*/chat', async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      const body = [
        'event: start',
        'data: {"traceId":"ux04-resume"}',
        '',
        'event: done',
        'data: {"content":"恢复后的答复。","usage":{"input":10,"output":5},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    const resumeBtn = page.locator('.sess-banner.resume').getByRole('button', { name: '接着说' });
    await resumeBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('恢复后的答复。');
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ resume: true });
  });

  test('键盘重试：失败气泡的「再试一次」Tab+Enter 激活并重发原文', async ({ page }) => {
    await setup(page);
    let calls = 0;
    await page.route('**/api/sessions/*/chat', (route) => {
      calls += 1;
      const body = calls === 1
        ? sseBody(['event: start', 'data: {"traceId":"ux04-retry-1"}', '', 'event: delta', 'data: {"text":"先试了一半…"}', '', 'event: error', 'data: {"error":"后端打了个盹","kind":"transient"}', '', 'event: end', 'data: {}', ''])
        : sseBody(['event: start', 'data: {"traceId":"ux04-retry-2"}', '', 'event: done', 'data: {"content":"这次成功了。","usage":{"input":8,"output":4},"cost":0}', '', 'event: end', 'data: {}', '']);
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await send(page, '重试我这条任务');
    const retryBtn = page.locator('.wf-retry');
    await expect(retryBtn).toBeVisible();
    await retryBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('这次成功了。');
  });
});

test.describe('长任务语义（LR-02）', () => {
  test('成本熔断：budget_hit 帧唤起预算横幅，预算错误终态同步页面状态', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"lr02-budget"}',
        '',
        'event: delta',
        'data: {"text":"长任务跑到一半，成本触顶。"}',
        '',
        'event: budget_hit',
        'data: {"cost":0.42,"budget":0.42}',
        '',
        'event: error',
        'data: {"error":"成本预算已耗尽","kind":"budget"}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '跑一个会烧穿预算的长任务');
    const banner = page.locator('.sess-banner.budget');
    await expect(banner).toContainText('预算用完了');
    await expect(banner).toContainText('已用 $0.420 / 预算 $0.420');
    await expect(page.locator('.wx-failure').last()).toContainText('预算用完了');
    await expect(page.locator('.stream-cursor')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toBeVisible();
  });

  test('角色移交：handoff 帧落为系统消息与接管横幅', async ({ page }) => {
    // role 横幅数据源是会话列表（服务端持久化 sessions.role）；
    // 聊天流被 mock 后，handoff 帧到达时同步会话列表返回接管角色
    let sessionId = 'lr02-handoff-sess';
    let handedOff = false;
    await page.route('**/api/sessions', (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { title?: string } | null;
        return route.fulfill({ json: { id: sessionId, title: body?.title ?? '新会话', model: 'e2e-model', provider: 'e2e-provider', mode: 'chat', planPending: 0, archived: 0, pinned: 0, role: '', createdAt: 1, updatedAt: 1 } });
      }
      return route.fulfill({ json: [{ id: sessionId, title: '移交会话', model: 'e2e-model', provider: 'e2e-provider', mode: 'chat', planPending: 0, archived: 0, pinned: 0, role: handedOff ? 'planner' : '', createdAt: 1, updatedAt: 1 }] });
    });
    await page.route('**/api/sessions/lr02-handoff-sess/messages', (route) => route.fulfill({ json: [] }));
    await setup(page);
    await page.route('**/api/sessions/*/chat', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody([
        'event: start',
        'data: {"traceId":"lr02-handoff"}',
        '',
        'event: delta',
        'data: {"text":"这个任务需要规划专家接手。"}',
        '',
        'event: handoff',
        'data: {"role":"planner","objective":"拆解季度报告的执行步骤"}',
        '',
        'event: done',
        'data: {"content":"已移交给规划专家。","usage":{"input":12,"output":6},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ]),
    }));
    await send(page, '把季度报告任务交给规划专家');
    handedOff = true;
    await expect(page.locator('.msg-system, .msg-row').filter({ hasText: '这活儿交给「planner」了' })).toBeVisible();
    await expect(page.locator('.sess-banner.role')).toContainText('这件事现在由「planner」接手');
    await expectSettled(page, '已移交给规划专家。');
  });
});
