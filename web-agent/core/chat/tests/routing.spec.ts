import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeForCapability, capabilitySatisfied, capabilityRejectionReasons, routeForTask } from '../routing';
import type { ModelCapability, ProviderDef } from '../../../kernel/types';

const cap = (modelId: string, over: Partial<ModelCapability> = {}): ModelCapability => ({
  modelId, contextWindow: 32_768, maxOutput: 4096, vision: false, tools: true, reasoning: false,
  priceIn: 1, priceOut: 4, enabled: true, source: 'inferred', ...over,
});

const provider = (id: string, defaultModel: string, models: ModelCapability[]): ProviderDef => ({
  id, label: id.toUpperCase(), defaultModel, protocol: 'openai', models, prices: { in: 1, out: 4 },
  chat: async function* () { /* 测试不实际请求 */ },
});

describe('能力路由 routeForCapability', () => {
  const deepseek = provider('deepseek', 'deepseek-chat', [
    cap('deepseek-chat'),
    cap('deepseek-reasoner', { tools: false, reasoning: true }),
  ]);
  const qwen = provider('qwen', 'qwen-vl-max', [
    cap('qwen-plus'),
    cap('qwen-vl-max', { vision: true, priceIn: 0.5, priceOut: 2 }),
    cap('qwen2.5-vl-7b', { vision: true, priceIn: 0.02, priceOut: 0.06 }),
  ]);

  it('当前模型已具能力时判为满足（不切换）', () => {
    assert.equal(capabilitySatisfied({ vision: true }, qwen, 'qwen-vl-max'), true);
    assert.equal(capabilitySatisfied({ vision: true }, deepseek, 'deepseek-chat'), false);
  });

  it('缺能力时借道同 provider 的视觉模型（切换代价最小）', () => {
    const r = routeForCapability({ vision: true }, [deepseek, qwen], { providerId: 'qwen', model: 'qwen-plus' });
    assert.ok(r);
    assert.equal(r.provider.id, 'qwen');
    assert.ok(r.model !== 'qwen-plus');
    assert.match(r.reason, /需要视觉/);
  });

  it('同 provider 无视觉模型则跨 provider 借，且偏价格低者', () => {
    const r = routeForCapability({ vision: true }, [deepseek, qwen], { providerId: 'deepseek', model: 'deepseek-chat' });
    assert.equal(r?.provider.id, 'qwen');
    assert.equal(r?.model, 'qwen2.5-vl-7b');
    assert.equal(r?.same, false);
    assert.equal(r?.candidates.filter((candidate) => candidate.accepted).length, 1);
    assert.equal(r?.candidates.find((candidate) => candidate.accepted)?.model, 'qwen2.5-vl-7b');
    assert.ok(r?.candidates.find((candidate) => candidate.model === 'qwen-vl-max')?.reasons.includes('评分低于已选候选'));
    assert.ok(r?.candidates.find((candidate) => candidate.model === 'deepseek-chat')?.reasons.includes('当前模型无需切换'));
    assert.ok(r?.candidates.find((candidate) => candidate.model === 'deepseek-reasoner')?.reasons.includes('不满足至少一项能力要求'));
  });

  it('无任何视觉模型时返回 undefined（调用方给配置指引）', () => {
    assert.equal(routeForCapability({ vision: true }, [deepseek], { providerId: 'deepseek', model: 'deepseek-chat' }), undefined);
  });

  it('排除 disabled 模型与当前模型本身', () => {
    const off = provider('kimi', 'kimi-latest', [cap('kimi-vision', { vision: true, enabled: false })]);
    assert.equal(routeForCapability({ vision: true }, [off], { providerId: 'kimi', model: 'kimi-latest' }), undefined);
  });

  it('未登记模型走目录推断兜底', () => {
    const gpt = provider('openai', 'gpt-4o', []);
    const r = routeForCapability({ vision: true }, [gpt], { providerId: 'openai', model: 'some-text-model' });
    assert.equal(r?.model, 'gpt-4o', 'gpt-4o 由目录推断为支持视觉');
  });

  it('minContext 参与筛选', () => {
    const r = routeForCapability({ minContext: 200_000 }, [deepseek, provider('claude', 'claude-sonnet-4-5', [cap('claude-sonnet-4-5', { contextWindow: 200_000 })])],
      { providerId: 'deepseek', model: 'deepseek-chat' });
    assert.equal(r?.model, 'claude-sonnet-4-5');
  });

  it('按延迟、隐私和风险约束筛选并保留可解释评分', () => {
    const local = provider('local', 'local-fast', [cap('local-fast', { latencyMs: 80, privacyTier: 'local', riskLevel: 'low', vision: true })]);
    const external = provider('external', 'external-slow', [cap('external-slow', { latencyMs: 900, privacyTier: 'external', riskLevel: 'high', vision: true })]);
    const r = routeForCapability({ vision: true, maxLatencyMs: 200, privacyTier: 'local', maxRiskLevel: 'medium' }, [external, local], { providerId: 'deepseek', model: 'deepseek-chat' });
    assert.equal(r?.provider.id, 'local');
    assert.match(r?.candidates.find((c) => c.accepted)?.reasons.join(' ') ?? '', /延迟≈80ms/);
    assert.ok(r?.candidates.find((c) => c.model === 'external-slow')?.reasons.includes('不满足至少一项能力要求'));
  });

  it('显式延迟、隐私和风险约束缺少画像时 fail-closed 并说明缺口', () => {
    const unprofiled = provider('unprofiled', 'vision-model', [cap('vision-model', { vision: true })]);
    const r = routeForCapability({ vision: true, maxLatencyMs: 200, privacyTier: 'local', maxRiskLevel: 'low' }, [unprofiled], { providerId: 'text', model: 'text-model' });
    assert.equal(r, undefined, '没有画像证据时不能声称满足显式约束');
    assert.deepEqual(capabilityRejectionReasons({ maxLatencyMs: 200, privacyTier: 'local', maxRiskLevel: 'low' }, cap('vision-model')), [
      '不满足至少一项能力要求',
      '未登记延迟画像，无法确认满足延迟上限',
      '未登记隐私画像，无法确认符合隐私要求',
      '未登记风险画像，无法确认符合风险上限',
    ]);
  });
});

describe('既有任务路由不受影响', () => {
  it('无配置或未命中返回 undefined', () => {
    const p = provider('deepseek', 'deepseek-chat', [cap('deepseek-chat')]);
    assert.equal(routeForTask('这段代码报错', {}, [p]), undefined);
    assert.equal(routeForTask('这段代码报错', { 问答: 'ghost' }, [p]), undefined);
    assert.equal(routeForTask('帮我修这个报错', { 代码: 'deepseek@deepseek-reasoner' }, [p])?.model, 'deepseek-reasoner');
  });
});
