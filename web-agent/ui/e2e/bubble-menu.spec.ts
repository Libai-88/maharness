// ui/e2e/bubble-menu.spec.ts —— 微信式气泡菜单 / 引用回复 / 表情面板 E2E 冒烟
// 触发路径覆盖三种确定性方式：真长按（mouse.down + 延时 + mouse.up）、右键、键盘（Shift+F10 / Enter）
// 数据自给自足：models/providers/chat 全部 route-mock——CI 空库（data/ 被忽略）与本地有历史两种状态行为一致
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const INPUT_PLACEHOLDER = '跟小马说点什么…（按 / 看命令）';

/** mock 流式接口：绕开真实 LLM（断言 UI 组合与渲染，不落库、不耗 token） */
function mockChatStream(page: Page) {
  return page.route('**/api/sessions/*/chat', async (route) => {
    const body = [
      'event: start',
      'data: {"traceId":"e2e-t"}',
      '',
      'event: delta',
      'data: {"text":"收到，这是一条 mock 回复。"}',
      '',
      'event: done',
      'data: {"content":"收到，这是一条 mock 回复。","usage":{"input":10,"output":5},"cost":0}',
      '',
      'event: end',
      'data: {}',
      '',
    ].join('\n');
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
}

/** 让 textarea 可用（hasModels）：mock 一个 provider + 一个 model */
async function mockModelApis(page: Page) {
  await page.route('**/api/providers', (route) => route.fulfill({ json: [{
    id: 'e2e-provider', label: 'E2E Provider', baseUrl: 'http://e2e.local', model: 'e2e-model',
    enabled: true, apiKeyMasked: 'sk-***', hasKey: true, createdAt: 0, updatedAt: 0,
  }] }));
  await page.route('**/api/models', (route) => route.fulfill({ json: [{
    id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model',
  }] }));
}

/** 统一前置：mock 模型接口 + 首屏就绪 + 保证至少有一轮对话气泡（空库时自动种子一条 mock 对话） */
async function setup(page: Page) {
  await mockModelApis(page);
  await page.goto('/');
  await expect
    .poll(async () => {
      const bubbles = await page.getByTestId('msg-bubble-assistant').or(page.getByTestId('msg-bubble-user')).count();
      const hasHero = await page.locator('.brand-hero').count();
      return bubbles + hasHero;
    })
    .toBeGreaterThan(0);
  if ((await page.getByTestId('msg-bubble-assistant').count()) === 0) {
    await mockChatStream(page);
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('e2e 种子消息');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('收到，这是一条 mock 回复。');
  }
}

test.describe('气泡长按菜单（微信式）', () => {
  test('真长按 480ms 呼出菜单，点外部关闭', async ({ page }) => {
    await setup(page);
    const bubble = page.getByTestId('msg-bubble-assistant').last();
    const box = await bubble.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await page.locator('.wx-menu-overlay').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('bubble-menu')).toHaveCount(0);
  });

  test('右键呼出菜单（桌面等价手势）', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await expect(page.getByTestId('menu-quote')).toBeVisible();
  });

  test('键盘 Shift+F10 与 Enter 均可呼出', async ({ page }) => {
    await setup(page);
    const bubble = page.getByTestId('msg-bubble-assistant').last();
    await bubble.focus();
    await bubble.press('Shift+F10');
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
    await page.locator('.wx-menu-overlay').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('bubble-menu')).toHaveCount(0);
    await bubble.focus();
    await bubble.press('Enter');
    await expect(page.getByTestId('bubble-menu')).toBeVisible();
  });

  test('菜单「引用」→ 引用条出现 → 取消消失', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await page.getByTestId('menu-quote').click();
    const bar = page.getByTestId('quote-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.qb-author')).toContainText('小马');
    await page.getByTestId('quote-cancel').click();
    await expect(bar).toHaveCount(0);
  });

  test('用户气泡菜单有「重新发送」与「删除」', async ({ page }) => {
    await setup(page);
    const userBubble = page.getByTestId('msg-bubble-user').last();
    if ((await userBubble.count()) === 0) test.skip(true, '当前会话无用户消息');
    await userBubble.click({ button: 'right' });
    await expect(page.getByTestId('menu-resend')).toBeVisible();
    await expect(page.getByTestId('menu-remove')).toBeVisible();
  });

  test('「删除」仅从当前视图移除该气泡', async ({ page }) => {
    await setup(page);
    const userBubble = page.getByTestId('msg-bubble-user').last();
    if ((await userBubble.count()) === 0) test.skip(true, '当前会话无用户消息');
    const before = await page.getByTestId('msg-bubble-user').count();
    await userBubble.click({ button: 'right' });
    await page.getByTestId('menu-remove').click();
    await expect(page.getByTestId('msg-bubble-user')).toHaveCount(before - 1);
  });
});

