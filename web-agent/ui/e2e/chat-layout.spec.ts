import { installRunMocks, mockTaskEvents, mockLiveTaskEvents } from './run-fixture';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { Message, Session } from '../src/types';

const sessions: Session[] = ['设计核对', '历史对话'].map((title, index) => ({
  id: `chat-layout-${index}`,
  title,
  model: 'demo',
  provider: 'demo',
  mode: 'normal',
  planPending: 0,
  archived: 0,
  pinned: 0,
  createdAt: 1,
  updatedAt: 1,
}));

function history(count = 1): Message[] {
  return Array.from({ length: count }, (_, index) => [
    {
      id: `user-${index}`,
      sessionId: sessions[0].id,
      role: 'user' as const,
      content: `检查第 ${index + 1} 项布局`,
      createdAt: index * 2 + 1,
    },
    {
      id: `assistant-${index}`,
      sessionId: sessions[0].id,
      role: 'assistant' as const,
      content: `第 ${index + 1} 项：消息采用 **统一的阅读宽度**。\n\n- 保留已有功能\n- 检查中文与长内容\n- 支持键盘和触屏\n\n\`\`\`ts\nconst layout = { responsive: true };\n\`\`\``,
      createdAt: index * 2 + 2,
    },
  ]).flat();
}

