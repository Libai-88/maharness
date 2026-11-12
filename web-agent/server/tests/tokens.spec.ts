import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'mh-tokens-'));
const dataDir = join(tmp, 'data');
const pluginsDir = join(tmp, 'plugins');
mkdirSync(dataDir, { recursive: true });
mkdirSync(pluginsDir, { recursive: true });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const port = await freePort();
process.env.PORT = String(port);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_USER_PLUGINS_DIR = pluginsDir;
process.env.SANDBOX_ROOT = join(tmp, 'workspace');
process.env.MAHARNESS_SECRET_KEY_ACL = '0';
process.env.MAHARNESS_MODE = 'trusted';
process.env.MAHARNESS_API_TOKEN = 'admin-secret';

const { startServer, TENANT_HEADER, MUTATION_TOKEN_HEADER } = await import('../index');
const base = `http://127.0.0.1:${port}`;
let started: Awaited<ReturnType<typeof startServer>> | undefined;

before(async () => {
  started = await startServer();
  for (const id of ['team-a', 'team-b']) {
    if (!started.store.hasTenant(id)) started.store.createTenant(id, id);
  }
});

after(async () => {
  started?.server.close();
  started?.closeEnvWatcher();
  started?.store.close();
  try { await started?.kernel.stop(); } catch { /* 清理不影响断言 */ }
  rmSync(tmp, { recursive: true, force: true });
});

const admin = { [MUTATION_TOKEN_HEADER]: 'admin-secret' };

async function createToken(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const res = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return await res.json() as { id: string; token: string };
}

describe('租户 API token / principal', () => {
  test('member token 绑定租户、不可横穿、不可管理 token', async () => {
    const created = await createToken({ tenantId: 'team-a', role: 'member', label: 'A member' });
    const headers = { [MUTATION_TOKEN_HEADER]: created.token };
    const own = await fetch(`${base}/api/sessions`, { headers });
    assert.equal(own.status, 200);
    const foreign = await fetch(`${base}/api/sessions`, {
      headers: { ...headers, [TENANT_HEADER]: 'team-b' },
    });
    assert.equal(foreign.status, 403);
    const list = await fetch(`${base}/api/tokens`, { headers });
    assert.equal(list.status, 403);
  });

  test('member 不能修改共享基础设施，但可在本租户创建会话', async () => {
    const created = await createToken({ tenantId: 'team-a', role: 'member' });
    const headers = { [MUTATION_TOKEN_HEADER]: created.token, 'Content-Type': 'application/json' };
    const providerWrite = await fetch(`${base}/api/providers`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'x', label: 'X', baseUrl: 'https://x', apiKey: 'k', model: 'm' }),
    });
    assert.equal(providerWrite.status, 403);
    const providerRead = await fetch(`${base}/api/providers`, { headers });
    assert.equal(providerRead.status, 200);
    const tenants = await fetch(`${base}/api/tenants`, { headers });
    assert.equal(tenants.status, 403);
    const session = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'member session' }),
    });
    assert.equal(session.status, 200);
  });

  test('readonly token 不能执行变更请求', async () => {
    const created = await createToken({ tenantId: 'team-a', role: 'readonly' });
    const res = await fetch(`${base}/api/files/write`, {
      method: 'POST',
      headers: { [MUTATION_TOKEN_HEADER]: created.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'x.txt', content: 'x' }),
    });
    assert.equal(res.status, 403);
  });

  test('吊销后 token 立即失效', async () => {
    const created = await createToken({ tenantId: 'team-a', role: 'member' });
    const revoked = await fetch(`${base}/api/tokens/${created.id}`, { method: 'DELETE', headers: admin });
    assert.equal(revoked.status, 200);
    const denied = await fetch(`${base}/api/sessions`, {
      headers: { [MUTATION_TOKEN_HEADER]: created.token },
    });
    assert.equal(denied.status, 401);
  });

  test('数据库只保存 token 哈希，列表不回显 token', async () => {
    const created = await createToken({ tenantId: 'team-a', role: 'member' });
    const list = await fetch(`${base}/api/tokens?tenantId=team-a`, { headers: admin });
    const rows = await list.json() as { id: string; token?: string }[];
    const row = rows.find((item) => item.id === created.id);
    assert.ok(row);
    assert.equal(row.token, undefined);
    const raw = started!.store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } };
    const stored = raw.db.prepare('SELECT token_hash AS hash FROM api_tokens WHERE id = ?').get(created.id) as { hash: string };
    assert.match(stored.hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.hash, created.token);
  });
});
