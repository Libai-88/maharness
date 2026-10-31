/** Provider 诊断路由的真实 HTTP 契约测试。 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderDef, ToolContext } from '../../kernel/types';
import { validateTraceSteps } from '../../kernel/trace';
import { LLMHttpError } from '../../core/chat/provider-health';
import { redactTraceValue } from '../../core/chat/agent';

const tmp = mkdtempSync(join(tmpdir(), 'mh-provider-diagnostics-'));
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
process.env.AGENT_ROOT = join(import.meta.dirname, '..', '..');
process.env.PORT = String(port);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_USER_PLUGINS_DIR = pluginsDir;
process.env.SANDBOX_ROOT = join(tmp, 'workspace');
process.env.MAHARNESS_SECRET_KEY_ACL = '0';

const { startServer } = await import('../index');
const { refreshChatProviders } = await import('../routes/shared');
const base = `http://127.0.0.1:${port}`;
let started: Awaited<ReturnType<typeof startServer>> | undefined;

before(async () => {
  started = await startServer();
  started.store.upsertProvider({
    id: 'diagnostic-provider',
    label: 'Diagnostic Provider',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'diagnostic-secret-key',
    model: 'gpt-diagnostic',
    protocol: 'openai',
  });
  started.store.upsertModel({
    providerId: 'diagnostic-provider',
    modelId: 'gpt-diagnostic',
    contextWindow: 128000,
    maxOutput: 8192,
    vision: 1,
    tools: 1,
    reasoning: 0,
    priceIn: 1,
    priceOut: 2,
    latencyMs: 120,
    privacyTier: 'local',
    riskLevel: 'low',
    source: 'pulled',
    enabled: 1,
  });
  refreshChatProviders(started.kernel, started.store);
});

after(async () => {
  started?.server.close();
  started?.closeEnvWatcher();
  started?.store.close();
  try { await started?.kernel.stop(); } catch { /* 测试清理不影响断言结果 */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/providers/:id/diagnose', () => {
  test('三种协议连接失败只返回状态级诊断，不泄露远端响应体', async () => {
    const probe = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ secret: 'remote-provider-internal-detail' }));
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probePort = (probe.address() as { port: number }).port;
    process.env.AGENT_ALLOW_PRIVATE_URLS = '1';
    try {
      for (const protocol of ['openai', 'anthropic', 'ollama']) {
        const response = await fetch(`${base}/api/providers/test`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl: `http://127.0.0.1:${probePort}`, apiKey: 'test-key', model: 'test-model', protocol }),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { ok: boolean; error?: string; authFailed?: boolean };
        assert.deepEqual({ ok: body.ok, error: body.error, authFailed: body.authFailed }, { ok: false, error: 'HTTP 401', authFailed: true });
        assert.equal(JSON.stringify(body).includes('remote-provider-internal-detail'), false);
      }
    } finally {
      delete process.env.AGENT_ALLOW_PRIVATE_URLS;
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('Provider 真实探测故障进入健康状态并可在诊断端点闭环观察', async () => {
    const probe = createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ internal: 'provider-secret-detail' }));
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probePort = (probe.address() as { port: number }).port;
    process.env.AGENT_ALLOW_PRIVATE_URLS = '1';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${base}/api/providers/test`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: `http://127.0.0.1:${probePort}`,
            providerId: 'diagnostic-provider',
            model: 'gpt-diagnostic',
            protocol: 'openai',
          }),
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { ok: boolean; error?: string; authFailed?: boolean };
        assert.deepEqual({ ok: body.ok, error: body.error, authFailed: body.authFailed }, { ok: false, error: 'HTTP 503', authFailed: false });
        assert.equal(JSON.stringify(body).includes('provider-secret-detail'), false);
      }
      const diagnostic = await fetch(`${base}/api/providers/diagnostic-provider/diagnose`);
      assert.equal(diagnostic.status, 200);
      const body = await diagnostic.json() as { health: { failures: number; transientFailures?: number; circuitOpenedAt?: number; circuitResetAt?: number; lastError: string } | null; issues: string[] };
      assert.equal(body.health?.failures, 3);
      assert.equal(body.health?.transientFailures, 3);
      assert.equal(typeof body.health?.circuitOpenedAt, 'number');
      assert.equal(typeof body.health?.circuitResetAt, 'number');
      assert.equal(body.health?.lastError, 'HTTP 503');
      assert.ok(body.issues.some((issue) => issue.includes('最近请求失败')));
      assert.equal(JSON.stringify(body).includes('provider-secret-detail'), false);

      const listed = await fetch(`${base}/api/providers`);
      assert.equal(listed.status, 200);
      const providers = await listed.json() as Array<{ id: string; health?: { failures: number } | null }>;
      assert.equal(providers.find((provider) => provider.id === 'diagnostic-provider')?.health?.failures, 3);
    } finally {
      const { noteProviderSuccess } = await import('../../core/chat/provider-health');
      noteProviderSuccess('diagnostic-provider');
      delete process.env.AGENT_ALLOW_PRIVATE_URLS;
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('Trace 工具参数递归脱敏凭据键', () => {
    assert.deepEqual(redactTraceValue({
      path: 'reports/out.txt', apiKey: 'sk-live', nested: { token: 'approval-secret', password: 'pw' },
      values: [{ authorization: 'Bearer secret', keep: 'visible' }],
    }), {
      path: 'reports/out.txt', apiKey: '[REDACTED]', nested: { token: '[REDACTED]', password: '[REDACTED]' },
      values: [{ authorization: '[REDACTED]', keep: 'visible' }],
    });
  });

  test('返回配置、能力、健康与可操作问题，且不回显 API Key', async () => {
    const response = await fetch(`${base}/api/providers/diagnostic-provider/diagnose`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      providerId: string;
      schemaVersion: number;
      protocol: string;
      configured: { baseUrl: boolean; apiKey: boolean; defaultModel: boolean };
      models: Array<{ modelId: string; contextWindow: number; source: string }>;
      issues: string[];
      health: unknown;
    };
    assert.equal(body.providerId, 'diagnostic-provider');
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.protocol, 'openai');
    assert.deepEqual(body.configured, { baseUrl: true, apiKey: true, defaultModel: true });
    assert.deepEqual(body.models, [{
      providerId: 'diagnostic-provider', modelId: 'gpt-diagnostic', modelKey: 'diagnostic-provider@gpt-diagnostic', pricingId: 'diagnostic-provider@gpt-diagnostic', contextWindow: 128000, maxOutput: 8192,
      vision: true, tools: true, reasoning: false, priceIn: 1, priceOut: 2, source: 'pulled',
    }]);
    assert.deepEqual(body.issues, []);
    assert.equal('health' in body, true);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('diagnostic-secret-key'), false);
    assert.equal(serialized.includes('apiKeyMasked'), false);
  });

  test('不存在的 Provider 返回 404', async () => {
    const response = await fetch(`${base}/api/providers/missing-provider/diagnose`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { schemaVersion: 1, ok: false, code: 'not_found', error: '供应商不存在' });
  });

  test('已保存模型端点返回同一 schema 版本和稳定身份', async () => {
    const response = await fetch(`${base}/api/providers/diagnostic-provider/models`);
    assert.equal(response.status, 200);
    const body = await response.json() as { schemaVersion: number; models: Array<{ providerId: string; modelId: string; modelKey: string; pricingId: string }> };
    assert.equal(body.schemaVersion, 1);
    assert.deepEqual({
      providerId: body.models[0]?.providerId, modelId: body.models[0]?.modelId,
      modelKey: body.models[0]?.modelKey, pricingId: body.models[0]?.pricingId,
    }, {
      providerId: 'diagnostic-provider', modelId: 'gpt-diagnostic',
      modelKey: 'diagnostic-provider@gpt-diagnostic', pricingId: 'diagnostic-provider@gpt-diagnostic',
    });

    const selectable = await fetch(`${base}/api/models`);
    assert.equal(selectable.status, 200);
    const models = await selectable.json() as Array<{ schemaVersion: number; id: string; provider: string; model: string; modelKey: string; pricingId: string }>;
    const selected = models.find((model) => model.model === 'gpt-diagnostic');
    assert.deepEqual(selected, {
      schemaVersion: 1,
      providerId: 'diagnostic-provider', modelId: 'gpt-diagnostic',
      modelKey: 'diagnostic-provider@gpt-diagnostic', pricingId: 'diagnostic-provider@gpt-diagnostic',
      id: 'diagnostic-provider@gpt-diagnostic', provider: 'diagnostic-provider',
      label: 'DIAGNOSTIC-PROVIDER', model: 'gpt-diagnostic',
      vision: true, tools: true, reasoning: false, contextWindow: 128000,
    });

    const configResponse = await fetch(`${base}/api/config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json() as {
      routingTargets: Array<{ value: string; contextWindow?: number; latencyMs?: number; privacyTier?: string; riskLevel?: string }>;
    };
    const target = config.routingTargets.find((item) => item.value === 'diagnostic-provider@gpt-diagnostic');
    assert.deepEqual({
      value: 'diagnostic-provider@gpt-diagnostic',
      contextWindow: target?.contextWindow,
      latencyMs: 120,
      privacyTier: 'local',
      riskLevel: 'low',
    }, {
      value: 'diagnostic-provider@gpt-diagnostic',
      contextWindow: 128000,
      latencyMs: 120,
      privacyTier: 'local',
      riskLevel: 'low',
    });
  });

  test('真实聊天请求按配置路由并在 Trace 中保留完整候选证据', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    const calls: string[] = [];
    chat.providers = [{
      id: 'diagnostic-provider', label: 'Diagnostic Provider', defaultModel: 'gpt-diagnostic',
      models: [{
        modelId: 'gpt-diagnostic', contextWindow: 128000, maxOutput: 8192,
        vision: true, tools: true, reasoning: false, priceIn: 1, priceOut: 2,
        enabled: true, source: 'test', latencyMs: 120, privacyTier: 'local', riskLevel: 'low',
      }],
      async *chat(messages, options) {
        calls.push(`${options.model}:${messages.at(-1)?.content ?? ''}`);
        yield { type: 'delta', text: ' routed' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', { 默认: 'diagnostic-provider@gpt-diagnostic' });
    const session = started.store.createSession('gpt-diagnostic', 'diagnostic-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好，请简短回答' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    const traceId = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse)?.[1];
    assert.ok(traceId);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /^gpt-diagnostic:【继续】/);

    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&name=model-route`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ outputSummary?: string; status: string }> };
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]?.status, 'done');
    const decision = JSON.parse(trace.steps[0]?.outputSummary ?? '{}') as {
      reason?: string;
      candidates?: Array<{ providerId: string; model: string; accepted: boolean; reasons: string[] }>;
    };
    assert.match(decision.reason ?? '', /任务复杂度路由/);
    assert.deepEqual(decision.candidates, [{
      providerId: 'diagnostic-provider', model: 'gpt-diagnostic', score: 0, accepted: true,
      reasons: ['命中任务类型「其他」的配置'],
    }]);
  });

  test('开放式目标先返回推断确认，不调用 Provider 或写入 checkpoint', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'goal-provider', label: 'Goal Provider', defaultModel: 'goal-model',
      models: [{ modelId: 'goal-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' }],
      async *chat() {
        calls++;
        yield { type: 'delta', text: 'should not run' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    started.kernel.config.set('tools.writeRequiresApproval', true);
    const session = started.store.createSession('goal-model', 'goal-provider');
    started.store.updateSession(session.id, { mode: 'goal' });
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '请整理项目结构' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: task_inference\ndata:/);
    assert.match(sse, /event: end\ndata: \{\}/);
    assert.doesNotMatch(sse, /event: done\ndata:/);
    assert.equal(calls, 0);
    assert.equal(started.store.loadCheckpoint(session.id), undefined);
  });

  test('确认验收条件后消费原目标并进入执行链', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'confirmed-goal-provider', label: 'Confirmed Goal Provider', defaultModel: 'confirmed-goal-model',
      models: [{ modelId: 'confirmed-goal-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' }],
      async *chat() {
        calls++;
        yield { type: 'delta', text: '已完成，README.md 已检查' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    const session = started.store.createSession('confirmed-goal-model', 'confirmed-goal-provider');
    started.store.updateSession(session.id, { mode: 'goal' });
    const first = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '请整理项目结构' }),
    });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /event: task_inference/);
    assert.equal(calls, 0);
    const second = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '请整理项目结构\n验收条件：必须包含“README.md”' }),
    });
    assert.equal(second.status, 200);
    const sse = await second.text();
    assert.match(sse, /event: done\ndata:/);
    assert.match(sse, /event: task_verified\ndata:/);
    assert.equal(calls, 1);
    assert.ok(started.store.listMessages(session.id).some((message) => message.role === 'user' && message.content === '请整理项目结构\n验收条件：必须包含“README.md”'));
  });

  test('视觉工具在文本模型上真实借道视觉模型并记录 vision-route Trace', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    const targetCalls: { model: string; hasImage: boolean }[] = [];
    const textProvider: ProviderDef = {
      id: 'text-provider', label: 'Text Provider', defaultModel: 'text-model',
      models: [{ modelId: 'text-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' }],
      async *chat() { yield { type: 'done' }; },
    };
    const visionProvider: ProviderDef = {
      id: 'vision-provider', label: 'Vision Provider', defaultModel: 'vision-model',
      models: [{ modelId: 'vision-model', contextWindow: 128000, maxOutput: 8192, vision: true, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test', latencyMs: 80, privacyTier: 'local', riskLevel: 'low' }],
      async *chat(messages, options) {
        targetCalls.push({ model: options.model, hasImage: !!messages[0]?.images?.length });
        yield { type: 'delta', text: 'image read' };
        yield { type: 'done' };
      },
    };
    const externalVisionProvider: ProviderDef = {
      id: 'external-vision-provider', label: 'External Vision Provider', defaultModel: 'external-vision-model',
      models: [{ modelId: 'external-vision-model', contextWindow: 128000, maxOutput: 8192, vision: true, tools: true, reasoning: false, priceIn: 0.2, priceOut: 0.4, enabled: true, source: 'test', latencyMs: 900, privacyTier: 'external', riskLevel: 'high' }],
      async *chat() { yield { type: 'done' }; },
    };
    const unprofiledVisionProvider: ProviderDef = {
      id: 'unprofiled-vision-provider', label: 'Unprofiled Vision Provider', defaultModel: 'unprofiled-vision-model',
      models: [{ modelId: 'unprofiled-vision-model', contextWindow: 128000, maxOutput: 8192, vision: true, tools: true, reasoning: false, priceIn: 0.001, priceOut: 0.001, enabled: true, source: 'test' }],
      async *chat() { yield { type: 'done' }; },
    };
    chat.providers = [textProvider, visionProvider, externalVisionProvider, unprofiledVisionProvider];
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    const imagePath = join(process.env.SANDBOX_ROOT!, 'routing-sample.png');
    writeFileSync(imagePath, Buffer.from('deterministic-image-fixture'));
    const analyze = started.kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'analyze_image')?.tool;
    assert.ok(analyze);
    const ctx: ToolContext = {
      traceId: 'vision-http-contract', turn: 0, sandboxRoot: process.env.SANDBOX_ROOT!,
      cache: started.kernel.cache, trace: started.kernel.trace,
      providerId: 'text-provider', model: 'text-model', sessionId: 'vision-contract',
    };
    const result = await analyze.handler({ path: 'routing-sample.png', question: '读取图片内容', maxLatencyMs: 200, privacyTier: 'local', maxRiskLevel: 'medium' }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(targetCalls, [{ model: 'vision-model', hasImage: true }]);
    const visionResult = (result.data ?? {}) as { provider: string; model: string; routed: boolean; backTo?: string };
    assert.deepEqual({ provider: visionResult.provider, model: visionResult.model, routed: visionResult.routed, backTo: visionResult.backTo }, {
      provider: 'vision-provider', model: 'vision-model', routed: true, backTo: 'text-provider@text-model',
    });
    const traceResponse = await fetch(`${base}/api/trace?trace_id=vision-http-contract&name=vision-route`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ status: string; outputSummary?: string }> };
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]?.status, 'done');
    const decision = JSON.parse(trace.steps[0]?.outputSummary ?? '{}') as { target?: string; candidates?: Array<{ model: string; accepted: boolean; reasons: string[] }> };
    assert.equal(decision.target, 'vision-provider@vision-model');
    assert.equal(decision.candidates?.find((candidate) => candidate.model === 'external-vision-model')?.accepted, false);
    assert.match(decision.candidates?.find((candidate) => candidate.model === 'external-vision-model')?.reasons.join(' ') ?? '', /延迟 900ms 超过上限 200ms/);
    const unprofiled = decision.candidates?.find((candidate) => candidate.model === 'unprofiled-vision-model');
    assert.equal(unprofiled?.accepted, false);
    assert.match(unprofiled?.reasons.join(' ') ?? '', /未登记隐私画像/);
    assert.match(unprofiled?.reasons.join(' ') ?? '', /未登记风险画像/);
  });

  test('真实聊天入口按瞬时错误策略重试并记录 retry-policy Trace', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'flaky-provider', label: 'Flaky Provider', defaultModel: 'flaky-model',
      prices: { in: 9, out: 11 },
      models: [{
        modelId: 'flaky-model', contextWindow: 32000, maxOutput: 4096,
        vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2,
        enabled: true, source: 'test',
      }],
      async *chat() {
        calls++;
        if (calls === 1) throw new LLMHttpError(500, 'deterministic transient failure');
        yield { type: 'delta', text: 'recovered' };
        yield { type: 'usage', input: 100, output: 20, cachedInput: 40, missInput: 60 };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    const cacheBefore = started.kernel.cache.statsSnapshot();
    const session = started.store.createSession('flaky-model', 'flaky-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '触发一次可恢复错误' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: retry\ndata: .*"reason":"attempt"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 2);
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&name=retry-policy`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ status: string; outputSummary?: string }> };
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]?.status, 'done');
    assert.match(trace.steps[0]?.outputSummary ?? '', /HTTP_500: retry/);
    const llmResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=llm_call`);
    assert.equal(llmResponse.status, 200);
    const llmTrace = await llmResponse.json() as { steps: Array<{ tokensIn?: number; tokensOut?: number; tokensCached?: number; cost?: number; cacheLayer?: string; durationMs?: number; ts: number; endTs?: number; name: string }> };
    assert.deepEqual(llmTrace.steps.map((step) => ({
      name: step.name, tokensIn: step.tokensIn, tokensOut: step.tokensOut, tokensCached: step.tokensCached, cacheLayer: step.cacheLayer,
    })), [{ name: 'flaky-provider/flaky-model', tokensIn: 100, tokensOut: 20, tokensCached: 40, cacheLayer: 'L3' }]);
    assert.ok(Number.isFinite(llmTrace.steps[0]?.durationMs));
    assert.ok((llmTrace.steps[0]?.endTs ?? 0) >= llmTrace.steps[0]?.ts);
    assert.ok(Math.abs((llmTrace.steps[0]?.cost ?? 0) - 0.00014) < 1e-12);
    const aggregate = started.store.aggregateSessions().find((row) => row.sessionId === session.id);
    assert.ok(Math.abs((aggregate?.cost ?? 0) - 0.00014) < 1e-12);
    const cacheAfter = started.kernel.cache.statsSnapshot();
    assert.equal(cacheAfter.l3RealTokens - cacheBefore.l3RealTokens, 40);
    assert.equal(cacheAfter.l3RealMissTokens - cacheBefore.l3RealMissTokens, 60);
    assert.ok(Math.abs((cacheAfter.savedCost - cacheBefore.savedCost) - 0.00004) < 1e-12);
    const statsResponse = await fetch(`${base}/api/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as { cache: { metrics: {
      hits: { l3Provider: number };
      avoidedCalls: { llm: number; tool: number };
      tokensSaved: { l3Provider: number };
      costSaved: number;
    } } };
    assert.equal(typeof stats.cache.metrics.avoidedCalls.llm, 'number');
    assert.equal(typeof stats.cache.metrics.avoidedCalls.tool, 'number');
    assert.ok(stats.cache.metrics.hits.l3Provider >= 1);
    assert.ok(stats.cache.metrics.tokensSaved.l3Provider >= 40);
    assert.ok(stats.cache.metrics.costSaved >= 0.00004);
  });

  test('真实聊天入口 failover 后 Trace 使用最终实际 Provider/model', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let primaryCalls = 0;
    let fallbackCalls = 0;
    chat.providers = [
      {
        id: 'trace-primary-provider', label: 'Trace Primary', defaultModel: 'primary-model',
        models: [{ modelId: 'primary-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' }],
        async *chat() { primaryCalls++; throw new LLMHttpError(401, 'primary credentials rejected'); },
      },
      {
        id: 'trace-fallback-provider', label: 'Trace Fallback', defaultModel: 'fallback-model',
        models: [{ modelId: 'fallback-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 3, priceOut: 4, enabled: true, source: 'test' }],
        async *chat() { fallbackCalls++; yield { type: 'delta', text: 'fallback complete' }; yield { type: 'done' }; },
      },
    ];
    started.kernel.config.set('agent.modelRouting', {});
    const session = started.store.createSession('primary-model', 'trace-primary-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '验证 failover 的实际 Provider Trace' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: retry\ndata: .*"reason":"failover"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(primaryCalls, 1, '认证错误不得在主线路重复重试');
    assert.equal(fallbackCalls, 1);
    const traceId = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse)?.[1];
    assert.ok(traceId);
    const llmResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&type=llm_call`);
    assert.equal(llmResponse.status, 200);
    const llmTrace = await llmResponse.json() as { steps: Array<{ name?: string; status?: string; errorCategory?: string }> };
    assert.deepEqual(llmTrace.steps.map((step) => ({ name: step.name, status: step.status, errorCategory: step.errorCategory })), [
      { name: 'trace-fallback-provider/fallback-model', status: 'done', errorCategory: undefined },
    ]);
    const retryResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&name=retry-policy`);
    const retryTrace = await retryResponse.json() as { steps: Array<{ errorCode?: string; retryable?: boolean }> };
    assert.deepEqual(retryTrace.steps.map((step) => ({ errorCode: step.errorCode, retryable: step.retryable })), [{ errorCode: 'HTTP_401', retryable: false }]);
  });

  test('真实聊天入口并行委派在 Provider 负载下保持并发上限与完整聚合', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    let active = 0;
    let peakActive = 0;
    chat.providers = [{
      id: 'parallel-load-provider', label: 'Parallel Load Provider', defaultModel: 'parallel-load-model',
      models: [{ modelId: 'parallel-load-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' }],
      async *chat() {
        const call = ++calls;
        if (call === 1) {
          yield { type: 'tool_call', toolCall: {
            id: 'parallel-load-call', type: 'function',
            function: {
              name: 'run_parallel',
              arguments: JSON.stringify({ tasks: [
                { objective: 'parallel-load-child-A-20261031' },
                { objective: 'parallel-load-child-B-20261031' },
                { objective: 'parallel-load-child-C-20261031' },
                { objective: 'parallel-load-child-D-20261031' },
              ] }),
            },
          } };
          return;
        }
        if (call <= 5) {
          active++;
          peakActive = Math.max(peakActive, active);
          await new Promise((resolve) => setTimeout(resolve, 35));
          active--;
          yield { type: 'delta', text: `child-${call}` };
          yield { type: 'usage', input: 10, output: 5 };
          yield { type: 'done' };
          return;
        }
        yield { type: 'delta', text: 'parallel aggregate complete' };
        yield { type: 'usage', input: 10, output: 5 };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    started.kernel.config.set('cache.warmup', 'off');
    const parallelEvents: { phase?: string; detail?: { cost?: number; tokensIn?: number; tokensOut?: number } }[] = [];
    const eventBus = started.kernel.bus as unknown as { on(type: string, listener: (event: { data: unknown }) => void): () => void };
    const offProgress = eventBus.on('parallel.progress', (event) => parallelEvents.push(event.data as typeof parallelEvents[number]));
    const session = started.store.createSession('parallel-load-model', 'parallel-load-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '执行四项独立的并行负载回归并汇总结果' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    offProgress();
    assert.match(sse, /event: tool_result\ndata: .*"name":"run_parallel"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 6, '应包含主线路首轮、四个并行子任务和最终汇总轮');
    assert.equal(active, 0, 'Provider 负载结束后无活动请求');
    assert.equal(peakActive, 4, '四个并行子任务应同时运行但不超过批次上限');
    assert.equal(parallelEvents.filter((event) => event.phase === 'start').length, 4);
    const childDoneEvents = parallelEvents.filter((event) => event.phase === 'done');
    assert.equal(childDoneEvents.length, 4);
    const childCost = childDoneEvents.reduce((sum, event) => sum + (event.detail?.cost ?? 0), 0);
    assert.ok(childCost > 0);
    const finalEvent = /event: done\ndata: (\{[^\n]+\})/.exec(sse)?.[1];
    assert.ok(finalEvent);
    const final = JSON.parse(finalEvent!) as { usage?: { input: number; output: number }; cost: number };
    assert.deepEqual(final.usage, { input: 50, output: 25 }, '父结果应累计四个子任务和最终汇总轮用量');
    assert.ok(Math.abs(final.cost - (childCost + 0.00002)) < 1e-12, '父成本应累计子任务实际成本与最终汇总调用');
    const traceId = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse)?.[1];
    assert.ok(traceId);
    const traceResponse = await fetch(`${base}/api/trace?session_id=${encodeURIComponent(session.id)}&type=llm_call&limit=50`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ traceId: string; status: string; parentId?: string; name?: string }> };
    assert.equal(trace.steps.length, 6);
    assert.ok(trace.steps.every((step) => step.status === 'done'));
    assert.equal(trace.steps.filter((step) => step.traceId === traceId).length, 2, '主 run 应有首轮和汇总轮');
    assert.equal(trace.steps.filter((step) => step.traceId !== traceId && step.parentId).length, 4, '四个子 run 的 Provider 步骤均应挂到并行工具父步骤');
    const toolResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&type=tool_call&name=run_parallel`);
    const toolTrace = await toolResponse.json() as { steps: Array<{ status: string; outputSummary?: string }> };
    assert.deepEqual(toolTrace.steps.map((step) => step.status), ['done']);
  });

  test('真实聊天入口遇到参数错误时停止并记录错误终态字段', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'parameter-error-provider', label: 'Parameter Error Provider', defaultModel: 'parameter-model',
      async *chat() {
        calls++;
        throw new LLMHttpError(400, 'invalid parameter payload');
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    const session = started.store.createSession('parameter-model', 'parameter-error-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '触发参数错误终态' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: error\ndata:/);
    assert.equal(calls, 1, '参数错误不得在同一 Provider 重试');
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const llmResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=llm_call`);
    const llmTrace = await llmResponse.json() as { steps: Array<{ status: string; errorCategory?: string; errorCode?: string; error?: string; durationMs?: number }> };
    assert.equal(llmTrace.steps.length, 1);
    assert.equal(llmTrace.steps[0]?.status, 'error');
    assert.equal(llmTrace.steps[0]?.errorCategory, 'parameter');
    assert.equal(llmTrace.steps[0]?.errorCode, 'HTTP_400');
    assert.match(llmTrace.steps[0]?.error ?? '', /invalid parameter payload/);
    assert.ok(Number.isFinite(llmTrace.steps[0]?.durationMs));
    const retryResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&name=retry-policy`);
    const retryTrace = await retryResponse.json() as { steps: Array<{ outputSummary?: string; retryable?: boolean; retryDelayMs?: number }> };
    assert.equal(retryTrace.steps.length, 1);
    assert.match(retryTrace.steps[0]?.outputSummary ?? '', /HTTP_400: stop/);
    assert.equal(retryTrace.steps[0]?.retryable, false);
    assert.equal(retryTrace.steps[0]?.retryDelayMs, 0);
  });

  test('真实聊天入口按混合错误分布回放退避并在成功前重试', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    const primaryCalls: number[] = [];
    const fallbackCalls: number[] = [];
    const retryDecisions: Array<{ code?: string; retryable?: boolean; delayMs?: number }> = [];
    const providerModels = (modelId: string) => [{ modelId, contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'test' as const }];
    chat.providers = [
      {
        id: 'mixed-distribution-provider', label: 'Mixed Distribution Provider', defaultModel: 'mixed-distribution-model',
        models: providerModels('mixed-distribution-model'),
        async *chat() {
          primaryCalls.push(Date.now());
          if (primaryCalls.length === 1) throw new LLMHttpError(503, 'upstream unavailable');
          throw new LLMHttpError(429, 'rate limited', 40);
        },
      },
      {
        id: 'mixed-distribution-fallback', label: 'Mixed Distribution Fallback', defaultModel: 'mixed-distribution-fallback-model',
        models: providerModels('mixed-distribution-fallback-model'),
        async *chat() {
          fallbackCalls.push(Date.now());
          if (fallbackCalls.length === 1) throw new Error('request timed out after upstream stall');
          yield { type: 'delta', text: 'recovered after mixed failures' };
          yield { type: 'usage', input: 80, output: 10, cachedInput: 0, missInput: 80 };
          yield { type: 'done' };
        },
      },
    ];
    started.kernel.config.set('agent.modelRouting', {});
    const session = started.store.createSession('mixed-distribution-model', 'mixed-distribution-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '混合故障分布回放' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: retry\ndata: .*"reason":"attempt"/);
    assert.match(sse, /event: retry\ndata: .*"reason":"failover"/);
    assert.match(sse, /event: delta\ndata: .*recovered after mixed failures/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(primaryCalls.length, 2, '主线路 503 退避重试、429 停止后交棒 failover');
    assert.equal(fallbackCalls.length, 2, '备用线路超时退避重试后成功');
    const primaryGap = primaryCalls[1]! - primaryCalls[0]!;
    const fallbackGap = fallbackCalls[1]! - fallbackCalls[0]!;
    assert.ok(primaryGap >= 1100, `503 后应等待默认退避（实测 ${primaryGap}ms）`);
    assert.ok(fallbackGap >= 1100, `超时后应等待默认退避（实测 ${fallbackGap}ms）`);
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const retryResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&name=retry-policy`);
    assert.equal(retryResponse.status, 200);
    const retryTrace = await retryResponse.json() as { steps: Array<{ outputSummary?: string; errorCode?: string; retryable?: boolean; retryDelayMs?: number }> };
    retryDecisions.push(...retryTrace.steps.map((step) => ({ code: step.errorCode, retryable: step.retryable, delayMs: step.retryDelayMs })));
    assert.deepEqual(retryDecisions, [
      { code: 'HTTP_503', retryable: true, delayMs: 1200 },
      { code: 'HTTP_429', retryable: false, delayMs: 40 },
      { code: 'NETWORK_TRANSIENT', retryable: true, delayMs: 1200 },
    ]);
    const llmResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=llm_call`);
    const llmTrace = await llmResponse.json() as { steps: Array<{ name?: string; status?: string }> };
    assert.deepEqual(llmTrace.steps.map((step) => ({ name: step.name, status: step.status })), [
      { name: 'mixed-distribution-fallback/mixed-distribution-fallback-model', status: 'done' },
    ]);
  });

  test('真实聊天入口目标预算耗尽时推送 budget_hit 并停止后续调用', async () => {
    assert.ok(started);
    started.store.upsertModel({
      providerId: 'goal-provider', modelId: 'goal-model',
      contextWindow: 32000, maxOutput: 4096, vision: 0, tools: 1, reasoning: 0,
      priceIn: 400_000, priceOut: 400_000, source: 'manual', enabled: 1,
    });
    refreshChatProviders(started.kernel, started.store);
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'budget-fixture.txt'), 'budget fixture');
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'goal-provider', label: 'Goal Provider', defaultModel: 'goal-model',
      models: [{ modelId: 'goal-model', contextWindow: 32000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 400_000, priceOut: 400_000, enabled: true, source: 'test' }],
      async *chat() {
        calls++;
        yield { type: 'tool_call', toolCall: {
          id: 'record-budget-read', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"budget-fixture.txt"}' },
        } };
        yield { type: 'usage', input: 1010, output: 10, cachedInput: 0, missInput: 1010 };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    const session = started.store.createSession('goal-model', 'goal-provider');
    started.store.updateSession(session.id, { mode: 'goal' });
    const first = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '记录一次成本并结束，预算 0.42 美元' }),
    });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /event: task_inference\ndata:/);
    const second = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '记录一次成本并结束，预算 0.42 美元\n验收条件：必须包含“已记录”' }),
    });
    assert.equal(second.status, 200);
    const sse = await second.text();
    assert.match(sse, /event: budget_hit\ndata: .*"budget":0\.42/);
    assert.match(sse, /event: error\ndata: .*"kind":"budget"/);
    assert.doesNotMatch(sse, /event: done\ndata:/);
    assert.equal(calls, 1, '预算熔断后不得再发起 LLM 调用');
    const traceId = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse)?.[1];
    assert.ok(traceId);
    const breakerResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&name=cost-breaker`);
    assert.equal(breakerResponse.status, 200);
    const breakerTrace = await breakerResponse.json() as { steps: Array<{ status: string; outputSummary?: string }> };
    assert.equal(breakerTrace.steps.length, 1);
    assert.equal(breakerTrace.steps[0]?.status, 'error');
    assert.match(breakerTrace.steps[0]?.outputSummary ?? '', /熔断/);
  });

  test('真实聊天入口执行工具并在 Trace 中保留工具结果摘要', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'tool-provider', label: 'Tool Provider', defaultModel: 'tool-model',
      async *chat() {
        calls++;
        if (calls <= 2) {
          yield { type: 'tool_call', toolCall: {
            id: `read-trace-fixture-${calls}`, type: 'function',
            function: { name: 'read_file', arguments: '{"path":"trace-fixture.txt"}' },
          } };
          return;
        }
        yield { type: 'delta', text: '工具结果已读取' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'trace-fixture.txt'), 'trace fixture content');
    const session = started.store.createSession('tool-model', 'tool-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '读取测试文件并告诉我结果' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: tool_result\ndata: .*"name":"read_file"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 3);
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=tool_call`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ name: string; status: string; outputSummary?: string; durationMs?: number; ts: number; endTs?: number }> };
    assert.equal(trace.steps.length, 2);
    assert.ok(trace.steps.every((step) => step.name === 'read_file' && step.status === 'done'));
    assert.ok(trace.steps.every((step) => /trace fixture content/.test(step.outputSummary ?? '')));
    assert.ok(trace.steps.every((step) => Number.isFinite(step.durationMs)));
    assert.ok(trace.steps.every((step) => (step.endTs ?? 0) >= step.ts));
    const cacheResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=cache_hit&name=L2`);
    assert.equal(cacheResponse.status, 200);
    const cacheTrace = await cacheResponse.json() as { steps: Array<{ cacheLayer?: string; name: string; status: string; cacheKey?: string }> };
    assert.equal(cacheTrace.steps.length, 1);
    assert.deepEqual({ name: cacheTrace.steps[0]?.name, cacheLayer: cacheTrace.steps[0]?.cacheLayer, status: cacheTrace.steps[0]?.status }, { name: 'L2', cacheLayer: 'L2', status: 'done' });
    assert.match(cacheTrace.steps[0]?.cacheKey ?? '', /read_file/);
    const pageResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&limit=1`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json() as { steps: Array<{ ts: number }>; nextCursor?: string };
    assert.equal(page.steps.length, 1);
    assert.ok(page.nextCursor);
    const olderResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&before_ts=${encodeURIComponent(page.nextCursor!)}`);
    assert.equal(olderResponse.status, 200);
    const older = await olderResponse.json() as { steps: Array<{ ts: number }> };
    assert.ok(older.steps.length > 0);
    assert.ok(older.steps.every((step) => step.ts < Number(page.nextCursor)));
  });

  test('审批摘要、审批清单与工具结果摘要的凭据均经脱敏', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    const secretPayload = 'sk-leaky-key-20261031';
    chat.providers = [{
      id: 'redact-provider', label: 'Redact Provider', defaultModel: 'redact-model',
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', toolCall: {
            id: 'redact-write-call', type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'redact-fixture.txt', content: '脱敏夹具内容' }) },
          } };
          return;
        }
        if (calls === 2) {
          yield { type: 'tool_call', toolCall: {
            id: 'redact-read-call', type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'redact-fixture.txt', apiKey: secretPayload }) },
          } };
          return;
        }
        yield { type: 'delta', text: '脱敏检查完成' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'redact-fixture.txt'), `token=${secretPayload}`);
    const session = started.store.createSession('redact-model', 'redact-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '写入带凭据标记的文件并读取' }),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    let approval: { approvalId: string; approvalToken: string } | undefined;
    while (!approval) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      sse += decoder.decode(chunk.value, { stream: true });
      const match = /event: approval_required\ndata: (\{"approvalId":"[^"]+"[^\n]+\})/.exec(sse);
      if (match) approval = JSON.parse(match[1]) as { approvalId: string; approvalToken: string };
    }
    assert.equal(sse.includes(secretPayload), false, '审批帧不得携带凭据内容');
    const pendingList = await fetch(`${base}/api/approvals`);
    assert.equal(pendingList.status, 200);
    const pendingBody = JSON.stringify(await pendingList.json());
    assert.equal(pendingBody.includes(secretPayload), false, '审批清单不得携带凭据内容');
    const decision = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, approvalToken: approval.approvalToken }),
    });
    assert.equal(decision.status, 200);
    for (;;) {
      const chunk = await reader.read();
      sse += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    assert.equal(calls, 3);
    assert.match(sse, /event: tool_result\ndata: .*"name":"read_file"/);
    assert.equal(sse.includes(secretPayload), false, 'SSE 事件帧不得携带凭据内容');
    const traceId = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse)?.[1];
    assert.ok(traceId);
    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(traceId!)}&type=tool_call`);
    assert.equal(traceResponse.status, 200);
    const traceText = JSON.stringify(await traceResponse.json());
    assert.equal(traceText.includes(secretPayload), false, 'Trace 输入/输出摘要不得携带凭据内容');
    assert.match(traceText, /redact-fixture\.txt/);
  });

  test('真实子代理 HTTP 链路在跨 Trace 查询中保留完整父子因果链', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'trace-link-provider', label: 'Trace Link Provider', defaultModel: 'trace-link-model',
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', toolCall: {
            id: 'delegate-trace-child', type: 'function',
            function: { name: 'run_subagent', arguments: JSON.stringify({ objective: '读取 trace 因果链测试文件', tools: 'read' }) },
          } };
          return;
        }
        if (calls === 2) {
          yield { type: 'tool_call', toolCall: {
            id: 'read-trace-child-fixture', type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'subagent-trace-fixture.txt' }) },
          } };
          return;
        }
        yield { type: 'delta', text: calls === 3 ? '子代理读取完成' : '主任务完成' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    started.kernel.config.set('cache.warmup', 'off');
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'subagent-trace-fixture.txt'), 'trace child evidence');

    const session = started.store.createSession('trace-link-model', 'trace-link-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '通过子代理读取测试文件' }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /event: tool_result\ndata: .*"name":"run_subagent"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 4, '主代理委派、子代理工具调用与两个 run 的最终答复均已执行');

    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const parentResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=tool_call`);
    assert.equal(parentResponse.status, 200);
    const parentTrace = await parentResponse.json() as { steps: Array<{ id: string; traceId: string; name?: string; type: string; parentId?: string }> };
    const parent = parentTrace.steps.find((step) => step.name === 'run_subagent');
    assert.ok(parent, '父 run 应记录 run_subagent 工具步骤');
    assert.equal(parent.traceId, start![1]);
    assert.equal(parent.parentId, undefined, '顶层委派步骤不应挂到其他 run');

    const childrenResponse = await fetch(`${base}/api/trace?parent_id=${encodeURIComponent(parent.id)}`);
    assert.equal(childrenResponse.status, 200);
    const children = await childrenResponse.json() as { steps: Array<{ id: string; traceId: string; type: string; name?: string; parentId?: string }> };
    assert.ok(children.steps.length > 0, '父步骤应能查询到子代理的步骤');
    const childTraceIds = [...new Set(children.steps.map((step) => step.traceId))];
    assert.equal(childTraceIds.length, 1, '本次单一子代理的步骤应属于同一个子 run');
    const childTraceId = childTraceIds[0]!;
    assert.notEqual(childTraceId, parent.traceId, '子代理应拥有独立 traceId');
    assert.ok(children.steps.some((step) => step.type === 'llm_call'), '子代理 Provider 调用应关联父工具步骤');
    assert.ok(children.steps.some((step) => step.type === 'tool_call' && step.name === 'read_file'), '子代理工具调用应关联父工具步骤');
    assert.ok(children.steps.every((step) => step.parentId === parent.id), 'Provider 与工具步骤不得成为孤儿或挂到错误父节点');

    const graphResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(childTraceId)}&include_parents=1`);
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json() as {
      steps: Array<{ id: string; traceId: string; turn: number; attempt: number; type: 'llm_call' | 'tool_call' | 'cache_hit' | 'user_msg' | 'system' | 'service_call'; status: 'running' | 'done' | 'error' | 'cancelled'; ts: number; parentId?: string }>;
      parentChainComplete: boolean;
      unresolvedParentIds: string[];
    };
    assert.equal(graph.parentChainComplete, true);
    assert.deepEqual(graph.unresolvedParentIds, []);
    assert.ok(graph.steps.some((step) => step.id === parent.id && step.traceId === parent.traceId), 'include_parents 应跨 trace 补齐父工具步骤');
    assert.deepEqual(validateTraceSteps(graph.steps, { requireResolvedParents: true }), [], '补齐后的 API 图应通过完整 schema 与父链校验');

    const serviceResponse = await fetch(`${base}/api/trace?type=service_call&limit=500`);
    assert.equal(serviceResponse.status, 200);
    const serviceTrace = await serviceResponse.json() as { steps: Array<{ id: string; traceId: string; turn: number; attempt: number; type: 'llm_call' | 'tool_call' | 'cache_hit' | 'user_msg' | 'system' | 'service_call'; status: 'running' | 'done' | 'error' | 'cancelled'; ts: number; pluginId?: string }> };
    assert.ok(serviceTrace.steps.length > 0, '真实服务启动与子代理路径应产生可追踪的 service_call 事件');
    assert.deepEqual(validateTraceSteps(serviceTrace.steps, { requireResolvedParents: true }), [], '真实 API 返回的 service_call 事件应全部通过 Trace schema');
    assert.ok(serviceTrace.steps.every((step) => step.traceId && step.pluginId), 'service_call 应同时保留 Trace ID 与提供插件身份');
  });

  test('真实聊天审批链路下发凭据、批准工具并保留 Trace 关联', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'approval-provider', label: 'Approval Provider', defaultModel: 'approval-model',
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', toolCall: {
            id: 'delete-approval-fixture', type: 'function',
            function: { name: 'delete_file', arguments: '{"path":"approval-fixture.txt"}' },
          } };
          return;
        }
        yield { type: 'delta', text: '已完成批准操作' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'approval-fixture.txt'), 'approval fixture');
    const session = started.store.createSession('approval-model', 'approval-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '删除测试文件' }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    let approval: { approvalId: string; approvalToken: string } | undefined;
    while (!approval) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      sse += decoder.decode(chunk.value, { stream: true });
      const match = /event: approval_required\ndata: (\{"approvalId":"[^"]+"[^\n]+\})/.exec(sse);
      if (match) approval = JSON.parse(match[1]) as { approvalId: string; approvalToken: string };
    }
    assert.ok(approval.approvalId);
    assert.ok(approval.approvalToken);
    const decision = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, approvalToken: approval.approvalToken }),
    });
    assert.equal(decision.status, 200);
    assert.deepEqual(await decision.json(), { ok: true, approved: true });
    for (;;) {
      const chunk = await reader.read();
      sse += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    assert.match(sse, /event: tool_result\ndata: .*"name":"delete_file"/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 2);
    assert.equal(existsSync(join(process.env.SANDBOX_ROOT!, 'approval-fixture.txt')), false);
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=tool_call`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ name: string; status: string; outputSummary?: string; durationMs?: number; ts: number; endTs?: number }> };
    assert.equal(trace.steps.length, 1);
    assert.deepEqual({ name: trace.steps[0]?.name, status: trace.steps[0]?.status }, { name: 'delete_file', status: 'done' });
    assert.match(trace.steps[0]?.outputSummary ?? '', /approval-fixture/);
    assert.ok(Number.isFinite(trace.steps[0]?.durationMs));
    assert.ok((trace.steps[0]?.endTs ?? 0) >= trace.steps[0]?.ts);
    const approvalTraceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&name=approval`);
    const approvalTrace = await approvalTraceResponse.json() as { steps: Array<{ status: string; outputSummary?: string; durationMs?: number }> };
    assert.equal(approvalTrace.steps.length, 1);
    assert.equal(approvalTrace.steps[0]?.status, 'done');
    assert.match(approvalTrace.steps[0]?.outputSummary ?? '', /已批准/);
    assert.ok(Number.isFinite(approvalTrace.steps[0]?.durationMs));
  });

  test('真实聊天审批拒绝后不执行工具并记录取消终态', async () => {
    assert.ok(started);
    const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
    let calls = 0;
    chat.providers = [{
      id: 'reject-provider', label: 'Reject Provider', defaultModel: 'reject-model',
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', toolCall: {
            id: 'reject-approval-fixture', type: 'function',
            function: { name: 'delete_file', arguments: '{"path":"reject-fixture.txt"}' },
          } };
          return;
        }
        yield { type: 'delta', text: '已按拒绝结果收敛' };
        yield { type: 'done' };
      },
    }];
    started.kernel.config.set('agent.modelRouting', {});
    mkdirSync(process.env.SANDBOX_ROOT!, { recursive: true });
    writeFileSync(join(process.env.SANDBOX_ROOT!, 'reject-fixture.txt'), 'reject fixture');
    const session = started.store.createSession('reject-model', 'reject-provider');
    const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '删除测试文件但先等待审批' }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    let approval: { approvalId: string; approvalToken: string } | undefined;
    while (!approval) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      sse += decoder.decode(chunk.value, { stream: true });
      const match = /event: approval_required\ndata: (\{"approvalId":"[^"]+"[^\n]+\})/.exec(sse);
      if (match) approval = JSON.parse(match[1]) as { approvalId: string; approvalToken: string };
    }
    const decision = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: false, approvalToken: approval.approvalToken }),
    });
    assert.equal(decision.status, 200);
    assert.deepEqual(await decision.json(), { ok: true, approved: false });
    for (;;) {
      const chunk = await reader.read();
      sse += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    assert.match(sse, /event: tool_result\ndata: .*"name":"delete_file".*"ok":false/);
    assert.match(sse, /event: done\ndata:/);
    assert.equal(calls, 2);
    assert.equal(existsSync(join(process.env.SANDBOX_ROOT!, 'reject-fixture.txt')), true);
    const start = /event: start\ndata: \{"traceId":"([^"]+)"\}/.exec(sse);
    assert.ok(start?.[1]);
    const traceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&type=tool_call`);
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as { steps: Array<{ name: string; status: string; error?: string; durationMs?: number }> };
    assert.equal(trace.steps.length, 1);
    assert.deepEqual({ name: trace.steps[0]?.name, status: trace.steps[0]?.status }, { name: 'delete_file', status: 'error' });
    assert.match(trace.steps[0]?.error ?? '', /拒绝/);
    assert.ok(Number.isFinite(trace.steps[0]?.durationMs));
    const approvalTraceResponse = await fetch(`${base}/api/trace?trace_id=${encodeURIComponent(start![1])}&name=approval`);
    const approvalTrace = await approvalTraceResponse.json() as { steps: Array<{ status: string; error?: string; durationMs?: number }> };
    assert.equal(approvalTrace.steps.length, 1);
    assert.equal(approvalTrace.steps[0]?.status, 'error');
    assert.match(approvalTrace.steps[0]?.error ?? '', /拒绝|超时/);
    assert.ok(Number.isFinite(approvalTrace.steps[0]?.durationMs));
  });
});
