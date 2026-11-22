/** OPS-01 会话租户作用域真实 HTTP 契约。 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'mh-tenant-'));
const dataDir = join(tmp, 'data');
const pluginsDir = join(tmp, 'plugins');
mkdirSync(dataDir, { recursive: true });
mkdirSync(pluginsDir, { recursive: true });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

const port = await freePort();
process.env.PORT = String(port);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_USER_PLUGINS_DIR = pluginsDir;
process.env.SANDBOX_ROOT = join(tmp, 'workspace');
process.env.MAHARNESS_SECRET_KEY_ACL = '0';
process.env.MAHARNESS_MODE = 'local';

const { startServer, tenantFromRequest, TENANT_HEADER } = await import('../index');
const base = `http://127.0.0.1:${port}`;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let sessionA = '';
let sessionDefault = '';

before(async () => {
  started = await startServer();
  if (!started.store.hasTenant('tenant-a')) started.store.createTenant('tenant-a', 'Tenant A');
  sessionA = started.store.createSession('m', '', 'tenant-a').id;
  sessionDefault = started.store.createSession('m').id;
});

after(async () => {
  started?.server.close();
  started?.closeEnvWatcher();
  await started?.runs.shutdown();
  started?.store.close();
  try {
    await started?.kernel.stop();
  } catch {
    /* 清理不影响断言 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('租户作用域 HTTP 契约', () => {
  test('header 解析与非法值回退 default', () => {
    assert.equal(tenantFromRequest({ headers: { [TENANT_HEADER]: 'tenant-a' } }), 'tenant-a');
    assert.equal(tenantFromRequest({ headers: { [TENANT_HEADER]: 'bad tenant' } }), 'default');
  });

  test('列表、消息读取、删除均按租户隔离', async () => {
    const headers = { [TENANT_HEADER]: 'tenant-a' };
    const list = await fetch(`${base}/api/sessions`, { headers });
    const sessions = (await list.json()) as { id: string }[];
    assert.deepEqual(
      sessions.map((s) => s.id),
      [sessionA],
    );

    const defaultList = await fetch(`${base}/api/sessions`);
    const defaults = (await defaultList.json()) as { id: string }[];
    assert.deepEqual(
      defaults.map((s) => s.id),
      [sessionDefault],
    );

    assert.equal((await fetch(`${base}/api/sessions/${sessionDefault}/messages`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/${sessionA}/messages`, { headers })).status, 200);

    assert.equal(
      (
        await fetch(`${base}/api/sessions/${sessionA}`, {
          method: 'DELETE',
          headers: { [TENANT_HEADER]: 'tenant-b' },
        })
      ).status,
      404,
    );
    assert.equal((await fetch(`${base}/api/sessions/${sessionA}/messages`, { headers })).status, 200);
    assert.equal(
      (
        await fetch(`${base}/api/sessions/${sessionA}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
      200,
    );
  });

  test('租户注册表：默认租户存在，可创建新租户，未知租户 404', async () => {
    const list = (await (await fetch(`${base}/api/tenants`)).json()) as { current: string; tenants: { id: string }[] };
    assert.equal(list.current, 'default');
    assert.ok(list.tenants.some((tenant) => tenant.id === 'default'));

    const created = await fetch(`${base}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tenant-c', name: 'Tenant C', maxSessions: 5, maxActiveRuns: 2 }),
    });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { id: string; name: string; maxSessions: number; maxActiveRuns: number };
    assert.equal(body.id, 'tenant-c');
    assert.equal(body.maxSessions, 5);
    assert.equal(body.maxActiveRuns, 2);

    const sessions = await fetch(`${base}/api/sessions`, { headers: { [TENANT_HEADER]: 'tenant-c' } });
    assert.deepEqual(await sessions.json(), []);
    assert.equal((await fetch(`${base}/api/sessions`, { headers: { [TENANT_HEADER]: 'missing-tenant' } })).status, 404);
  });

  test('租户会话配额：达到上限后返回 429，其他租户不受影响', async () => {
    const created = await fetch(`${base}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tenant-quota', name: 'Quota', maxSessions: 1 }),
    });
    assert.equal(created.status, 200);
    assert.equal(((await created.json()) as { maxSessions: number }).maxSessions, 1);
    const headers = { 'Content-Type': 'application/json', [TENANT_HEADER]: 'tenant-quota' };
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ model: 'm' }) })).status, 200);
    const denied = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ model: 'm' }) });
    assert.equal(denied.status, 429);
    assert.match(String(((await denied.json()) as { error: string }).error), /配额/);
    assert.equal(
      (
        await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [TENANT_HEADER]: 'default' },
          body: JSON.stringify({ model: 'm' }),
        })
      ).status,
      200,
    );
  });

  test('文件 API 按租户根隔离，A 的文件不出现在 default 树中', async () => {
    const aHeaders = { [TENANT_HEADER]: 'tenant-a', 'Content-Type': 'application/json' };
    const dHeaders = { 'Content-Type': 'application/json' };
    const write = (headers: Record<string, string>, path: string, content: string) =>
      fetch(`${base}/api/files/write`, { method: 'POST', headers, body: JSON.stringify({ path, content }) });
    assert.equal((await write(aHeaders, 'only-a.txt', 'tenant-a')).status, 200);
    assert.equal((await write(dHeaders, 'only-default.txt', 'tenant-default')).status, 200);

    const aRead = await fetch(`${base}/api/files/read?path=only-a.txt`, { headers: { [TENANT_HEADER]: 'tenant-a' } });
    assert.equal(aRead.status, 200);
    assert.equal(((await aRead.json()) as { text: string }).text, 'tenant-a');
    assert.equal((await fetch(`${base}/api/files/read?path=only-a.txt`)).status, 404);

    const aTree = (await (await fetch(`${base}/api/files/tree`, { headers: { [TENANT_HEADER]: 'tenant-a' } })).json()) as {
      entries: { name: string }[];
    };
    assert.ok(aTree.entries.some((entry) => entry.name === 'only-a.txt'));
    assert.equal(
      aTree.entries.some((entry) => entry.name === 'only-default.txt'),
      false,
    );
  });

  test('统计接口暴露当前租户与生态健康快照', async () => {
    started!.store.createSession('m', '', 'tenant-a');
    const res = await fetch(`${base}/api/stats`, { headers: { [TENANT_HEADER]: 'tenant-a' } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ecosystem: {
        tenant: { id: string; sessions: number };
        plugins: { total: number; started: number; error: number };
        mcp: unknown;
      };
    };
    assert.equal(body.ecosystem.tenant.id, 'tenant-a');
    assert.equal(body.ecosystem.tenant.sessions, 1);
    assert.ok(body.ecosystem.plugins.total > 0);
    assert.ok(body.ecosystem.plugins.started > 0);
    assert.ok(body.ecosystem.mcp === null || Array.isArray(body.ecosystem.mcp));
  });

  test('租户存储配额：超额写入 413，调高后可继续写', async () => {
    const created = await fetch(`${base}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tenant-storage', name: 'Storage', maxStorageBytes: 20 }),
    });
    assert.equal(created.status, 200);
    const headers = { 'Content-Type': 'application/json', [TENANT_HEADER]: 'tenant-storage' };
    const small = await fetch(`${base}/api/files/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'small.txt', content: '12345' }),
    });
    assert.equal(small.status, 200);
    const blocked = await fetch(`${base}/api/files/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'large.txt', content: 'x'.repeat(40) }),
    });
    assert.equal(blocked.status, 413);
    const blockedBody = (await blocked.json()) as { code?: string };
    assert.equal(blockedBody.code, 'TENANT_STORAGE_QUOTA');
    const patched = await fetch(`${base}/api/tenants/tenant-storage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxStorageBytes: 1000 }),
    });
    assert.equal(patched.status, 200);
    const allowed = await fetch(`${base}/api/files/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'large.txt', content: 'x'.repeat(40) }),
    });
    assert.equal(allowed.status, 200);
  });

  test('到点续跑计划按租户隔离并可取消', async () => {
    const session = started!.store.createSession('m', '', 'tenant-a');
    const runId = 'run-schedule';
    started!.store.runs.create({
      id: runId,
      rootId: runId,
      sessionId: session.id,
      tenantId: 'tenant-a',
      depth: 0,
      objective: 'continue',
      providerId: 'm',
      model: 'm',
      status: 'interrupted',
      authorization: { workspace: tmp, profile: 'standard', revision: 0, readOnly: false },
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    started!.store.runs.saveCheckpoint(runId, { turn: 0, history: [{ role: 'user', content: 'continue' }], costUsd: 0, toolResults: [] });
    const headers = { 'Content-Type': 'application/json', [TENANT_HEADER]: 'tenant-a' };
    const created = await fetch(`${base}/api/sessions/${session.id}/resume-at`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId, delayMs: 3_600_000 }),
    });
    assert.equal(created.status, 200);
    const job = (await created.json()) as { id: string; state: string };
    assert.equal(job.state, 'pending');
    const list = await fetch(`${base}/api/schedules`, { headers: { [TENANT_HEADER]: 'tenant-a' } });
    const jobs = (await list.json()) as { id: string }[];
    assert.ok(jobs.some((item) => item.id === job.id));
    const other = await fetch(`${base}/api/schedules`, { headers: { [TENANT_HEADER]: 'default' } });
    const otherJobs = (await other.json()) as { id: string }[];
    assert.equal(
      otherJobs.some((item) => item.id === job.id),
      false,
    );
    const cancelled = await fetch(`${base}/api/schedules/${job.id}`, {
      method: 'DELETE',
      headers: { [TENANT_HEADER]: 'tenant-a' },
    });
    assert.equal(cancelled.status, 200);
  });

  test('审批审计历史按租户与会话过滤', async () => {
    const session = started!.store.createSession('m', '', 'tenant-a');
    started!.store.saveApprovalRequest({
      id: 'history-ap-1',
      sessionId: session.id,
      tenantId: 'tenant-a',
      name: 'write_file',
      summary: '写入',
      createdAt: 100,
      expiresAt: 200,
    });
    const res = await fetch(`${base}/api/approvals/history?sessionId=${session.id}`, {
      headers: { [TENANT_HEADER]: 'tenant-a' },
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { id: string }[];
    assert.ok(rows.some((row) => row.id === 'history-ap-1'));
    const foreign = await fetch(`${base}/api/approvals/history?sessionId=${session.id}`, {
      headers: { [TENANT_HEADER]: 'default' },
    });
    assert.equal(foreign.status, 404);
  });

  test('租户成本配额超限时拒绝新的对话任务', async () => {
    const created = await fetch(`${base}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tenant-cost', name: 'Cost', maxCostUsd: 0.001 }),
    });
    assert.equal(created.status, 200);
    started!.store.upsertProvider({
      id: 'tenant-cost-provider',
      label: 'Tenant cost fixture',
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: '',
      model: 'fixture-model',
      priceIn: 1,
      priceOut: 1,
    });
    const chat = started!.kernel.plugins.resolveService('service:chat') as {
      providers: Array<{ id: string; label: string; defaultModel: string; chat: () => AsyncGenerator<never> }>;
    };
    chat.providers = [
      {
        id: 'tenant-cost-provider',
        label: 'Tenant cost fixture',
        defaultModel: 'fixture-model',
        async *chat() {},
      },
    ];
    const session = started!.store.createSession('tenant-cost-provider', 'fixture-model', 'tenant-cost');
    started!.store.addMessage({ sessionId: session.id, role: 'assistant', content: 'costly', cost: 0.002 });
    const headers = { 'Content-Type': 'application/json', [TENANT_HEADER]: 'tenant-cost' };
    const res = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: '继续' }),
    });
    assert.equal(res.status, 429);
    assert.match(String(((await res.json()) as { error: string }).error), /费用配额/);
  });
});
