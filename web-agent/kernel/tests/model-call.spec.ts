import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { callModel, modelOutputBudget, callEmbedding, inModelScope, ModelAdmissionError, type ModelCallRecord, type ModelCallScope } from '../model-call';
import { ExecutionPool } from '../execution-pool';
import { Store } from '../../server/db';
import { compactHistory } from '../../core/chat/compact';
import { normalizeUsage } from '../../core/chat/provider';
import { isUserMessage } from '../context';
import type { RunRecord } from '../run';
import type { ProviderDef } from '../types';

const provider = (usage = true): ProviderDef => ({
  id: 'test', label: 'Test', defaultModel: 'm', prices: { in: 1, out: 2 }, priceSource: 'configured', outputLimitGuaranteed: true,
  async *chat(_messages, options) {
    assert.ok(options.signal);
    yield { type: 'model', model: 'actual-model' };
    yield { type: 'delta', text: 'done' };
    if (usage) yield { type: 'usage', input: 100, output: 20 };
    yield { type: 'done' };
  },
});
function fixture() {
  const rows: ModelCallRecord[] = [];
  const abort = new AbortController();
  const pool = new ExecutionPool(1);
  const scope: ModelCallScope = { runId: 'run', rootId: 'root', signal: abort.signal,
    acquire: signal => pool.acquire('root', signal), start: () => {}, finish: row => { rows.push({ ...row }); } };
  return { rows, abort, scope };
}
async function consume(stream: AsyncIterable<unknown>) { for await (const _ of stream) {} }

test('all actual model attempts have independently attributed usage and model identities', async () => {
  const f = fixture();
  await consume(inModelScope(callModel(provider(), [{ role: 'user', content: 'hi' }], { model: 'm' }), f.scope));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].cost, 0.00014);
  assert.equal(f.rows[0].actualModel, 'actual-model');
  assert.equal(f.rows[0].runId, 'run');
  assert.equal(f.rows[0].usageStatus, 'reported');
});

test('model calls retain a validated context window for welfare pressure accounting', async () => {
  const known = fixture();
  const withContext = provider();
  withContext.models = [{
    modelId: 'm', contextWindow: 1_000, maxOutput: 100, vision: false, tools: true,
    reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'manual',
  }];
  await consume(inModelScope(callModel(withContext, [{ role: 'user', content: 'hi' }], { model: 'm' }), known.scope));
  assert.equal(known.rows[0].contextWindow, 1_000);

  const invalid = fixture();
  const withoutContext = provider();
  withoutContext.models = [{
    modelId: 'm', contextWindow: 0, maxOutput: 100, vision: false, tools: true,
    reasoning: false, priceIn: 1, priceOut: 2, enabled: true, source: 'manual',
  }];
  await consume(inModelScope(callModel(withoutContext, [{ role: 'user', content: 'hi' }], { model: 'm' }), invalid.scope));
  assert.equal(invalid.rows[0].contextWindow, undefined);
});

test('missing and partial usage never settle as confirmed zero', async () => {
  const f = fixture();
  await consume(inModelScope(callModel(provider(false), [], { model: 'm' }), f.scope));
  assert.equal(f.rows[0].cost, undefined);
  assert.equal(f.rows[0].input, undefined);
  assert.equal(f.rows[0].cachedInput, undefined);
  assert.equal(f.rows[0].missInput, undefined);
  assert.equal(f.rows[0].cacheWriteTokens, undefined);
  assert.equal(f.rows[0].usageStatus, 'unknown');
  assert.equal(normalizeUsage({ prompt_tokens: 1 }).incomplete, true);
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }).incomplete, undefined);
});

test('hard token admission gets a deterministic payload bound without adapter certification', async () => {
  const f = fixture();
  f.scope.cachePrefixHash = 'prefix-hash';
  const image = `data:image/png;base64,${'A'.repeat(4096)}`;
  const tool = { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } as never;
  await consume(inModelScope(callModel(provider(false), [
    { role: 'user', content: 'inspect', images: [image] },
  ], { model: 'm', tools: [tool] }), f.scope));
  const row = f.rows[0];
  assert.equal(row.inputUpperBoundSource, 'conservative');
  assert.ok((row.inputUpperBound ?? 0) >= Buffer.byteLength(image, 'utf8'));
  assert.equal(row.reservedTokens, (row.inputUpperBound ?? 0) + (row.outputLimit ?? 0));
  assert.equal(row.cachePrefixHash, 'prefix-hash');
});

