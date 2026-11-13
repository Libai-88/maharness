import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderDef, LLMChunk } from '../kernel/types';
import { EvaluationBudget, budgetedEvaluationProvider } from './provider-budget';

const pricing = { model: 'test', inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxOutputTokens: 16 };
const mock = (chat: ProviderDef['chat']): ProviderDef => ({ id: 'test', label: 'Test', defaultModel: 'test', chat });
async function collect(provider: ProviderDef, options: { model?: string; signal?: AbortSignal; maxTokens?: number; images?: string[] } = {}) {
  const chunks: LLMChunk[] = [];
  for await (const chunk of provider.chat([{ role: 'user', content: 'work', images: options.images }], { model: options.model ?? 'test', signal: options.signal, maxTokens: options.maxTokens })) chunks.push(chunk);
  return chunks;
}

test('invalid budgets, prices, model identity and unpriced images never start a provider call', async () => {
  let calls = 0;
  const source = mock(async function* () { calls++; yield { type: 'done' }; });
  assert.throws(() => new EvaluationBudget(0), { code: 'EVAL_BUDGET_INVALID' });
  assert.throws(() => new EvaluationBudget(Infinity), { code: 'EVAL_BUDGET_INVALID' });
  const budget = new EvaluationBudget(1);
  assert.throws(() => budgetedEvaluationProvider(source, { ...pricing, inputUsdPerMillion: NaN }, budget), { code: 'EVAL_PRICING_INVALID' });
  const provider = budgetedEvaluationProvider(source, pricing, budget);
  await assert.rejects(collect(provider, { model: 'other' }), { code: 'EVAL_MODEL_MISMATCH' });
  await assert.rejects(collect(provider, { images: ['data:image/png;base64,test'] }), { code: 'EVAL_IMAGE_PRICING_REQUIRED' });
  await assert.rejects(collect(provider, { maxTokens: 0 }), { code: 'EVAL_OUTPUT_LIMIT_INVALID' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(collect(provider, { signal: abort.signal }));
  assert.equal(calls, 0); assert.deepEqual(budget.receipts, []);
});

test('concurrent model tiers share atomic reservations and completed usage releases unused funds', async () => {
  let release = () => {}; let entered = () => {}; let calls = 0; let outputLimit = 0;
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const started = new Promise(resolve => { entered = () => resolve(undefined); });
  const source = mock(async function* (_messages, options) {
    calls++; outputLimit = options.maxTokens!; entered(); await gate;
    yield { type: 'usage', input: 10, output: 5 }; yield { type: 'done' };
  });
  const budget = new EvaluationBudget(0.006);
  const first = budgetedEvaluationProvider(source, { ...pricing, model: 'tier-a', scope: 'case-a' }, budget);
  const second = budgetedEvaluationProvider(source, { ...pricing, model: 'tier-b', scope: 'case-b' }, budget);
  const active = collect(first, { model: 'tier-a', maxTokens: 1000 });
  await started;
  try {
    await assert.rejects(collect(second, { model: 'tier-b' }), { code: 'EVAL_BUDGET_EXHAUSTED' });
    assert.equal(calls, 1); assert.equal(outputLimit, 16); assert.ok(budget.reservedUsd > 0);
  } finally { release(); await active; }
  await collect(second, { model: 'tier-b' });
  assert.equal(calls, 2); assert.equal(budget.reservedUsd, 0);
  assert.ok(2e-9 > Math.abs(budget.chargedUsd - 0.00003));
  assert.deepEqual(budget.receipts.map(row => row.scope), ['case-a', 'case-b']);
  assert.ok(budget.receipts.every(row => row.accounting === 'reported'));
});

for (const mode of ['missing', 'estimated', 'interrupted']) {
  test(`${mode} usage retains the reservation and cannot fund an automatic replay`, async () => {
    let calls = 0;
    const source = mock(async function* () {
      calls++;
      if (mode !== 'missing') yield { type: 'usage', input: 10, output: 5, estimated: mode === 'estimated' };
      if (mode === 'interrupted') throw new Error('network interrupted');
      yield { type: 'done' };
    });
    const budget = new EvaluationBudget(0.006);
    const provider = budgetedEvaluationProvider(source, pricing, budget);
    if (mode === 'interrupted') await assert.rejects(collect(provider), /network interrupted/); else await collect(provider);
    const receipt = budget.receipts[0];
    assert.equal(receipt.accounting, 'conservative'); assert.equal(receipt.chargedUsd, receipt.reservedUsd);
    await assert.rejects(collect(provider), { code: 'EVAL_BUDGET_EXHAUSTED' });
    assert.equal(calls, 1); assert.equal(budget.reservedUsd, 0);
  });
}

test('closing a partial stream retains its cost reservation', async () => {
  const source = mock(async function* () { yield { type: 'delta', text: 'partial' }; yield { type: 'done' }; });
  const budget = new EvaluationBudget(0.006);
  const provider = budgetedEvaluationProvider(source, pricing, budget);
  for await (const _chunk of provider.chat([{ role: 'user', content: 'work' }], { model: 'test' })) break;
  assert.equal(budget.receipts[0].accounting, 'conservative');
  await assert.rejects(collect(provider), { code: 'EVAL_BUDGET_EXHAUSTED' });
});

test('cumulative usage is settled once and copied receipts cannot alter accounting', async () => {
  const source = mock(async function* () {
    yield { type: 'usage', input: 10, output: 2 }; yield { type: 'usage', input: 10, output: 5 }; yield { type: 'done' };
  });
  const budget = new EvaluationBudget(1);
  await collect(budgetedEvaluationProvider(source, pricing, budget));
  assert.ok(2e-9 > Math.abs(budget.chargedUsd - 0.000015));
  budget.receipts[0].chargedUsd = 0;
  assert.ok(budget.chargedUsd > 0);
});

test('reported usage outside the enforced bound halts all further paid calls and preserves the overrun', async () => {
  let calls = 0;
  const source = mock(async function* () { calls++; yield { type: 'usage', input: 10, output: 1_000_000 }; yield { type: 'done' }; });
  const budget = new EvaluationBudget(0.006);
  const provider = budgetedEvaluationProvider(source, pricing, budget);
  await assert.rejects(collect(provider), { code: 'EVAL_USAGE_BOUND_EXCEEDED' });
  assert.equal(budget.haltReason, 'EVAL_USAGE_BOUND_EXCEEDED'); assert.ok(budget.chargedUsd > budget.limitUsd);
  await assert.rejects(collect(provider), { code: 'EVAL_BUDGET_HALTED' });
  assert.equal(calls, 1);
});
