import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../db';
import { Scheduler } from '../scheduler';

const roots: string[] = [];
after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } } });

function setup(): { root: string; store: Store; file: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), 'mh-scheduler-'));
  roots.push(root);
  const store = new Store(join(root, 'agent.db'));
  const session = store.createSession('m');
  store.saveCheckpoint(session.id, 1, [{ role: 'user', content: 'continue' }], 'run-1');
  return { root, store, file: join(root, 'schedules.json'), sessionId: session.id };
}

describe('到点续跑调度器', () => {
  test('到点调用 resume HTTP 并标记完成', async () => {
    const { store, file, sessionId } = setup();
    let calls = 0;
    let body: unknown;
    const scheduler = new Scheduler(store, {
      file, baseUrl: 'http://internal', token: 't', now: () => 1_000,
      fetchImpl: (async (_url, init) => {
        calls++;
        body = JSON.parse(String(init?.body));
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });
    const job = scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    assert.equal(calls, 1);
    assert.deepEqual(body, { resume: true });
    assert.equal(scheduler.list()[0]?.state, 'done');
    assert.equal(scheduler.list()[0]?.id, job.id);
    store.close();
  });

  test('409 有限重试后保持 pending，缺 checkpoint 直接失败', async () => {
    const { store, file, sessionId } = setup();
    const scheduler = new Scheduler(store, {
      file, baseUrl: 'http://internal', now: () => 1_000,
      fetchImpl: (async () => new Response('', { status: 409 })) as typeof fetch,
    });
    scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    const retry = scheduler.list()[0];
    assert.equal(retry?.state, 'pending');
    assert.equal(retry?.attempts, 1);
    assert.ok((retry?.dueAt ?? 0) > 1_000);

    const missing = store.createSession('m');
    scheduler.schedule({ sessionId: missing.id, tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    const failed = scheduler.list().find((job) => job.sessionId === missing.id);
    assert.equal(failed?.state, 'failed');
    assert.match(String(failed?.lastError), /checkpoint/);
    store.close();
  });

  test('取消后不再执行', async () => {
    const { store, file, sessionId } = setup();
    let calls = 0;
    const scheduler = new Scheduler(store, {
      file, baseUrl: 'http://internal', now: () => 1_000,
      fetchImpl: (async () => { calls++; return new Response('', { status: 200 }); }) as typeof fetch,
    });
    const job = scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    assert.equal(scheduler.cancel(job.id), true);
    await scheduler.tick();
    assert.equal(calls, 0);
    assert.equal(scheduler.list()[0]?.state, 'failed');
    store.close();
  });
});
