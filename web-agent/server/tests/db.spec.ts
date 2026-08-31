/**
 * server/tests/db.spec.ts —— Store 会话/断点生命周期回归测试
 * 覆盖：deleteSession/deleteSessions 级联清理 agent_checkpoints（修复前删除
 * 会话留下孤儿断点，resume=true 会"复活"已删会话）；/clear（clearSessionMessages）
 * 同样清断点。
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../db';

const roots: string[] = [];

function newStore(): { store: Store; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mh-db-'));
  roots.push(root);
  const store = new Store(join(root, 'test.db'));
  return { store, cleanup: () => { store.close(); } };
}

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄迟释放 */ }
  }
});

describe('Store 级联清理（会话 ↔ 断点）', () => {
  test('deleteSession 删除会话同时清理 checkpoint（无孤儿）', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      store.saveCheckpoint(s.id, 2, [{ role: 'user', content: '继续', tool_calls: undefined }]);
      assert.equal(store.loadCheckpoint(s.id) !== undefined, true);

      store.deleteSession(s.id);
      assert.equal(store.getSession(s.id), undefined);
      assert.equal(store.loadCheckpoint(s.id), undefined, '删除会话应级联清理断点');
    } finally { cleanup(); }
  });

  test('deleteSessions 批量删除同步清理全部断点', () => {
    const { store, cleanup } = newStore();
    try {
      const a = store.createSession('m');
      const b = store.createSession('m');
      store.saveCheckpoint(a.id, 1, [{ role: 'user', content: 'a' }]);
      store.saveCheckpoint(b.id, 1, [{ role: 'user', content: 'b' }]);

      store.deleteSessions([a.id, b.id]);
      assert.equal(store.loadCheckpoint(a.id), undefined);
      assert.equal(store.loadCheckpoint(b.id), undefined);
    } finally { cleanup(); }
  });

  test('clearSessionMessages（/clear）清消息同时清理断点：清空后 resume 不再复活旧任务', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      store.saveCheckpoint(s.id, 3, [{ role: 'user', content: '任务进行中' }]);

      store.clearSessionMessages(s.id);
      assert.equal(store.getSession(s.id) !== undefined, true, '会话本身保留');
      assert.equal(store.loadCheckpoint(s.id), undefined, '/clear 应清理断点');
    } finally { cleanup(); }
  });
});