async function setup(page: Page, messages = history(), events?: (route: Route) => Promise<void>) {
  await installRunMocks(page);
  await page.route('**/api/sessions', (route) => route.fulfill({ json: sessions }));
  await page.route('**/api/sessions/*/messages', (route) =>
    route.fulfill({ json: route.request().url().includes(sessions[0].id) ? messages : history(1) }),
  );
  await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({ json: { exists: false } }));
  await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ json: { plan: null } }));
  await page.route('**/api/plugins/goal-plan/plan*', (route) => route.fulfill({ json: { plan: null } }));
  await page.route('**/api/approvals**', (route) =>
    route.fulfill({ json: route.request().method() === 'POST' ? { ok: true } : { pending: [] } }),
  );
  await page.route('**/api/providers', (route) =>
    route.fulfill({ json: [{ id: 'demo', label: '演示模型', model: 'demo', enabled: true, hasKey: true }] }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({
      json: [
        { id: 'demo@demo', provider: 'demo', model: 'demo', label: '演示模型' },
        { id: 'demo@other', provider: 'demo', model: 'other', label: '备用模型' },
      ],
    }),
  );
  await page.route('**/api/sessions/chat-layout-*', (route) => {
    if (route.request().method() === 'PATCH') return route.fulfill({ json: { ...sessions[0], ...route.request().postDataJSON() } });
    return route.fallback();
  });
  await page.route('**/api/events', events ?? ((route) => route.fulfill({ contentType: 'text/event-stream', body: '' })));
  await page.route('**/api/trace/stats', (route) => route.fulfill({ json: { trace: {}, cache: {}, l1Enabled: false } }));
  await page.route('**/api/commands/list', (route) =>
    route.fulfill({
      json: {
        commands: [
          { name: 'help', description: '查看全部命令', source: 'builtin' },
          { name: 'model', usage: '<模型名称>', description: '切换模型', source: 'builtin' },
        ],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  if (messages.length) await expect(page.getByTestId('msg-bubble-assistant').last()).toBeVisible();
  else await expect(page.getByTestId('chat-welcome')).toBeVisible();
}

async function mockReply(page: Page) {
  const requests: unknown[] = [];
  await mockTaskEvents(page, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: start\ndata: {"traceId":"layout"}\n\nevent: done\ndata: {"content":"已完成。","usage":{"input":1,"output":1},"cost":0}\n\nevent: end\ndata: {}\n\n',
    });
  });
  return requests;
}

test('中文输入法确认不会发送，Enter 和 Shift+Enter 各自生效', async ({ page }) => {
  await setup(page);
  const requests = await mockReply(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('中文输入');
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(requests).toHaveLength(0);
  await expect(input).toHaveValue('中文输入');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('中文输入\n');
  expect(requests).toHaveLength(0);
  await input.press('Enter');
  await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('已完成。');
  expect(requests).toHaveLength(1);
});

test('模型选择与表情保持草稿，只有发送按钮提交', async ({ page }) => {
  await setup(page);
  const requests = await mockReply(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(page.getByTestId('send-btn')).toBeDisabled();
  await expect(input.locator('..')).toHaveCSS('opacity', '1');
  await input.fill('保留草稿');
  await page.getByRole('combobox', { name: /^切换模型，/ }).click();
  await page.getByRole('option', { name: /备用模型/ }).click();
  await expect(input).toHaveValue('保留草稿');
  await page.getByTestId('emoji-btn').click();
  await page.getByTestId('emoji-panel').getByRole('button').first().click();
  expect(requests).toHaveLength(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('send-btn').click();
  await expect.poll(() => requests.length).toBe(1);
});

test('消息保持官方 Bubble 样式和正文选择能力', async ({ page }) => {
  await setup(page);
  const user = page.getByTestId('msg-bubble-user');
  const assistant = page.getByTestId('msg-bubble-assistant');
  await expect(user).toHaveAttribute('data-slot', 'bubble-content');
  await expect(assistant).toHaveAttribute('data-slot', 'bubble-content');
  await expect(user).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(assistant).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(assistant).toHaveCSS('user-select', 'text');
  await expect(assistant.locator('ul')).toHaveCSS('list-style-type', 'disc');
});

test('斜杠命令支持方向键和 Tab，选择后焦点保留在消息框', async ({ page }) => {
  await setup(page);
  const requests = await mockReply(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('/');
  await expect(page.getByRole('option', { name: /\/help/ })).toBeVisible();
  await expect(input).toBeFocused();
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toHaveValue('/model ');
  await expect(input).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test('流式活动共用 Trace，滚动阅读历史后可回到最新', async ({ page }) => {
  await setup(page, history(12));
  await mockLiveTaskEvents(page);
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const encoder = new TextEncoder();
    const state = window as unknown as { emitChat: (event: string, data: unknown) => void; endChat: () => void };
    window.fetch = (...args) => {
      if (/\/api\/v2\/runs\/[^/]+\/events/.test(String(args[0]))) {
        let seq = 0;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                state.emitChat = (event, data) => {
                  if (event === 'done') (window as unknown as { liveTaskDone: boolean }).liveTaskDone = true;
                  controller.enqueue(encoder.encode(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                };
                state.endChat = () => controller.close();
                state.emitChat('start', { traceId: 'live-layout' });
                state.emitChat('reasoning', { text: '检查消息布局与工具输出。' });
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        );
      }
      return originalFetch(...args);
    };
  });
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('检查布局');
  await input.press('Enter');
  await page.waitForFunction(() => typeof (window as unknown as { emitChat?: unknown }).emitChat === 'function');
  const lastMessage = page.locator('[data-slot="message"][data-align="start"]').last();
  await expect(lastMessage).toContainText('正在思考');
  await expect(lastMessage.locator('[data-slot="trace"]')).toHaveCount(1);
  await page.evaluate(() => {
    const state = window as unknown as { emitChat: (event: string, data: unknown) => void };
    state.emitChat('tool_start', { id: 'read-layout', name: 'read_file', args: { path: 'src/app.tsx' } });
    state.emitChat('tool_result', { id: 'read-layout', name: 'read_file', summary: '已读取文件。', ok: true });
    state.emitChat('delta', { text: '# 布局检查\n\n' + '新的回复内容。\n\n'.repeat(25) });
  });
  await expect(lastMessage.getByTestId('tool-step')).toHaveAttribute('data-status', 'done');
  await expect(lastMessage.locator('[data-slot="trace"]')).toHaveCount(1);
  await expect(lastMessage.locator('[data-slot="trace-line"][data-status="running"]')).toHaveCount(0);
  await expect(lastMessage.getByRole('button', { name: /思考过程/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(lastMessage.getByRole('heading', { name: '布局检查' })).toBeVisible();
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(viewport).not.toHaveAttribute('data-autoscrolling');
  const liveTop = await viewport.evaluate((element) => element.scrollTop);
  await viewport.hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(liveTop - 300);
  const top = await viewport.evaluate((element) => element.scrollTop);
  await page.evaluate(() =>
    (window as unknown as { emitChat: (event: string, data: unknown) => void }).emitChat('delta', { text: '额外内容。\n\n'.repeat(10) }),
  );
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(top + 50);
  const latest = page.getByRole('button', { name: '回到底部' });
  await expect(latest).toHaveAttribute('data-active', 'true');
  await latest.click();
  await expect(latest).toHaveAttribute('data-active', 'false');
  await page.evaluate(() => {
    const state = window as unknown as { emitChat: (event: string, data: unknown) => void; endChat: () => void };
    state.emitChat('done', { content: '布局检查完成。', usage: { input: 20, output: 40 }, cost: 0 });
    state.emitChat('end', {});
    state.endChat();
  });
  await expect(page.getByTestId('send-btn')).toBeVisible();
});

test('切换会话时为新消息流重新定位', async ({ page }, testInfo) => {
  await setup(page, history(12));
  await page.screenshot({ path: testInfo.outputPath('conversation-desktop.png') });
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await viewport.hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(100);
  await page.getByRole('button', { name: /^历史对话/ }).click();
  await expect(page.getByTestId('msg-bubble-assistant')).toHaveCount(1);
  await expect(page.locator('[data-slot="message-scroller-viewport"][data-pending-scroll]')).toHaveCount(0);
  await expect(page.getByTestId('msg-bubble-assistant')).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile.png') });
});

for (const width of [390, 900]) {
  test(`窄屏 ${width}px 轨迹面板可开关并返回焦点`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const toggle = page.getByRole('button', { name: '运行轨迹面板' });
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: '运行轨迹' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: '步骤类型筛选' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const theme of ['light', 'dark']) {
  for (const brand of ['doodle', 'ink', 'moss']) {
    test(`${theme} ${brand} 主题与首页贴纸布局`, async ({ page }, testInfo) => {
      await page.addInitScript(
        ({ theme, brand }) => {
          localStorage.setItem('maharness-theme', theme);
          localStorage.setItem('maharness-brand', brand);
        },
        { theme, brand },
      );
      await setup(page, []);
      const photo = page.getByRole('button', { name: '更换首页贴纸照片' });
      await expect(photo).toBeInViewport();
      await expect(page.getByTestId('hero-sticker')).toHaveCSS('rotate', '2deg');
      const primary = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return [style.getPropertyValue('--primary').trim(), style.getPropertyValue('--brand-primary').trim()];
      });
      expect(primary[0]).toBe(primary[1]);
      await page.screenshot({ path: testInfo.outputPath('desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(photo).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('mobile.png') });
    });
  }
}

test('首页贴纸换图持久化并可恢复默认照片', async ({ page }) => {
  await setup(page, []);
  const sticker = page.getByTestId('hero-sticker').locator('img');
  const original = await sticker.getAttribute('src');
  await page
    .getByTestId('hero-sticker')
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'photo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>',
      ),
    });
  await expect(sticker).toHaveAttribute('src', /^data:image\/jpeg/);
  const custom = await sticker.getAttribute('src');
  await page.reload();
  await expect(sticker).toHaveAttribute('src', custom!);
  await page.getByRole('button', { name: '恢复默认贴纸' }).click();
  await expect(sticker).toHaveAttribute('src', original!);
  expect(await page.evaluate(() => localStorage.getItem('maharness-sticker'))).toBeNull();
});

for (const viewport of [
  { width: 390, height: 640 },
  { width: 900, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`${viewport.width}px 多项审批、目标与任务状态并存时保留阅读和输入空间`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let releaseEvents!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await setup(page, history(), async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: event\ndata: ${JSON.stringify({
          type: 'plan.updated',
          data: {
            objective: '整理季度报告',
            current: 1,
            completed: false,
            createdAt: 1,
            steps: Array.from({ length: 30 }, (_, index) => ({
              title: `报告步骤 ${index + 1}`,
              status: index === 0 ? 'done' : index === 1 ? 'in_progress' : 'pending',
            })),
          },
        })}\n\n`,
      });
    });
    await mockTaskEvents(page, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: [
          `event: start\ndata: ${JSON.stringify({ traceId: 'context-layout' })}\n\n`,
          ...Array.from(
            { length: 8 },
            (_, index) =>
              `event: approval_required\ndata: ${JSON.stringify({ approvalId: `context-${index}`, name: 'write_file', summary: `写入 reports/quarter-${index}.md` })}\n\n`,
          ),
          'event: end\ndata: {}\n\n',
        ].join(''),
      }),
    );
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('整理季度报告');
    await input.press('Enter');
    await expect(page.getByTestId('run-controls')).toBeVisible();
    releaseEvents();
    const goal = page.getByTestId('goal-plan');
    await expect(goal).toContainText('整理季度报告');
    await expect(goal.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
    await goal.getByRole('button').first().click();
    await expect(goal).toContainText('报告步骤 30');
    await input.fill('报告内容\n'.repeat(60));
    const context = page.getByRole('region', { name: '任务状态与审批' }).locator('[data-slot="scroll-area-viewport"]');
    await expect(page.getByTestId('approval-card')).toHaveCount(8);
    const approve = page.getByTestId('approval-card').first().getByRole('button', { name: '可以，去做吧' });
    await approve.focus();
    await expect(approve).toBeInViewport();
    await approve.click();
    await expect(page.getByTestId('approval-card')).toHaveCount(7);
    const measurements = await page.evaluate(() => {
      const thread = document.querySelector('[data-slot="message-scroller-viewport"]')!;
      const content = document.querySelector('[data-slot="message-scroller-content"]')!;
      const composer = document.querySelector('[data-testid="chat-composer"]')!;
      const context = document.querySelector('[data-testid="chat-context"] [data-slot="scroll-area-viewport"]')!;
      return {
        threadHeight: thread.getBoundingClientRect().height,
        composerBottom: composer.getBoundingClientRect().bottom,
        contextHeight: context.getBoundingClientRect().height,
        contextOverflow: context.scrollHeight > context.clientHeight,
        columnOffset: Math.abs(content.getBoundingClientRect().x - composer.getBoundingClientRect().x),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(measurements.threadHeight).toBeGreaterThan(160);
    expect(measurements.composerBottom).toBeLessThanOrEqual(viewport.height);
    expect(measurements.contextHeight).toBeLessThanOrEqual(Math.min(viewport.height * 0.3, 256) + 1);
    expect(measurements.contextOverflow).toBe(true);
    expect(measurements.columnOffset).toBeLessThanOrEqual(8);
    expect(measurements.overflow).toBe(false);
    await expect(input).toHaveValue('报告内容\n'.repeat(60));
    await context.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath('context-layout.png') });
  });
}

for (const width of [390, 1440]) {
  test(`${width}px 轨迹按需显示、缓存收起期间步骤并隔离会话`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const state = window as unknown as { busEvents: number };
      state.busEvents = 0;
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener('event', () => {
            state.busEvents++;
          });
        }
      };
    });
    let releaseEvents!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let statsRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/trace/stats')) statsRequests++;
    });
    const steps = [
      { id: 'cached-step', traceId: 'layout', status: 'running', outputSummary: '正在读取' },
      { id: 'cached-step', traceId: 'layout', status: 'done', outputSummary: '收起期间已完成读取' },
      { id: 'foreign-step', traceId: 'other-session', status: 'done', outputSummary: '其他会话的步骤' },
    ];
    await setup(page, history(), async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: steps
          .map(
            (step) =>
              `event: event\ndata: ${JSON.stringify({ type: 'trace.step', data: { turn: 1, type: 'tool_call', name: 'read_file', ts: 1, ...step } })}\n\n`,
          )
          .join(''),
      });
    });
    await mockReply(page);
    const toggle = page.getByRole('button', { name: '运行轨迹面板' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('trace-panel')).toHaveCount(0);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('读取布局文件');
    await page.getByTestId('send-btn').click();
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('已完成。');
    releaseEvents();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { busEvents: number }).busEvents))
      .toBeGreaterThanOrEqual(steps.length);
    expect(statsRequests).toBe(0);
    await toggle.click();
    const panel = page.getByTestId('trace-panel');
    await expect(panel.getByTestId('trace-step')).toHaveCount(1);
    await expect(panel.getByTestId('trace-step')).toContainText('收起期间已完成读取');
    await expect(panel).not.toContainText('其他会话的步骤');
    await expect.poll(() => statsRequests).toBeGreaterThan(0);
    if (width < 1100) {
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(panel.getByTestId('trace-step')).toHaveCount(1);
    } else {
      await page.getByRole('button', { name: /^历史对话/ }).click();
      await expect(panel.getByTestId('trace-step')).toHaveCount(0);
    }
  });
}

test('输入框原生随草稿增长、限制高度并在清空后恢复', async ({ page }) => {
  await setup(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const initial = await input.evaluate((element) => element.getBoundingClientRect().height);
  await input.fill('这是较长的草稿内容。\n'.repeat(40));
  await expect.poll(() => input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initial);
  expect(await input.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(192);
  await input.fill('');
  await expect.poll(() => input.evaluate((element) => element.getBoundingClientRect().height)).toBe(initial);
});

test('长思考限制详情高度，运行中与完成后都尊重手动展开状态', async ({ page }) => {
  await setup(page);
  await mockLiveTaskEvents(page);
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const encoder = new TextEncoder();
    const state = window as unknown as { emitChat: (event: string, data: unknown) => void; endChat: () => void };
    window.fetch = (...args) => {
      if (/\/api\/v2\/runs\/[^/]+\/events/.test(String(args[0]))) {
        let seq = 0;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                state.emitChat = (event, data) => {
                  if (event === 'done') (window as unknown as { liveTaskDone: boolean }).liveTaskDone = true;
                  controller.enqueue(encoder.encode(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                };
                state.endChat = () => controller.close();
                state.emitChat('start', { traceId: 'long-reasoning' });
                state.emitChat('reasoning', { text: '核对任务的输入与输出。\n'.repeat(100) });
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        );
      }
      return originalFetch(...args);
    };
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('核对报告');
  await page.getByTestId('send-btn').click();
  const message = page.locator('[data-slot="message"][data-align="start"]').last();
  const thinking = message
    .locator('[data-slot="trace-collapsible"]')
    .filter({ has: page.locator('[data-slot="trace-title"]', { hasText: /正在思考|思考过程/ }) });
  const trigger = thinking.getByRole('button').first();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  const scroll = thinking.getByRole('region', { name: '思考详情' }).locator('[data-slot="scroll-area-viewport"]');
  await expect(scroll).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await scroll.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(192);
  await trigger.click();
  await page.evaluate(() =>
    (window as unknown as { emitChat: (event: string, data: unknown) => void }).emitChat('reasoning', { text: '继续核对。' }),
  );
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() =>
    (window as unknown as { emitChat: (event: string, data: unknown) => void }).emitChat('tool_start', {
      id: 'sub-live',
      name: 'run_subagent',
      args: { objective: '核对报告' },
    }),
  );
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const member = message.getByTestId('subagent-step');
  await expect(member.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  await member.getByRole('button').first().click();
  await expect(member.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    const state = window as unknown as { emitChat: (event: string, data: unknown) => void; endChat: () => void };
    state.emitChat('tool_result', { id: 'sub-live', name: 'run_subagent', summary: '报告已核对', ok: true });
    state.emitChat('done', { content: '核对完成。', usage: { input: 1, output: 1 }, cost: 0 });
    state.emitChat('end', {});
    state.endChat();
  });
  await expect(message.getByTestId('msg-bubble-assistant')).toContainText('核对完成。');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(member.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
  await member.getByRole('button').first().click();
  await expect(member).toContainText('报告已核对');
});
