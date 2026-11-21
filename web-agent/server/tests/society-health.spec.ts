import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSocialObservations } from '../services/society/health';

test('social observations expose formula, sample size and quality instead of a composite score', () => {
  const full = buildSocialObservations({
    loadBalance: 0.8,
    welfare: 0.9,
    exceptionHealth: 1,
    budgetUtilization: 0.25,
    collaborationHealth: 0.75,
    sampleSize: 6,
    roleCount: 4,
    unresolvedExceptions: 0,
    reservedUsd: 20,
    spentUsd: 5,
    budgetUsd: 100,
  });
  assert.deepEqual(full.map(item => item.id), [
    'load_balance', 'welfare', 'exception_backlog', 'budget_utilization', 'collaboration',
  ]);
  assert.equal(full.every(item => item.formula.length > 0), true);
  const collaboration = full.find(item => item.id === 'collaboration')!;
  assert.equal(collaboration.quality, 'observed');
  assert.equal(collaboration.sampleSize, 6);
  const budget = full.find(item => item.id === 'budget_utilization')!;
  assert.equal(budget.numerator, 25);
  assert.equal(budget.denominator, 100);
  assert.equal(budget.value, 0.25);

  const empty = buildSocialObservations({
    loadBalance: null,
    welfare: null,
    exceptionHealth: null,
    budgetUtilization: null,
    collaborationHealth: null,
    sampleSize: 0,
    roleCount: 0,
    unresolvedExceptions: 0,
    reservedUsd: 0,
    spentUsd: 0,
    budgetUsd: 0,
  });
  assert.equal(empty.find(item => item.id === 'collaboration')!.quality, 'unknown');
  assert.equal(empty.find(item => item.id === 'load_balance')!.value, null);
  assert.equal(empty.find(item => item.id === 'budget_utilization')!.quality, 'unknown');
  // No composite score field is exposed at all.
  assert.equal(empty.some(item => (item as unknown as { score?: number }).score !== undefined), false);
});
