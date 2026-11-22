import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Store } from '../db';
import { sqlitePorts } from '../store/sqlite';
import { WriteQueue, defaultWriteQueue } from '../store/write-queue';

const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

test('单写者：重入不排队，计一次写，深度可观测', () => {
  const queue = new WriteQueue();
  const result = queue.run(() => queue.run(() => 7));
  assert.equal(result, 7);
  const stats = queue.stats();
  assert.equal(stats.writes, 1, '外层事务计一次写');
  assert.equal(stats.maxDepth, 2, '事务内再开事务记录为重入');
  assert.equal(stats.retries, 0);
});

test('单写者：SQLITE_BUSY 只重试一次且成功', () => {
  const queue = new WriteQueue();
  let calls = 0;
  const value = queue.run(() => {
    calls += 1;
    if (calls === 1) throw busy();
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(queue.stats().retries, 1);
  assert.equal(queue.stats().busy, true);
});

test('单写者：非锁错误不重试（避免重复副作用）', () => {
  const queue = new WriteQueue();
  let calls = 0;
  assert.throws(
    () =>
      queue.run(() => {
        calls += 1;
        throw new Error('UNIQUE constraint failed');
      }),
    /UNIQUE constraint failed/,
  );
  assert.equal(calls, 1, '非 SQLITE_BUSY 不重试');
  assert.equal(queue.stats().retries, 0);
});

test('单写者：持续 BUSY 在重试上限后抛错，深度归零', () => {
  const queue = new WriteQueue();
  assert.throws(
    () =>
      queue.run(() => {
        throw busy();
      }),
    /database is locked/,
  );
  assert.equal(queue.stats().retries, 1);
  // 出错后仍能继续接受下一次写（depth 必须复位）
  assert.equal(
    queue.run(() => 1),
    1,
  );
});

test('SQLite 适配器：端口方法绑定到 Store 实例，读路径可用', () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-ports-'));
  const store = new Store(join(root, 'ports.db'));
  try {
    const ports = sqlitePorts(store);
    assert.equal(ports.runs, store.runs, '任务端口直接复用同一仓库实例');
    assert.equal(ports.sessions.getSession('missing'), undefined);
    assert.deepEqual(ports.models.listModels(), []);
    assert.ok(Array.isArray(ports.providers.listProviders()));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('任务仓库的写事务确实经过单写者', () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-queue-'));
  const store = new Store(join(root, 'queue.db'));
  const before = defaultWriteQueue.stats().writes;
  try {
    const value = store.runs.transaction(() => 'through-queue');
    assert.equal(value, 'through-queue');
    assert.equal(defaultWriteQueue.stats().writes, before + 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
