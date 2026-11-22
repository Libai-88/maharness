import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BusEvent, Message, ModelInfo, ProviderDiagnostic, ProviderInfo, Session } from '../../contracts/api';
import { Store } from '../db';
import type { Kernel } from '../../kernel';
import { listChatModels, listProviders, providerDiagnostics } from '../usecases/providers';

const root = mkdtempSync(join(tmpdir(), 'mh-contracts-'));
const store = new Store(join(root, 'test.db'));
const kernel = { plugins: { resolveService: () => undefined } } as unknown as Kernel;
const deps = { kernel, store };

test('会话与消息行满足契约（含侧栏派生字段）', () => {
  const session = store.createSession('test-model', 'test-provider');
  const rows: Session[] = store.listSessions();
  const row = rows.find((item) => item.id === session.id);
  assert.ok(row, '新建会话应出现在列表里');
  assert.equal(typeof row.id, 'string');
  assert.equal(typeof row.title, 'string');
  assert.equal(typeof row.provider, 'string');
  assert.equal(typeof row.planPending, 'number');
  assert.equal(typeof row.archived, 'number');
  assert.equal(typeof row.pinned, 'number');
  assert.equal(typeof row.createdAt, 'number');

  store.addMessage({ sessionId: session.id, role: 'user', content: '契约检查' });
  const messages: Message[] = store.listMessages(session.id);
  const message = messages.find((item) => item.content === '契约检查');
  assert.ok(message);
  assert.equal(message.role, 'user');
  assert.equal(typeof message.createdAt, 'number');
  assert.equal(message.content, '契约检查');
});

test('Provider 列表项满足契约，且密钥只以掩码出现', () => {
  store.upsertProvider({
    id: 'contract-provider',
    label: '契约',
    baseUrl: 'https://example.com',
    apiKey: 'sk-1234567890',
    model: 'model-a',
    protocol: 'openai',
  });
  const rows: ProviderInfo[] = listProviders(deps);
  const row = rows.find((item) => item.id === 'contract-provider');
  assert.ok(row, '新建 Provider 应出现在列表里');
  assert.equal(row.apiKeyMasked, 'sk-1****7890');
  assert.equal(row.hasKey, true);
  assert.equal(typeof row.enabled, 'boolean');
  assert.equal(typeof row.createdAt, 'number');
  assert.ok(Array.isArray(row.models));
  // 契约里不允许出现完整密钥字段：任何键名都不应该是 apiKey
  assert.ok(!Object.hasOwn(row, 'apiKey'), '列表项不得携带原始密钥');
});

test('诊断模型的 capability 位是布尔，而不是存储行的 0/1', () => {
  store.upsertModels([
    {
      providerId: 'contract-provider',
      modelId: 'model-a',
      contextWindow: 128000,
      maxOutput: 8192,
      vision: 1,
      tools: 1,
      reasoning: 0,
      priceIn: 1,
      priceOut: 2,
      source: 'manual',
      enabled: 1,
    },
  ]);
  const diagnostic: ProviderDiagnostic = providerDiagnostics(deps, 'contract-provider');
  assert.equal(diagnostic.providerId, 'contract-provider');
  assert.equal(diagnostic.configured.baseUrl, true);
  const model = diagnostic.models.find((item) => item.modelId === 'model-a');
  assert.ok(model);
  // 服务端真实返回布尔；此前前端把这里写成 number，属于已修的漂移
  assert.equal(typeof model.vision, 'boolean');
  assert.equal(typeof model.tools, 'boolean');
  assert.equal(typeof model.reasoning, 'boolean');
});

test('模型选择器条目满足契约；无对话服务时返回空数组而不是抛错', () => {
  const models: ModelInfo[] = listChatModels(deps);
  assert.deepEqual(models, []);
});

test('事件帧满足契约', () => {
  const event: BusEvent = { type: 'run.completed', traceId: 'run-1', data: { ok: true }, ts: Date.now() };
  assert.equal(typeof event.type, 'string');
  assert.equal(typeof event.ts, 'number');
});

test('契约源保持无 import（生成物才能被前端逐字复制）', () => {
  const source = readFileSync(new URL('../../contracts/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'contracts/api.ts 不得 import 任何模块');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'contracts/api.ts 不得 require');
});

test.after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
