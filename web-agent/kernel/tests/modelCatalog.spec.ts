import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferCapabilities, extractFromProviderMeta, resolveCapabilities } from '../modelCatalog';

describe('模型能力推断', () => {
  it('视觉命名一律识为 vision', () => {
    assert.equal(inferCapabilities('qwen2.5-vl-7b-instruct').vision, true);
    assert.equal(inferCapabilities('gpt-4o').vision, true);
    assert.equal(inferCapabilities('glm-4v-plus').vision, true);
  });

  it('纯文本模型不误标 vision', () => {
    assert.equal(inferCapabilities('deepseek-chat').vision, false);
    assert.equal(inferCapabilities('deepseek-reasoner').vision, false);
    assert.equal(inferCapabilities('llama3.1:8b').vision, false);
  });

  it('推理模型标 reasoning', () => {
    assert.equal(inferCapabilities('deepseek-reasoner').reasoning, true);
    assert.equal(inferCapabilities('o3-mini').reasoning, true);
    assert.equal(inferCapabilities('qwen3-32b-thinking-2507').reasoning, true);
    assert.equal(inferCapabilities('gpt-4o-mini').reasoning, false);
  });

  it('上下文窗口取合理量级', () => {
    assert.ok(inferCapabilities('claude-sonnet-4-5').contextWindow >= 200_000);
    assert.ok(inferCapabilities('gemini-2.5-pro').contextWindow >= 1_000_000);
    assert.ok(inferCapabilities('deepseek-chat').contextWindow >= 64_000);
    assert.ok(inferCapabilities('gpt-4o').maxOutput > 0);
  });

  it('未知模型走保守兜底而非崩溃', () => {
    const c = inferCapabilities('weird-unknown-model-9000');
    assert.equal(c.contextWindow, 32_768);
    assert.equal(c.vision, false);
    assert.equal(inferCapabilities('').contextWindow > 0, true);
  });

  it('本地 provider 价格记 0', () => {
    assert.equal(inferCapabilities('qwen2.5-vl:7b', 'ollama').priceIn, 0);
    assert.equal(inferCapabilities('llama3:8b', 'lmstudio').priceOut, 0);
  });
});

describe('provider 真实元数据优先', () => {
  it('提取各家字段命名', () => {
    const openai = extractFromProviderMeta({ id: 'x', context_length: 128000, max_tokens: 4096, supports_tools: true });
    assert.equal(openai.contextWindow, 128000);
    assert.equal(openai.maxOutput, 4096);
    assert.equal(openai.tools, true);
    const anthropic = extractFromProviderMeta({ id: 'x', model_limits: { context_length: 200000, output_length: 8192 } });
    assert.equal(anthropic.contextWindow, 200000);
    assert.equal(anthropic.maxOutput, 8192);
    const gemini = extractFromProviderMeta({ id: 'x', supported_modalities: ['TEXT', 'IMAGE'] });
    assert.equal(gemini.vision, true);
    const ollama = extractFromProviderMeta({ details: {}, capabilities: ['completion', 'tools'] });
    assert.equal(ollama.contextWindow, undefined);
  });

  it('合并顺序：手填 > provider > 目录', () => {
    const r = resolveCapabilities('gpt-4o', 'openai', { contextWindow: 1000 }, { contextWindow: 2000, vision: false });
    assert.equal(r.contextWindow, 1000);
    assert.equal(r.vision, false, 'provider 明确说不支持视觉时不得被目录覆盖');
    const r2 = resolveCapabilities('gpt-4o', 'openai', {}, {});
    assert.equal(r2.vision, true);
  });
});
