import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterCapabilities, createProvider } from '../provider';

describe('Provider adapter capability contract', () => {
  test('OpenAI-compatible adapter declares supported request lifecycle and modality', () => {
    assert.deepEqual(adapterCapabilities('openai'), {
      streaming: true, toolCalls: true, structuredOutput: false, vision: true, cancellation: true,
    });
  });

  test('Anthropic adapter declares streaming, tool, vision, and cancellation support', () => {
    assert.deepEqual(adapterCapabilities('anthropic'), {
      streaming: true, toolCalls: true, structuredOutput: false, vision: true, cancellation: true,
    });
  });

  test('Ollama adapter does not claim structured output or vision without a request contract', () => {
    assert.deepEqual(adapterCapabilities('ollama'), {
      streaming: true, toolCalls: true, structuredOutput: false, vision: false, cancellation: true,
    });
  });

  test('created Provider exposes the same protocol capability contract', () => {
    const provider = createProvider({ id: 'anth', baseUrl: 'https://api.example', apiKey: 'secret', model: 'm', protocol: 'anthropic' });
    assert.deepEqual(provider.capabilities, adapterCapabilities('anthropic'));
  });
});
