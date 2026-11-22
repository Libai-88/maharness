import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Kernel } from '../../kernel';
import type { ProviderGateway } from '../../kernel/provider-gateway';
import { Store } from '../db';
import type { UsecaseError } from '../usecases/error';
import { createProvider, providerDiagnostics, providerGateway, removeProvider, testProvider, updateProvider } from '../usecases/providers';

const root = mkdtempSync(join(tmpdir(), 'mh-pusecase-'));
const store = new Store(join(root, 'usecase.db'));
const k0 = { plugins: { resolveService: () => undefined } } as unknown as Kernel;
const deps = { kernel: k0, store };

test.after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function expectUsecase(promise: Promise<unknown> | (() => unknown), status: number, hint: RegExp) {
  await assert.rejects(
    async () => (typeof promise === 'function' ? promise() : promise),
    (error: UsecaseError) => {
      assert.equal(error.status, status);
      assert.match(error.message, hint);
      return true;
    },
  );
}

test('createProvider：必填校验、协议白名单拦截与 ollama 免 Key', async () => {
  await expectUsecase(createProvider(deps, { baseUrl: 'https://example.com' }), 400, /均为必填/);
  await expectUsecase(createProvider(deps, { label: 'x', baseUrl: 'file:///etc/passwd', apiKey: 'k', model: 'm' }), 400, /http|地址/);
  const created = await createProvider(deps, {
    label: '测试供应商',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-create-1',
    model: 'model-z',
    protocol: 'ollama',
    priceIn: '1',
    priceOut: '2',
  });
  assert.equal(created.id.startsWith(''), true);
  assert.equal(created.apiKeyMasked, 'sk-c****te-1');
  const row = store.getProvider(created.id);
  assert.equal(row?.protocol, 'ollama');
  assert.equal(row?.priceIn, 1);
});

test('updateProvider：404 / 428 / 成功改字段 / 过期版本 409', async () => {
  await expectUsecase(updateProvider(deps, 'ghost', {}), 404, /供应商不存在/);
  await expectUsecase(updateProvider(deps, 'pm-ok', {}), 404, /供应商不存在/);
  store.upsertProvider({ id: 'pm-ok', label: '改前', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-old', model: 'm0', protocol: 'openai' });
  const before = store.getProvider('pm-ok')!;
  await expectUsecase(updateProvider(deps, 'pm-ok', { label: '改后' }), 428, /updatedAt/);
  const updated = await updateProvider(deps, 'pm-ok', {
    expectedUpdatedAt: before.updatedAt,
    label: '改后',
    model: 'm1',
    apiKey: '', // 留空 = 不换 Key
    enabled: false,
  });
  assert.equal(updated.label, '改后');
  const row = store.getProvider('pm-ok')!;
  assert.equal(row.apiKey, 'sk-old', 'Key 留空不得被清掉');
  assert.equal(row.enabled, 0);
  await expectUsecase(updateProvider(deps, 'pm-ok', { expectedUpdatedAt: before.updatedAt, label: 'again' }), 409, /其他写入者/);
});

test('removeProvider：404 / 428 / 成功删除并清掉模型', async () => {
  await expectUsecase(() => removeProvider(deps, 'ghost', {}), 404, /供应商不存在/);
  store.upsertProvider({ id: 'pm-del', label: '待删', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm', protocol: 'openai' });
  const row = store.getProvider('pm-del')!;
  await expectUsecase(() => removeProvider(deps, 'pm-del', {}), 428, /updatedAt/);
  store.upsertModels([{ providerId: 'pm-del', modelId: 'm', vision: 0, tools: 0, reasoning: 0, source: 'manual', enabled: 1 }]);
  assert.deepEqual(removeProvider(deps, 'pm-del', { expectedUpdatedAt: row.updatedAt }), { ok: true });
  assert.equal(store.getProvider('pm-del'), undefined);
  assert.deepEqual(store.listModels('pm-del'), []);
});

test('providerDiagnostics / providerGateway：404 与 503 的边界，成功路径读真实行', () => {
  assert.throws(
    () => providerDiagnostics(deps, 'ghost'),
    (error: UsecaseError) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.throws(
    () => providerGateway(deps),
    (error: UsecaseError) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /Gateway/);
      return true;
    },
  );
  const diag = providerDiagnostics(deps, 'pm-ok');
  assert.equal(diag.providerId, 'pm-ok');
  assert.equal(typeof diag.configured.baseUrl, 'boolean');
});

test('testProvider：必填校验、真实往返成功与 401 记失败', async () => {
  await expectUsecase(testProvider(deps, {}), 400, /均为必填/);
  await expectUsecase(testProvider(deps, { baseUrl: 'https://example.com', model: 'm' }), 400, /Key 为必填/);

  const server = createServer((req, res) => {
    const status = req.url?.includes('fail') ? 401 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 5 } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  try {
    const ok = await testProvider(deps, { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-live', model: 'm', protocol: 'openai' });
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.latencyMs, 'number');

    const unauthorized = await testProvider(deps, {
      baseUrl: `http://127.0.0.1:${port}/fail`,
      apiKey: 'sk-bad',
      model: 'm',
      protocol: 'openai',
      providerId: 'pm-ok',
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.authFailed, true);
    assert.match(String(unauthorized.error), /401/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('providerGateway：注入网关后返回快照', () => {
  const gateway = {
    providers: () => [],
    models: () => [],
    health: () => ({ ok: true }),
  } as unknown as ProviderGateway;
  const withGateway = { kernel: { plugins: { resolveService: () => gateway } } as unknown as Kernel, store };
  const snapshot = providerGateway(withGateway);
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.providers, []);
});