test.describe('Provider 诊断', () => {
  test('设置页展示配置完整性、模型数量和可操作问题', async ({ page }) => {
    await mockModelApis(page);
    await page.route('**/api/providers/e2e-provider/diagnose', (route) => route.fulfill({ json: {
      schemaVersion: 1,
      providerId: 'e2e-provider',
      protocol: 'openai',
      configured: { baseUrl: true, apiKey: false, defaultModel: true },
      health: null,
      models: [],
      issues: ['缺少 API Key', '最近请求失败 2 次'],
    } }));
    await page.route('**/api/config', (route) => route.fulfill({ json: { routingTargets: [] } }));
    await page.route('**/api/stats', (route) => route.fulfill({ json: { cache: {}, trace: {} } }));
    await page.route('**/api/personas', (route) => route.fulfill({ json: [] }));
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();
    await page.locator('.sn-item', { hasText: '模型与 Provider' }).click();
    await expect(page.getByText('E2E Provider')).toBeVisible();
    await page.getByRole('button', { name: '诊断' }).click();
    await expect(page.getByRole('status')).toContainText('配置：不完整');
    await expect(page.getByRole('status')).toContainText('模型：0 个');
    await expect(page.getByRole('status')).toContainText('缺少 API Key');
  });
});

test.describe('引用回复上送（mock 流式）', () => {
  test('发送带引用的消息：气泡含引用块、引用条清理、mock 回复渲染', async ({ page }) => {
    await setup(page);
    await page.getByTestId('msg-bubble-assistant').last().click({ button: 'right' });
    await page.getByTestId('menu-quote').click();
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('引用测试正文');
    await page.keyboard.press('Enter');
    // 用户气泡 = 引用块 + 正文
    await expect(page.getByTestId('msg-bubble-user').last()).toContainText('【引用 小马】');
    await expect(page.getByTestId('msg-bubble-user').last()).toContainText('引用测试正文');
    // 引用条随发送清理；mock 回复到达
    await expect(page.getByTestId('quote-bar')).toHaveCount(0);
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('收到，这是一条 mock 回复。');
  });
});