test('adapter-certified token bound wins; invalid certification falls back to conservative framing', async () => {
  const certified = fixture();
  const providerWithBound = provider(false);
  providerWithBound.inputTokenUpperBound = () => 321;
  await consume(inModelScope(callModel(providerWithBound, [], { model: 'm' }), certified.scope));
  assert.equal(certified.rows[0].inputUpperBound, 321);
  assert.equal(certified.rows[0].inputUpperBoundSource, 'provider');
  assert.equal(certified.rows[0].reservedTokens, 321 + 4096);

  const fallback = fixture();
  const providerWithInvalidBound = provider(false);
  providerWithInvalidBound.inputTokenUpperBound = () => -1;
  await consume(inModelScope(callModel(providerWithInvalidBound, [{ role: 'user', content: 'bounded' }], { model: 'm' }), fallback.scope));
  assert.equal(fallback.rows[0].inputUpperBoundSource, 'conservative');
  assert.ok((fallback.rows[0].inputUpperBound ?? 0) >= Buffer.byteLength('bounded', 'utf8'));
});

test('provider cache usage is persisted only when values are valid', async () => {
  const f = fixture();
  const p = provider(false);
  p.chat = async function* () {
    yield { type: 'usage', input: 100, output: 20, cachedInput: 40, missInput: 60, cacheWrite: 7 };
    yield { type: 'done' };
  };
  await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  assert.deepEqual(
    [f.rows[0].cachedInput, f.rows[0].missInput, f.rows[0].cacheWriteTokens],
    [40, 60, 7],
  );

  const invalid = fixture();
  const invalidProvider = provider(false);
  invalidProvider.chat = async function* () {
    yield { type: 'usage', input: 100, output: 20, cachedInput: 101, missInput: -1, cacheWrite: 1.5 };
    yield { type: 'done' };
  };
  await consume(inModelScope(callModel(invalidProvider, [], { model: 'm' }), invalid.scope));
  assert.equal(invalid.rows[0].cachedInput, undefined);
  assert.equal(invalid.rows[0].missInput, undefined);
  assert.equal(invalid.rows[0].cacheWriteTokens, undefined);
});

test('unknown pricing remains unknown even with complete usage', async () => {
  const f = fixture(); const p = provider(); p.priceSource = 'unknown';
  await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  assert.equal(f.rows[0].cost, undefined);
  assert.equal(f.rows[0].usageStatus, 'reported');
});

test('hard admission uses the conservative bound when an adapter cannot certify one', async () => {
  const f = fixture(); let invoked = false;
  const p = provider(); p.chat = async function* () { invoked = true; };
  f.scope.admit = row => {
    assert.equal(row.inputUpperBoundSource, 'conservative');
    assert.ok((row.reservedCost ?? 0) > 0);
  };
  await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  assert.equal(invoked, true);
  assert.equal(f.rows.length, 1);
});

test('explicit zero pricing permits a zero-cost hard reservation', async () => {
  const f = fixture(); const p = provider(); p.prices = { in: 0, out: 0 };
  f.scope.admit = row => assert.equal(row.reservedCost, 0);
  await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  assert.equal(f.rows[0].cost, 0);
});

test('invalid certified bounds fall back conservatively; invalid prices remain unknown', async () => {
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    const f = fixture(); const p = provider();
    p.inputTokenUpperBound = () => invalid;
    f.scope.admit = row => {
      assert.equal(row.inputUpperBoundSource, 'conservative');
      assert.ok((row.reservedCost ?? 0) > 0);
    };
    await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  }
  const f = fixture(); const p = provider(); p.prices = { in: NaN, out: 1 };
  f.scope.admit = row => {
    assert.equal(row.inputUpperBoundSource, 'conservative');
    assert.equal(row.reservedCost, undefined);
  };
  await consume(inModelScope(callModel(p, [], { model: 'm' }), f.scope));
  assert.equal(f.rows[0].priceSource, 'unknown');
  assert.equal(f.rows[0].cost, undefined);
});

test('task cancellation also cancels an auxiliary embedding request', async () => {
  const f = fixture(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  async function* work() {
    yield await callEmbedding('embed', 'text', signal => new Promise((_resolve, reject) => {
      started(); signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
  }
  const pending = consume(inModelScope(work(), f.scope));
  await ready; f.abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.rows[0].purpose, 'embedding');
  assert.equal(f.rows[0].status, 'cancelled');
});

test('compaction cannot swallow task cancellation or hard budget denial', async () => {
  const f = fixture();
  f.scope.admit = () => { throw new ModelAdmissionError('denied'); };
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'assistant' as const, content: `${i} ` + 'history '.repeat(100) }));
  async function* work() { yield await compactHistory(messages, 500, { provider: provider(), model: 'm' }); }
  await assert.rejects(consume(inModelScope(work(), f.scope)), ModelAdmissionError);
});

