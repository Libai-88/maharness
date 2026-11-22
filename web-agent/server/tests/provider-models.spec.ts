import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { Kernel } from '../../kernel';
import { Store } from '../db';
import { pullModels, readModels, updateModelProfile } from '../usecases/provider-models';
import type { UsecaseError } from '../usecases/error';

const root = mkdtempSync(join(tmpdir(), 'mh-pmodels-'));
const store = new Store(join(root, 'models.db'));
const kernel = { plugins: { resolveService: () => undefined } } as unknown as Kernel;
const deps = { kernel, store };

let server: Server;
let base = '';

async function listen(handler: (url: string) => { status?: number; body: unknown }) {
  server = createServer((req, res) => {
    const { status = 200, body } = handler(req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

after(() => {
  server?.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('pullModels：openai 协议只返回不落库时数据库为空', async () => {
  await listen(() => ({ body: { data: [{ id: 'gpt-a', object: 'model' }, { id: 'gpt-b' }] } }));
  const out = await pullModels(deps, { baseUrl: base, apiKey: 'sk-test', protocol: 'openai', persist: false });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.deepEqual(
    out.models.map((m) => m.id),
    ['gpt-a', 'gpt-b'],
  );
  assert.deepEqual(store.listModels(), []);
  await new Promise<void>((done) => server.close(() => done()));
});

test('pullModels：对已保存供应商默认落库，协议与 Key 取自库中记录', async () => {
  await listen(() => ({ body: { data: [{ id: 'gpt-c', capabilities: { vision: true } }] } }));
  store.upsertProvider({
    id: 'pm-provider',
    label: '本地假服务',
    baseUrl: base,
    apiKey: 'sk-stored',
    model: 'gpt-c',
    protocol: 'openai',
  });
  const out = await pullModels(deps, { providerId: 'pm-provider', baseUrl: base });
  assert.equal(out.count, 1);
  const rows = store.listModels('pm-provider');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelId, 'gpt-c');
  assert.equal(rows[0].source, 'pulled');
  await new Promise<void>((done) => server.close(() => done()));
});

test('pullModels：ollama 允许空 Key，走 /api/tags', async () => {
  await listen((url) => (url.includes('/api/tags') ? { body: { models: [{ name: 'llama3:8b' }] } } : { status: 404, body: {} }));
  const out = await pullModels(deps, { baseUrl: base, protocol: 'ollama', persist: false });
  assert.equal(out.count, 1);
  assert.match(String(out.models[0].id), /llama3/);
  await new Promise<void>((done) => server.close(() => done()));
});

test('pullModels：入参缺失与协议非法都给出 400', async () => {
  await assert.rejects(
    () => pullModels(deps, { protocol: 'openai', apiKey: 'k' }),
    (error: UsecaseError) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /地址为必填/);
      return true;
    },
  );
  await assert.rejects(
    () => pullModels(deps, { baseUrl: 'https://example.com', protocol: 'openai' }),
    (error: UsecaseError) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Key 均为必填/);
      return true;
    },
  );
  await assert.rejects(
    () => pullModels(deps, { baseUrl: 'https://example.com', protocol: 'grpc' }),
    (error: UsecaseError) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /protocol 非法/);
      return true;
    },
  );
});

test('pullModels：空列表与非 2xx 响应都转成 400 而不是泄漏底层错误', async () => {
  await listen(() => ({ body: { data: [] } }));
  await assert.rejects(() => pullModels(deps, { baseUrl: base, apiKey: 'k', protocol: 'openai' }), /响应中没有模型列表/);
  await new Promise<void>((done) => server.close(() => done()));
});

test('readModels：未登记的供应商是 404，成功时带稳定身份与 schema 版本', () => {
  assert.throws(
    () => readModels(store, 'nope'),
    (error: UsecaseError) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
  const out = readModels(store, 'pm-provider');
  assert.equal(out.models[0].providerId, 'pm-provider');
  assert.equal(typeof out.models[0].modelKey, 'string');
});

test('updateModelProfile：版本必填、模型未登记、成功改能力位与来源', () => {
  const rows = store.listModels('pm-provider');
  const modelId = rows[0].modelId;
  assert.throws(
    () => updateModelProfile(deps, 'pm-provider', { model: modelId }, { vision: true }),
    (error: UsecaseError) => {
      assert.equal(error.status, 428);
      return true;
    },
  );
  assert.throws(
    () => updateModelProfile(deps, 'pm-provider', { model: 'ghost' }, { expectedUpdatedAt: 1 }),
    (error: UsecaseError) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
  updateModelProfile(
    deps,
    'pm-provider',
    { model: modelId },
    { expectedUpdatedAt: rows[0].updatedAt, vision: true, tools: true, priceIn: 3 },
  );
  const updated = store.listModels('pm-provider').find((m) => m.modelId === modelId);
  assert.equal(updated?.vision, 1);
  assert.equal(updated?.tools, 1);
  assert.equal(updated?.priceIn, 3);
  assert.equal(updated?.source, 'manual');
  // 用过期版本再写一次必须 409，防止静默覆盖别人的画像
  assert.throws(
    () => updateModelProfile(deps, 'pm-provider', { model: modelId }, { expectedUpdatedAt: rows[0].updatedAt, vision: false }),
    (error: UsecaseError) => {
      assert.equal(error.status, 409);
      return true;
    },
  );
});
