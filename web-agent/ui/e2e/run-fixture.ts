import { expect, type Page, type Route } from '@playwright/test';
import type { RunInfo } from '../src/run-api';
import type { Material } from '../src/material-api';

type Fixture = {
  runs: Map<string, RunInfo>;
  events: Map<string, string>;
  materials: Map<string, Material>;
  handler?: (route: Route) => unknown;
  creates: number;
  subscriptions: number;
};
const fixtures = new WeakMap<Page, Fixture>();

export async function installRunMocks(page: Page) {
  const existing = fixtures.get(page);
  if (existing) return existing;
  const fixture: Fixture = { runs: new Map(), events: new Map(), materials: new Map(), creates: 0, subscriptions: 0 };
  fixtures.set(page, fixture);
  await page.route('**/api/v2/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/');
    const method = request.method();
    const id = parts[4];
    if (url.pathname === '/api/v2/runs')
      return route.fulfill({
        json: [...fixture.runs.values()]
          .filter((run) => !url.searchParams.has('sessionId') || run.sessionId === url.searchParams.get('sessionId'))
          .reverse(),
      });
    if (parts[3] === 'sessions' && parts[5] === 'runs') {
      fixture.creates++;
      let response: Parameters<Route['fulfill']>[0] | undefined;
      if (fixture.handler)
        await fixture.handler(
          new Proxy(route, {
            get(target, property) {
              if (property === 'fulfill')
                return async (options: Parameters<Route['fulfill']>[0]) => {
                  response = options;
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        );
      if (response?.status && response.status >= 400) return route.fulfill(response);
      const body = request.postDataJSON() as { message: string; materials?: { id: string; version: string }[] };
      const run: RunInfo = {
        id: `fixture-${fixture.creates}`,
        sessionId: id,
        objective: body.message,
        providerId: 'e2e-provider',
        model: 'e2e-model',
        status: 'running',
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        authorization: { workspace: 'fixture', profile: 'standard', readOnly: false, revision: 0 },
      };
      if (body.materials?.length)
        run.materials = body.materials.flatMap((ref) => (fixture.materials.has(ref.id) ? [fixture.materials.get(ref.id)!] : []));
      const blocks = String(response?.body ?? '')
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean);
      const numbered: string[] = [];
      for (const block of blocks) {
        const event = block.match(/event:\s*(.*)/)?.[1];
        if (!event || event === 'end') continue;
        const data = JSON.parse(
          block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5))
            .join('\n') || '{}',
        );
        if (event === 'done') {
          run.status = 'completed';
          run.answer = data.content;
        }
        if (event === 'error') {
          run.status = data.kind === 'max-turns' || data.kind === 'deadline' ? 'interrupted' : 'failed';
          run.error = data.error;
        }
        numbered.push(`id: ${numbered.length + 1}\n${block}\n\n`);
      }
      fixture.runs.set(run.id, run);
      fixture.events.set(run.id, numbered.join(''));
      return route.fulfill({ status: 202, json: { runId: run.id, run } });
    }
    const run = fixture.runs.get(id);
    if (!run) return route.fulfill({ status: 404, json: { error: '任务不存在' } });
    if (parts[5] === 'events') {
      fixture.subscriptions++;
      const after = Number(request.headers()['last-event-id'] ?? 0);
      const events = (fixture.events.get(id) ?? '')
        .split(/\n\n/)
        .filter((block) => Number(block.match(/id:\s*(\d+)/)?.[1]) > after)
        .join('\n\n');
      return route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: `${events}\n\n` });
    }
    if (parts[5] === 'cancel') {
      run.status = 'cancelled';
      run.error = '已停止';
      return route.fulfill({ json: run });
    }
    if (parts[5] === 'messages') return route.fulfill({ status: 202, json: { messageId: 'supplement' } });
    if (parts[5] === 'resume') {
      run.status = 'completed';
      run.answer = '恢复后的答复。';
      run.error = undefined;
      const cursor = 100;
      fixture.events.set(
        id,
        `id: 101\nevent: done\ndata: ${JSON.stringify({ content: run.answer, usage: { input: 12, output: 6 }, cost: 0 })}\n\n`,
      );
      return route.fulfill({ status: 202, json: { ...run, eventCursor: cursor } });
    }
    if (parts[5]) return route.fulfill({ json: [] });
    return route.fulfill({ json: run });
  });
  return fixture;
}

export async function mockTaskEvents(page: Page, handler: (route: Route) => unknown) {
  (await installRunMocks(page)).handler = handler;
}

export async function mockLiveTaskEvents(page: Page) {
  await mockTaskEvents(page, (route) => route.fulfill({ body: '' }));
  // The live browser stream owns terminal frames; the model execution is still unique.
  await page.route('**/api/v2/runs/fixture-*', async (route) => {
    if (!/\/runs\/fixture-\d+$/.test(new URL(route.request().url()).pathname)) return route.fallback();
    const fixture = fixtures.get(page)!;
    const run = fixture.runs.get(new URL(route.request().url()).pathname.split('/').pop()!);
    const completed = await page.evaluate(() => !!(window as unknown as { liveTaskDone?: boolean }).liveTaskDone);
    return route.fulfill({ json: completed && run ? { ...run, status: 'completed' } : run });
  });
}

export const chatPlaceholder = '跟 maharness 说点什么…（按 / 看命令）';

/** 通用的任务页夹具：装好运行态 mock、会话与模型接口，再进入首页。 */
export async function setupTaskPage(page: Page, mode = 'normal') {
  const fixture = await installRunMocks(page);
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      json: [{ id: 'task-session', title: '任务测试', model: 'e2e-model', provider: 'e2e-provider', mode, createdAt: 0, updatedAt: 0 }],
    }),
  );
  await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: [{ id: 'e2e-provider@e2e-model', provider: 'e2e-provider', label: 'E2E Model', model: 'e2e-model' }] }),
  );
  await page.route('**/api/providers', (route) =>
    route.fulfill({ json: [{ id: 'e2e-provider', label: 'E2E Provider', model: 'e2e-model', enabled: true, hasKey: true }] }),
  );
  await page.route('**/api/events', (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }));
  await page.route('**/api/plugins/goal-plan/plan*', (route) => route.fulfill({ json: { plan: null } }));
  await page.goto('/');
  await expect(page.getByPlaceholder(chatPlaceholder)).toBeEnabled();
  return fixture;
}

export async function sendTask(page: Page, text: string) {
  await page.getByPlaceholder(chatPlaceholder).fill(text);
  await page.getByPlaceholder(chatPlaceholder).press('Enter');
}

export function frames(events: [string, unknown][]) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