test.describe('任务验收证据', () => {
  test('完成答复关联逐项验收结果与 Trace 步骤', async ({ page }) => {
    await setup(page);
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = [
        'event: start',
        'data: {"traceId":"e2e-task-trace"}',
        '',
        'event: delta',
        'data: {"text":"报告已生成。"}',
        '',
        'event: task_verified',
        'data: {"objective":"生成并检查报告","checks":[{"ok":true,"reason":"文件存在：reports/final.md"},{"ok":true,"reason":"文件包含指定文本：reports/final.md"}],"evidence":[{"source":"filesystem","detail":"文件存在：reports/final.md","traceStepId":"verify-step-1234"},{"source":"filesystem","detail":"文件包含指定文本：reports/final.md","traceStepId":"verify-step-1234"}]}',
        '',
        'event: done',
        'data: {"content":"报告已生成。","usage":{"input":10,"output":5},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('请生成并检查报告');
    await page.keyboard.press('Enter');

    const assistant = page.getByTestId('msg-bubble-assistant').last();
    await expect(assistant).toContainText('报告已生成。');
    const verification = page.getByText('验收通过').locator('..').locator('..');
    await expect(verification).toContainText('2/2');
    await expect(verification).toContainText('文件存在：reports/final.md');
    await expect(verification).toContainText('文件包含指定文本：reports/final.md');
    const traceReference = verification.locator('code').first();
    await expect(traceReference).toHaveAttribute('title', '对应 Trace 步骤');
    await expect(traceReference).toHaveText('#verify-s');
  });
});

test.describe('工具审批', () => {
  for (const decision of [
    { approved: true, label: '批准', button: '可以，去做吧' },
    { approved: false, label: '拒绝', button: '先别' },
  ]) {
    test(`用户${decision.label}后提交一次性凭据并撤下审批卡`, async ({ page }) => {
      await setup(page);
      const responses: { approved: boolean; approvalToken?: string }[] = [];
      await page.route('**/api/sessions/*/chat', async (route) => {
        const body = [
          'event: start',
          'data: {"traceId":"e2e-approval-trace"}',
          '',
          'event: approval_required',
          'data: {"approvalId":"approval-e2e-1","name":"delete_file","summary":"删除 reports/draft.md","approvalToken":"one-time-approval-token"}',
          '',
          'event: end',
          'data: {}',
          '',
        ].join('\n');
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
      });
      await page.route('**/api/approvals/approval-e2e-1', async (route) => {
        responses.push(route.request().postDataJSON() as { approved: boolean; approvalToken?: string });
        await route.fulfill({ status: 200, json: { ok: true } });
      });
      await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('删除草稿文件');
      await page.keyboard.press('Enter');

      const card = page.locator('.approval-card');
      await expect(card).toContainText('删除 reports/draft.md');
      await card.getByRole('button', { name: decision.button }).click();
      await expect(card).toHaveCount(0);
      expect(responses).toEqual([{ approved: decision.approved, approvalToken: 'one-time-approval-token' }]);
    });
  }
});

test.describe('子代理与并行任务', () => {
  test('子代理成功时展示成员目标和结果摘要', async ({ page }) => {
    await setup(page);
    await page.unroute('**/api/sessions/*/chat');
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = [
        'event: start',
        'data: {"traceId":"e2e-subagent-trace"}',
        '',
        'event: tool_start',
        'data: {"id":"sub-1","name":"run_subagent","args":{"objective":"核对报告"}}',
        '',
        'event: tool_result',
        'data: {"id":"sub-1","name":"run_subagent","summary":"报告已核对","ok":true}',
        '',
        'event: done',
        'data: {"content":"子任务已完成。","usage":{"input":8,"output":4},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('请找帮手核对报告');
    await page.keyboard.press('Enter');
    const member = page.locator('.wx-member-speech').last();
    await expect(member).toHaveClass(/ok/);
    await expect(member.locator('.wx-member-name')).toContainText('子代理 · 核对报告');
    await expect(member.locator('.wx-member-text')).toContainText('报告已核对');
  });

  test('并行任务失败时展示小队失败状态', async ({ page }) => {
    await setup(page);
    await page.unroute('**/api/sessions/*/chat');
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = [
        'event: start',
        'data: {"traceId":"e2e-parallel-trace"}',
        '',
        'event: tool_start',
        'data: {"id":"parallel-1","name":"run_parallel","args":{"tasks":[{"objective":"扫描文件"}]}}',
        '',
        'event: tool_result',
        'data: {"id":"parallel-1","name":"run_parallel","summary":"子任务执行失败","ok":false}',
        '',
        'event: done',
        'data: {"content":"并行任务未完成。","usage":{"input":8,"output":4},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('请并行扫描文件');
    await page.keyboard.press('Enter');
    const member = page.locator('.wx-member-speech').last();
    await expect(member).toHaveClass(/err/);
    await expect(member.locator('.wx-member-name')).toHaveText('并行小队');
    await expect(member.locator('.wx-member-text')).toContainText('子任务执行失败');
  });
});

test.describe('运行轨迹', () => {
  test('span 树父子展开、错误定位与类型筛选平铺', async ({ page }) => {
    let releaseTrace!: () => void;
    const traceGate = new Promise<void>((resolve) => { releaseTrace = resolve; });
    await page.route('**/api/events', async (route) => {
      await traceGate;
      const t = Date.now();
      const step = (data: Record<string, unknown>) => JSON.stringify({ type: 'trace.step', data: { traceId: 'e2e-span-run', ts: t, ...data } });
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: [
          'event: event',
          `data: ${step({ id: 'e2e-span-root', turn: 1, type: 'tool_call', name: 'run_subagent', outputSummary: '委派子任务', status: 'done', durationMs: 300 })}`,
          '',
          'event: event',
          `data: ${step({ id: 'e2e-span-child', turn: 1, type: 'tool_call', name: 'read_file', parentId: 'e2e-span-root', outputSummary: '子任务读取失败', status: 'error', error: '文件不存在：missing.txt', durationMs: 12 })}`,
          '',
          'event: event',
          `data: ${step({ id: 'e2e-span-other', turn: 1, type: 'llm_call', name: 'sub-answer', parentId: 'e2e-span-root', outputSummary: '子任务回答', status: 'done', durationMs: 90 })}`,
          '',
          '',
        ].join('\n'),
      });
    });
    await page.route('**/api/trace/stats', (route) => route.fulfill({
      status: 200,
      json: { trace: { steps: 3, llmCalls: 1, toolCalls: 2 }, cache: {}, l1Enabled: false },
    }));
    await setup(page);
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = [
        'event: start',
        'data: {"traceId":"e2e-span-run"}',
        '',
        'event: done',
        'data: {"content":"子任务已结束。","usage":{"input":8,"output":4},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
      setTimeout(releaseTrace, 200);
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('触发子任务轨迹');
    await page.keyboard.press('Enter');

    const panel = page.locator('.trail-panel');
    const root = panel.locator('.tl-item').filter({ has: page.locator('.tl-title', { hasText: '找了个帮手' }) });
    const child = panel.locator('.tl-item').filter({ hasText: '子任务读取失败' });
    await expect(child).toBeVisible();
    await expect(child).toContainText('文件不存在：missing.txt');
    // 折叠父步骤 → 错误子步骤随之隐藏（span 树语义）；再展开恢复
    await root.locator('.tl-head').first().click();
    await expect(child).toBeHidden();
    await root.locator('.tl-head').first().click();
    await expect(child).toBeVisible();
    // 类型筛选走平铺视图：tool_call 含错误步骤，llm_call 步骤不因父步骤被筛掉而消失
    await panel.locator('select').selectOption('tool_call');
    await expect(panel.locator('.tl-item')).toHaveCount(2);
    await expect(panel.locator('.tl-item').filter({ hasText: '子任务读取失败' })).toBeVisible();
    await panel.locator('select').selectOption('llm_call');
    await expect(panel.locator('.tl-item')).toHaveCount(1);
    await expect(panel.locator('.tl-item').filter({ hasText: '子任务回答' })).toBeVisible();
  });

  test('大事件量（200 步）渲染完整且可滚动', async ({ page }) => {
    let releaseTrace!: () => void;
    const traceGate = new Promise<void>((resolve) => { releaseTrace = resolve; });
    await page.route('**/api/events', async (route) => {
      await traceGate;
      const t = Date.now();
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        const step = { id: `e2e-bulk-${i}`, traceId: 'e2e-bulk-run', turn: 1, type: 'llm_call', name: `bulk-step-${i}`, outputSummary: `批量步骤 ${i}`, status: 'done', durationMs: 1, ts: t - (200 - i) };
        lines.push('event: event', `data: ${JSON.stringify({ type: 'trace.step', data: step })}`, '');
      }
      lines.push('');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: lines.join('\n') });
    });
    await page.route('**/api/trace/stats', (route) => route.fulfill({
      status: 200,
      json: { trace: { steps: 200, llmCalls: 200, toolCalls: 0 }, cache: {}, l1Enabled: false },
    }));
    await setup(page);
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = ['event: start', 'data: {"traceId":"e2e-bulk-run"}', '', 'event: done', 'data: {"content":"批量完成。","usage":{"input":8,"output":4},"cost":0}', '', 'event: end', 'data: {}', '', ''].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
      setTimeout(releaseTrace, 200);
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('灌入批量轨迹');
    await page.keyboard.press('Enter');

    const panel = page.locator('.trail-panel');
    await expect(panel.locator('.tl-item')).toHaveCount(200);
    const scroller = panel.locator('.trail-scroll');
    await expect(scroller).toBeVisible();
    // 滚动到底部：首尾步骤都真实渲染（无虚拟化截断即全部可查）
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(panel.locator('.tl-item').filter({ hasText: '批量步骤 0' })).toBeVisible();
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await expect(panel.locator('.tl-item').filter({ hasText: '批量步骤 199' })).toBeVisible();
  });

  test('接收当前 run 的 Trace 步骤，支持筛选和导出', async ({ page }) => {
    let releaseTrace!: () => void;
    const traceGate = new Promise<void>((resolve) => { releaseTrace = resolve; });
    await page.route('**/api/events', async (route) => {
      await traceGate;
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: [
          'event: event',
          `data: ${JSON.stringify({
            type: 'trace.step',
            data: {
              id: 'e2e-trace-step', traceId: 'e2e-trace-run', turn: 1,
              type: 'llm_call', name: 'e2e-answer', outputSummary: '确定性回放完成',
              status: 'done', durationMs: 42, ts: Date.now(),
            },
          })}`,
          '',
          'event: event',
          `data: ${JSON.stringify({
            type: 'trace.step',
            data: {
              id: 'e2e-trace-tool', traceId: 'e2e-trace-run', turn: 1,
              type: 'tool_call', name: 'delete_file', outputSummary: '已删除临时文件',
              status: 'done', durationMs: 18, ts: Date.now(),
            },
          })}`,
          '',
          '',
        ].join('\n'),
      });
    });
    await page.route('**/api/trace/stats', (route) => route.fulfill({
      status: 200,
      json: { trace: { steps: 2, llmCalls: 1, toolCalls: 1 }, cache: {}, l1Enabled: false },
    }));
    await setup(page);
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = [
        'event: start',
        'data: {"traceId":"e2e-trace-run"}',
        '',
        'event: delta',
        'data: {"text":"已完成回放。"}',
        '',
        'event: done',
        'data: {"content":"已完成回放。","usage":{"input":8,"output":4},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
      setTimeout(releaseTrace, 200);
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('运行一次回放');
    await page.keyboard.press('Enter');

    const panel = page.locator('.trail-panel');
    const modelStep = panel.locator('.tl-item').filter({ hasText: 'e2e-answer' });
    await expect(modelStep).toContainText('确定性回放完成');
    await expect(modelStep.locator('.tl-dur')).toContainText('42ms');
    await expect(panel.locator('.tl-item').filter({ hasText: '已删除临时文件' })).toBeVisible();
    await panel.locator('select').selectOption('tool_call');
    await expect(panel.locator('.tl-item')).toHaveCount(1);
    await expect(panel.locator('.tl-item')).toContainText('已删除临时文件');
    const downloadPromise = page.waitForEvent('download');
    await panel.locator('button.manager-close[aria-label="导出 JSONL"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^maharness-trace-.*\.jsonl$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const jsonl = await readFile(path!, 'utf8');
    expect(jsonl).toContain('e2e-trace-tool');
    expect(jsonl).not.toContain('e2e-trace-step');
  });

  test('长上下文压缩步骤展示来源范围与省略原因', async ({ page }) => {
    let releaseTrace!: () => void;
    const traceGate = new Promise<void>((resolve) => { releaseTrace = resolve; });
    await page.route('**/api/events', async (route) => {
      await traceGate;
      const step = {
        id: 'e2e-context-step', traceId: 'e2e-context-run', turn: 1,
        type: 'system', name: '上下文压缩',
        inputSummary: 'history[3..18] · 16 条早期消息',
        outputSummary: '来源 history[3..18]；LLM 摘要压缩 16 条早期消息（2400 → 180 tokens，省 2220）',
        status: 'done', durationMs: 120, ts: Date.now(),
      };
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: [
        'event: event', `data: ${JSON.stringify({ type: 'trace.step', data: step })}`, '', '',
      ].join('\n') });
    });
    await page.route('**/api/trace/stats', (route) => route.fulfill({
      status: 200, json: { trace: { steps: 1, llmCalls: 1, toolCalls: 0 }, cache: {}, l1Enabled: false },
    }));
    await setup(page);
    await page.route('**/api/sessions/*/chat', async (route) => {
      const body = ['event: start', 'data: {"traceId":"e2e-context-run"}', '', 'event: done', 'data: {"content":"已压缩上下文。","usage":{"input":8,"output":4},"cost":0}', '', 'event: end', 'data: {}', '', ''].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill('继续处理长任务');
    await page.keyboard.press('Enter');
    releaseTrace();
    const step = page.locator('.trail-panel .tl-item').filter({ hasText: '上下文压缩' });
    await expect(step).toContainText('history[3..18]');
    await expect(step).toContainText('省 2220');
  });
});

