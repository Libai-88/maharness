import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callModel, withModelScope, type ModelCallRecord } from '../model-call';
import { normalizeFinishReason, ModelResponseError } from '../model-response';
import { classifyError } from '../error-policy';
import { createProvider } from '../../core/chat/provider';
import { isAbortError } from '../../core/chat/provider-health';
import type { LLMChunk, ProviderDef } from '../types';
const tool = (id: string): LLMChunk => ({ type: 'tool_call', toolCall: { id, type: 'function', function: { name: 'write', arguments: '{}' } } });
const opts = { model: 'm', maxTokens: 100 };
async function collect(provider: ProviderDef) { const chunks: LLMChunk[] = []; for await (const chunk of callModel(provider, [], opts)) chunks.push(chunk); return chunks; }
function provider(chat: ProviderDef['chat']): ProviderDef { return { id: 'fixture', label: 'fixture', defaultModel: 'm', chat }; }
test('finish reasons normalize both protocols without guessing unknown values', () => {
  assert.equal(normalizeFinishReason('max_tokens'), 'length'); assert.equal(normalizeFinishReason('length'), 'length');
  assert.equal(normalizeFinishReason('tool_use'), 'tool_calls'); assert.equal(normalizeFinishReason('end_turn'), 'stop');
  assert.equal(normalizeFinishReason('content_filter'), 'blocked'); assert.equal(normalizeFinishReason(undefined), 'unknown');
});
test('all buffered tools are discarded on truncated or interrupted responses', async () => {
  const truncated = await collect(provider(async function* () { yield tool('a'); yield tool('b'); yield { type: 'done', reason: 'length' }; }));
  assert.equal(truncated.filter(c => c.type === 'tool_call').length, 0); assert.deepEqual(truncated.at(-1), { type: 'done', reason: 'length', toolCallsTruncated: true });
  const seen: LLMChunk[] = [];
  await assert.rejects(async () => { for await (const c of callModel(provider(async function* () { yield tool('a'); yield tool('b'); throw new ModelResponseError('STREAM_INTERRUPTED', 'connection closed'); }), [], opts)) seen.push(c); }, /connection closed/);
  assert.equal(seen.length, 0);
});
test('complete tool batch is released in order; legacy adapters remain compatible', async () => {
  const chunks = await collect(provider(async function* () { yield tool('a'); yield tool('b'); }));
  assert.equal(chunks.filter(c => c.type === 'tool_call').length, 2); assert.equal(chunks.at(-1)?.type, 'done');
});
test('blocked output never releases buffered tools', async () => {
  const seen: LLMChunk[] = [];
  await assert.rejects(async () => { for await (const c of callModel(provider(async function* () { yield tool('a'); yield { type: 'done', reason: 'blocked' }; }), [], opts)) seen.push(c); }, (e: any) => e.code === 'OUTPUT_BLOCKED');
  assert.equal(seen.length, 0);
});
test('timeout and stream interruption are transient, never user cancellation', () => {
  for (const code of ['REQUEST_TIMEOUT', 'STREAM_INTERRUPTED'] as const) { const e = new ModelResponseError(code, 'operation aborted'); assert.equal(isAbortError(e), false); assert.equal(classifyError(e).category, 'transient'); }
});
test('finish reason and reported usage survive the model ledger', async () => {
  let saved: ModelCallRecord | undefined;
  await withModelScope({ runId: 'r', signal: new AbortController().signal, async acquire() { return () => {}; }, start() {}, finish(record) { saved = record; } }, () => collect(provider(async function* () { yield { type: 'usage', input: 9, output: 8 }; yield { type: 'done', reason: 'length', rawReason: 'max_tokens' }; })));
  assert.equal(saved?.finishReason, 'length'); assert.equal(saved?.rawFinishReason, 'max_tokens'); assert.equal(saved?.output, 8); assert.equal(saved?.usageStatus, 'reported');
});
for (const protocol of ['openai', 'anthropic'] as const) test(`${protocol} adapter retains protocol truncation and estimates missing usage`, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const payloads = protocol === 'openai' ? [JSON.stringify({ choices: [{ delta: { content: '有内容的部分正文', tool_calls: [{ index: 0, id: 't', function: { name: 'write', arguments: '{"text":"长文字"}' } }] }, finish_reason: 'length' }] }), '[DONE]'] : [JSON.stringify({ type: 'message_start', message: {} }), JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '有内容的部分正文' } }), JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }), JSON.stringify({ type: 'message_stop' })];
    res.end(payloads.map(p => `data: ${p}${String.fromCharCode(10, 10)}`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = createProvider({ id: 'local-fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'fixture', model: 'm', protocol });
    const chunks = await collect(p); assert.equal((chunks.at(-1) as any).reason, 'length'); assert.equal(chunks.some(c => c.type === 'tool_call'), false);
    assert.ok(chunks.some(c => c.type === 'usage' && c.estimated));
    if (protocol === 'openai') assert.ok(chunks.some(c => c.type === 'usage' && c.output > 0));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
