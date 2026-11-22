import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProvider, normalizeUsage } from '../provider';
import type { LLMChunk } from '../../../kernel/types';

test('Anthropic cache read and creation become hit, miss and cache-write without double billing', () => {
  const usage = normalizeUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 40,
  });

  assert.deepEqual(usage, {
    input: 940,
    output: 20,
    cachedInput: 800,
    missInput: 140,
    cacheWrite: 40,
  });
});

test('Anthropic cache creation alone is one uncached input plus one diagnostic write value', () => {
  const usage = normalizeUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 40,
  });

  assert.equal(usage.input, 140);
  assert.equal(usage.missInput, 140);
  assert.equal(usage.cacheWrite, 40);
  assert.equal(usage.cachedInput, undefined);
});

test('DeepSeek cached and miss tokens remain parts of the reported prompt total', () => {
  const usage = normalizeUsage({
    prompt_tokens: 1_000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  });

  assert.deepEqual(usage, {
    input: 1_000,
    output: 50,
    cachedInput: 800,
    missInput: 200,
    cacheWrite: undefined,
  });
  assert.equal(usage.cachedInput! + usage.missInput!, usage.input);
});

test('OpenAI cached tokens remain inside prompt_tokens rather than being added again', () => {
  const usage = normalizeUsage({
    prompt_tokens: 1_000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 700 },
  });

  assert.equal(usage.input, 1_000);
  assert.equal(usage.cachedInput, 700);
  assert.equal(usage.missInput, 300);
  assert.equal(usage.cacheWrite, undefined);
  assert.equal(usage.cachedInput! + usage.missInput!, usage.input);
});

test('OpenAI-compatible SSE forwards Anthropic cache creation as usage.cacheWrite', async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":800,"cache_creation_input_tokens":40}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider = createProvider({ id: 'usage-cache', baseUrl: base, apiKey: 'test', model: 'm' });
    let usage: Extract<LLMChunk, { type: 'usage' }> | undefined;
    for await (const chunk of provider.chat([{ role: 'user', content: 'inspect' }], { model: 'm' })) {
      if (chunk.type === 'usage') usage = chunk;
    }
    assert.equal(usage?.input, 940);
    assert.equal(usage?.output, 20);
    assert.equal(usage?.cachedInput, 800);
    assert.equal(usage?.missInput, 140);
    assert.equal(usage?.cacheWrite, 40);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
