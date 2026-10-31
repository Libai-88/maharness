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
import { ConcurrentStoreWriteError, Store } from '../db';
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
  test('授权审计有限保留并在 Store 重开后可查询', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-auth-audit-'));
    const dbPath = join(root, 'audit.db');
    const store = new Store(dbPath);
    store.appendAuthorizationAudit({
      outcome: 'denied', subject: 'anonymous', capability: 'http:post',
      object: '/api/workspaces', reason: 'api-token-required', occurredAt: 1234,
    });
    store.close();
    try {
      const reopened = new Store(dbPath);
      try {
        assert.deepEqual(reopened.listAuthorizationAudit(1), [{
          id: 1, occurredAt: 1234, outcome: 'denied', subject: 'anonymous',
          capability: 'http:post', object: '/api/workspaces', reason: 'api-token-required',
        }]);
        assert.equal(reopened.listAuthorizationAudit(0).length, 1, 'limit 下限为 1');
        assert.equal(reopened.listAuthorizationAudit(9999).length, 1, '读取上限安全裁剪');
      } finally { reopened.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('任务验收与 Trace 引用在 Store 重开后保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-task-verification-'));
    const dbPath = join(root, 'task.db');
    const store = new Store(dbPath);
    const session = store.createSession('m');
    const message = store.addMessage({ sessionId: session.id, role: 'assistant', content: '部分完成' });
    store.updateMessageTaskVerification(message.id, {
      status: 'partial', objective: '完成两项',
      checks: [{ ok: true, reason: '文件存在' }, { ok: false, reason: '工具未成功' }],
      evidence: [{ source: 'filesystem', detail: 'out.txt 存在', traceStepId: 'trace-step-1' }],
    });
    store.close();
    try {
      const reopened = new Store(dbPath);
      try {
        assert.deepEqual(reopened.listMessages(session.id)[0]?.taskVerification, {
          status: 'partial', objective: '完成两项',
          checks: [{ ok: true, reason: '文件存在' }, { ok: false, reason: '工具未成功' }],
          evidence: [{ source: 'filesystem', detail: 'out.txt 存在', traceStepId: 'trace-step-1' }],
        });
      } finally { reopened.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('checkpoint 保存 runId，工具账本完成后可安全回放，pending 不可冒充完成', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      store.saveCheckpoint(s.id, 2, [{ role: 'user', content: '继续' }], 'run-1');
      assert.equal(store.loadCheckpoint(s.id)?.runId, 'run-1');
      assert.equal(store.loadCheckpoint(s.id)?.schemaVersion, Store.CHECKPOINT_SCHEMA_VERSION);
      const first = store.claimToolEffect('run-1', '2:0:write_file:abc');
      assert.equal(first.state, 'new');
      assert.equal(store.hasPendingToolEffects('run-1'), true);
      const result = { ok: true, data: { written: true } };
      store.completeToolEffect('run-1', '2:0:write_file:abc', result);
      const replay = store.claimToolEffect('run-1', '2:0:write_file:abc');
      assert.equal(replay.state, 'done');
      assert.deepEqual(replay.result, result);
      assert.equal(store.hasPendingToolEffects('run-1'), false);
      assert.equal(store.claimToolEffect('run-1', '2:1:send_http:def').state, 'new');
      assert.equal(store.claimToolEffect('run-1', '2:1:send_http:def').state, 'pending');
      assert.equal(store.hasPendingToolEffects('run-1'), true);
    } finally { cleanup(); }
  });

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

  test('checkpoint 同时受消息数和 JSON 字节上限约束，并保留截断标记', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      const history = Array.from({ length: Store.MAX_CHECKPOINT_HISTORY + 40 }, (_, i) => ({
        role: 'user', content: `${i}:${'x'.repeat(4000)}`,
      }));
      store.saveCheckpoint(s.id, 9, history, 'bounded-run');
      const cp = store.loadCheckpoint(s.id)!;
      assert.equal(cp.truncated, true);
      assert.equal(cp.originalLength, history.length);
      assert.ok(cp.history.length <= Store.MAX_CHECKPOINT_HISTORY);
      assert.ok(JSON.stringify({ messages: cp.history }).length <= Store.MAX_CHECKPOINT_BYTES);
      assert.equal(cp.history.at(-1)?.content, history.at(-1)?.content);
    } finally { cleanup(); }
  });

  test('checkpoint 兼容旧版直接消息数组格式', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('INSERT INTO agent_checkpoints (session_id, turn, history, created_at) VALUES (?,?,?,?)')
        .run(s.id, 1, JSON.stringify([{ role: 'user', content: 'legacy' }]), Date.now());
      assert.deepEqual(store.loadCheckpoint(s.id)?.history, [{ role: 'user', content: 'legacy' }]);
      assert.equal(store.loadCheckpoint(s.id)?.schemaVersion, 0);
    } finally { cleanup(); }
  });

  test('未知 checkpoint schema 版本 fail-closed 并清理断点', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('INSERT INTO agent_checkpoints (session_id, turn, history, created_at) VALUES (?,?,?,?)')
        .run(s.id, 1, JSON.stringify({ schemaVersion: 99, messages: [{ role: 'user', content: 'unknown' }] }), Date.now());
      assert.equal(store.loadCheckpoint(s.id), undefined);
      assert.equal(store.loadCheckpoint(s.id), undefined);
    } finally { cleanup(); }
  });

  test('超过默认保留期的 checkpoint 不可恢复并会清理副作用账本', () => {
    const { store, cleanup } = newStore();
    try {
      const s = store.createSession('m');
      store.saveCheckpoint(s.id, 1, [{ role: 'user', content: 'expired' }], 'expired-run');
      store.claimToolEffect('expired-run', 'effect');
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('UPDATE agent_checkpoints SET created_at = ? WHERE session_id = ?')
        .run(Date.now() - Store.CHECKPOINT_RETENTION_MS - 1, s.id);
      assert.equal(store.loadCheckpoint(s.id), undefined);
      assert.equal(store.hasPendingToolEffects('expired-run'), false);
    } finally { cleanup(); }
  });

  test('checkpoint 保留期可配置并在 Store 重开后按新策略恢复', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-db-retention-'));
    const dbPath = join(root, 'retention.db');
    const first = new Store(dbPath, { checkpointRetentionMs: 2 * 24 * 60 * 60 * 1000 });
    const s = first.createSession('m');
    first.saveCheckpoint(s.id, 1, [{ role: 'user', content: 'kept' }]);
    (first as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare('UPDATE agent_checkpoints SET created_at = ? WHERE session_id = ?')
      .run(Date.now() - 24 * 60 * 60 * 1000, s.id);
    first.close();
    const reopened = new Store(dbPath, { checkpointRetentionMs: 2 * 24 * 60 * 60 * 1000 });
    try { assert.equal(reopened.loadCheckpoint(s.id)?.history[0]?.content, 'kept'); }
    finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('模型路由画像写入模型表并在 Store 重开后保留', () => {
    const { store, cleanup } = newStore();
    try {
      store.upsertModel({ providerId: 'p', modelId: 'm', vision: 1, tools: 1, reasoning: 0, latencyMs: 120, privacyTier: 'local', riskLevel: 'low' });
      const row = store.listModels('p')[0];
      assert.equal(row?.latencyMs, 120);
      assert.equal(row?.privacyTier, 'local');
      assert.equal(row?.riskLevel, 'low');
    } finally { cleanup(); }
  });

  test('模型目录批量写入事务失败时整体回滚', () => {
    const { store, cleanup } = newStore();
    try {
      assert.throws(() => store.upsertModels([
        { providerId: 'p', modelId: 'good', vision: 1 },
        { providerId: 'p', modelId: null as unknown as string, vision: 1 },
      ]));
      assert.deepEqual(store.listModels(), [], '第二行失败时第一行也必须回滚');
    } finally { cleanup(); }
  });

  test('Provider 乐观版本校验拒绝陈旧写入并保留最新值', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-db-concurrent-'));
    const dbPath = join(root, 'concurrent.db');
    const first = new Store(dbPath);
    const second = new Store(dbPath);
    try {
      first.upsertProvider({ id: 'p', label: 'P', baseUrl: 'https://x.example', apiKey: 'k', model: 'm' });
      const snapshot = second.getProvider('p')!;
      first.upsertProvider({ id: 'p', label: 'P1', baseUrl: 'https://x.example', apiKey: 'k', model: 'm', expectedUpdatedAt: snapshot.updatedAt });
      assert.throws(() => second.upsertProvider({ id: 'p', label: 'stale', baseUrl: 'https://x.example', apiKey: 'k', model: 'm', expectedUpdatedAt: snapshot.updatedAt }),
        (error: unknown) => error instanceof ConcurrentStoreWriteError && error.code === 'concurrent_write');
      assert.equal(first.getProvider('p')?.label, 'P1');
    } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
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
