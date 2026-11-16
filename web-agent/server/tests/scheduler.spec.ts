import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
  test('既有 schema 9 数据库补建续跑计划表', () => {
    const { root, store, file, sessionId } = setup();
    store.close();
    const dbFile = join(root, 'agent.db');
    const raw = new Database(dbFile);
    raw.exec('DROP TABLE scheduled_recovery_jobs_v3; PRAGMA user_version=9');
    raw.close();
    const reopened = new Store(dbFile);
    try {
      const scheduler = new Scheduler(reopened, { file, now: () => 1_000 });
      assert.deepEqual(scheduler.list(), []);
      scheduler.schedule({ sessionId, runId: 'run-1', tenantId: 'default', dueAt: 2_000 });
      assert.equal(scheduler.list().length, 1);
    } finally { reopened.close(); }
  });

  test('旧 schedules.json 导入 SQLite 后归档源文件', () => {
    const { store, file, sessionId } = setup();
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [{
      id: 'legacy-job', sessionId, runId: 'run-1', tenantId: 'default', dueAt: 2_000,
      state: 'done', attempts: 0, createdAt: 1_000, updatedAt: 1_000,
    }] }), 'utf8');
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    assert.equal(scheduler.list()[0]?.id, 'legacy-job');
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.migrated`), true);
    store.close();
  });

  test('显式定时恢复使用同一 RunService 并保留用户角色', async () => {
    const { store, file, sessionId } = setup();
    const calls: unknown[] = [];
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    scheduler.attach({ get: () => ({ id: 'run', sessionId }) as never, resume: (...args) => { calls.push(args); return {} as never; } });
    const job = scheduler.schedule({ sessionId, runId: 'run', tenantId: 'default', principalRole: 'readonly', dueAt: 1_000 });
    await scheduler.tick(); await scheduler.tick();
    assert.deepEqual(calls, [['run', 'default', 'readonly']]);
    assert.equal(scheduler.list()[0]?.state, 'done'); assert.equal(scheduler.list()[0]?.id, job.id);
    store.close();
  });

  test('恢复失败不自动重放，旧 checkpoint 不能执行', async () => {
    const { store, file, sessionId } = setup();
    let calls = 0;
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    scheduler.attach({ get: () => ({ id: 'run', sessionId }) as never, resume: () => { calls++; throw new Error('outcome unknown'); } });
    scheduler.schedule({ sessionId, runId: 'run', tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick(); await scheduler.tick();
    assert.equal(calls, 1); assert.equal(scheduler.list()[0]?.state, 'failed');
    scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    assert.match(scheduler.list()[0]?.lastError ?? '', /checkpoint/);
    assert.equal(calls, 1); store.close();
  });

  test('服务重启后的定时任务需要用户手动恢复', async () => {
    const { store, file, sessionId } = setup();
    const first = new Scheduler(store, { file, now: () => 1_000 });
    first.schedule({ sessionId, runId: 'run', tenantId: 'default', dueAt: 2_000 });
    const restored = new Scheduler(store, { file, now: () => 3_000 });
    await restored.tick();
    assert.equal(restored.list()[0]?.state, 'failed'); assert.match(restored.list()[0]?.lastError ?? '', /手动恢复/);
    store.close();
  });

  test('取消后不再执行', async () => {
    const { store, file, sessionId } = setup();
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    const job = scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    assert.equal(scheduler.cancel(job.id), true); await scheduler.tick();
    assert.equal(scheduler.list()[0]?.state, 'failed'); store.close();
  });
});