test('ledger settlement is idempotent and restart preserves unknown executions', () => {
  const store = new Store(':memory:');
  try {
    const row: ModelCallRecord = { id: 'call', runId: 'r', scope: 'run', purpose: 'agent', providerId: 'p', model: 'm', status: 'running', startedAt: 1, inputEstimate: 2, outputLimit: 3, usageStatus: 'unknown', priceSource: 'unknown' };
    store.runs.startModelCall(row); store.runs.interruptActive();
    assert.equal(store.runs.modelCalls('r')[0].status, 'unknown');
    assert.equal(store.runs.finishModelCall({ ...row, status: 'completed' }), false);
    assert.equal(store.runs.modelCalls('another-run').length, 0);
  } finally { store.close(); }
});

test('token reservations count only unresolved ledger calls', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now();
    const run: RunRecord = {
      id: 'r', sessionId: 's', tenantId: 'default', rootId: 'r', depth: 0,
      objective: 'bounded task', providerId: 'p', model: 'm', status: 'running',
      authorization: { workspace: process.cwd(), profile: 'standard', readOnly: false, revision: 1 },
      createdAt: now, updatedAt: now, cost: 0, tokensIn: 0, tokensOut: 0,
      budgetTokens: 1_000, budgetPolicy: 'enforce',
    };
    store.runs.create(run);
    const base: ModelCallRecord = {
      id: 'call', runId: 'r', scope: 'run', purpose: 'agent', providerId: 'p', model: 'm',
      status: 'running', startedAt: now, inputEstimate: 100, inputUpperBound: 100,
      inputUpperBoundSource: 'provider', outputLimit: 20, reservedTokens: 120,
      usageStatus: 'unknown', priceSource: 'unknown',
    };
    store.runs.startModelCall(base);
    assert.equal(store.runs.modelTokenReservations(run), 120);
    store.runs.finishModelCall({
      ...base, status: 'completed', input: 90, output: 20, usageStatus: 'reported',
    });
    assert.equal(store.runs.modelTokenReservations(run), 0);
  } finally {
    store.close();
  }
});

test('user intent is determined by provenance even when text matches an old prefix', () => {
  assert.equal(isUserMessage({ role: 'user', content: '【长期记忆】请解释这个词', context: { id: 'u', source: 'user', trust: 'user', scope: 'run', retention: 'required' } }), true);
  assert.equal(isUserMessage({ role: 'user', content: 'a reference', context: { id: 'r', source: 'mcp', trust: 'untrusted', scope: 'run', retention: 'summarize' } }), false);
});

test('production modules cannot bypass the model dispatcher', () => {
  const root = resolve(import.meta.dirname, '../..');
  const allowed = new Set(['kernel/model-call.ts', 'core/chat/replay-provider.ts']);
  function scan(directory: string) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'tests' && !/@[0-9a-f]{10}$/.test(entry.name)) scan(name);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !allowed.has(name)) {
        assert.doesNotMatch(readFileSync(join(root, name), 'utf8'), /\b(?:provider|activeProvider|inner)\.chat\s*\(/, name);
      }
    }
  }
  for (const directory of ['core', 'server', 'kernel']) scan(directory);
});


test('a different model does not silently inherit the default model price', async () => {
  const f = fixture();
  await consume(inModelScope(callModel(provider(), [], { model: 'unpriced-model' }), f.scope));
  assert.equal(f.rows[0].cost, undefined); assert.equal(f.rows[0].priceSource, 'unknown');
});


test('output allocation matches actual request and context reserve with model and fallback capabilities', async () => {
  const source = provider();
  source.models = [{ modelId: 'm', contextWindow: 100000, maxOutput: 12000, vision: false, tools: true, reasoning: true, priceIn: 1, priceOut: 2, enabled: true, source: 'manual' }];
  assert.deepEqual(modelOutputBudget(source, 'unknown', 60000), { limit: 4096, source: 'default' });
  assert.deepEqual(modelOutputBudget(source, 'm', 60000), { limit: 9000, source: 'model' });
  const f = fixture();
  await consume(inModelScope(callModel(source, [{ role: 'user', content: 'hi' }], { model: 'm' }), f.scope));
  assert.equal(f.rows[0].outputLimit, modelOutputBudget(source, 'm').limit);
});