test.describe('断点恢复', () => {
  test('从可恢复检查点继续时发送 resume 请求并渲染恢复答复', async ({ page }) => {
    await page.route('**/api/sessions/*/checkpoint', (route) => route.fulfill({
      status: 200,
      json: { exists: true, turn: 2, historyMessages: 6, createdAt: Date.now() },
    }));
    await setup(page);
    await expect(page.getByText('上次做到第 3 轮停下了，之前做完的都还在')).toBeVisible();

    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/sessions/*/chat', async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      const body = [
        'event: start',
        'data: {"traceId":"e2e-resume-trace"}',
        '',
        'event: delta',
        'data: {"text":"恢复后的答复。"}',
        '',
        'event: done',
        'data: {"content":"恢复后的答复。","usage":{"input":12,"output":6},"cost":0}',
        '',
        'event: end',
        'data: {}',
        '',
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
    });
    await page.getByRole('button', { name: '接着说' }).click();
    await expect(page.getByTestId('msg-bubble-assistant').last()).toContainText('恢复后的答复。');
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ resume: true });
    expect(requests[0]).not.toHaveProperty('message');
  });
});

test.describe('输入区活感', () => {
  test('空输入显示表情键 → 输入后切换为发送', async ({ page }) => {
    await setup(page);
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
    await expect(page.getByTestId('emoji-btn')).toBeVisible();
    await input.fill('你好');
    await expect(page.getByTestId('send-btn')).toBeVisible();
    await input.fill('');
    await expect(page.getByTestId('emoji-btn')).toBeVisible();
  });

  test('表情面板：打开、插入、再点收起（微信式连挑不关）', async ({ page }) => {
    await setup(page);
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER);
    await page.getByTestId('emoji-btn').click();
    const panel = page.getByTestId('emoji-panel');
    await expect(panel).toBeVisible();
    await panel.locator('button').first().click();
    await expect(input).not.toHaveValue('');
    // 选完不关：连着挑几个是常态，再点一次表情键才收起
    await expect(panel).toBeVisible();
    await panel.locator('button').nth(1).click();
    const two = await input.inputValue();
    expect(two.length).toBeGreaterThan(1);
    await page.getByTestId('emoji-btn').click();
    await expect(panel).toHaveCount(0);
  });
});
