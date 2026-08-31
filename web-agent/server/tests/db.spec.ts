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
import { encryptSecret, decryptSecret, isEncrypted } from '../secrets';

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

describe('Store api_key 加密存储（R1）', () => {
  const KEY = Buffer.from('ab'.repeat(32), 'hex'); // 32 字节
  const OTHER_KEY = Buffer.from('cd'.repeat(32), 'hex');

  test('带主密钥：落库为密文、读取解密还原（每行加密随机化）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-db-sec-'));
    try {
      const store = new Store(join(root, 'sec.db'), { secretKey: KEY });
      store.upsertProvider({ id: 'p1', label: 'P', baseUrl: 'https://x.example', apiKey: 'sk-secret-123', model: 'm' });
      assert.equal(store.getProvider('p1')?.apiKey, 'sk-secret-123', '读取应解密还原');

      // 直查原始表（无密钥的只读 Store）：密文落库
      const raw = new Store(join(root, 'sec.db'));
      try {
        assert.equal(isEncrypted(raw.getProvider('p1')?.apiKey ?? ''), true, 'DB 中应为密文');
        assert.notEqual(raw.getProvider('p1')?.apiKey, 'sk-secret-123');
      } finally { raw.close(); }
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('自动迁移：已有明文 api_key 在带主密钥启动时加密（幂等）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-db-mig-'));
    try {
      const plain = new Store(join(root, 'mig.db'));
      plain.upsertProvider({ id: 'p1', label: 'P', baseUrl: 'https://x.example', apiKey: 'sk-legacy', model: 'm' });
      plain.close();

      const migrated = new Store(join(root, 'mig.db'), { secretKey: KEY });
      assert.equal(migrated.getProvider('p1')?.apiKey, 'sk-legacy', '迁移后可解密读取');
      const readBack = new Store(join(root, 'mig.db'));
      try {
        assert.equal(isEncrypted(readBack.getProvider('p1')?.apiKey ?? ''), true, '落库已为密文');
      } finally { readBack.close(); }
      migrated.close();

      const again = new Store(join(root, 'mig.db'), { secretKey: KEY });
      try {
        assert.equal(again.getProvider('p1')?.apiKey, 'sk-legacy', '重复迁移幂等');
      } finally { again.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('密钥不符：解密失败返回空 key（Provider 不可用但不崩服务）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-db-key-'));
    try {
      const store = new Store(join(root, 'k.db'), { secretKey: KEY });
      store.upsertProvider({ id: 'p1', label: 'P', baseUrl: 'https://x.example', apiKey: 'sk-x', model: 'm' });
      store.close();

      const other = new Store(join(root, 'k.db'), { secretKey: OTHER_KEY });
      assert.equal(other.getProvider('p1')?.apiKey, '', '密钥不符解密失败置空');
      other.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('encryptSecret/decryptSecret 密码学往返（GCM：每次 IV 随机）', () => {
    const KEY1 = KEY;
    const blob = encryptSecret('hello-凭据', KEY1);
    assert.equal(isEncrypted(blob), true);
    assert.equal(blob.startsWith('v1:'), true);
    assert.equal(decryptSecret(blob, KEY1), 'hello-凭据');
    assert.notEqual(encryptSecret('hello-凭据', KEY1), blob, '相同明文两次加密密文不同');
  });
});