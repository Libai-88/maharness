import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionPool } from '../execution-pool';

test('execution capacity queues fairly across roots and releases exactly once', async () => {
  const pool = new ExecutionPool(1);
  const release = await pool.acquire('a');
  const first = pool.acquire('a'); const second = pool.acquire('b'); const third = pool.acquire('a');
  assert.equal(pool.queued, 3);
  release(); release(); const releaseFirst = await first; releaseFirst();
  const releaseSecond = await second; releaseSecond(); const releaseThird = await third; releaseThird();
  assert.equal(pool.occupied, 0); assert.equal(pool.queued, 0);
});
test('cancelled queued operations never occupy a slot', async () => {
  const pool = new ExecutionPool(1); const release = await pool.acquire('a');
  const abort = new AbortController(); const pending = pool.acquire('b', abort.signal);
  abort.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(pool.queued, 0); release(); assert.equal(pool.occupied, 0);
});
