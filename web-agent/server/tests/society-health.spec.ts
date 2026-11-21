import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSocialHealth } from '../services/society/health';

test('social health is an explicit weighted heuristic and re-normalizes missing components', () => {
  const all = buildSocialHealth({
    loadBalance: 1,
    welfare: 1,
    exceptionHealth: 1,
    budgetUtilization: 0,
    collaborationHealth: 1,
    sampleSize: 3,
  });
  assert.equal(all.scoreKind, 'weighted_heuristic');
  assert.equal(all.score, 100);
  assert.equal(all.sampleSize, 3);
  assert.deepEqual(all.weights, {
    loadBalance: 0.2,
    welfare: 0.2,
    exceptionHealth: 0.2,
    budgetHeadroom: 0.2,
    collaborationHealth: 0.2,
  });

  const partial = buildSocialHealth({
    loadBalance: 0,
    welfare: 1,
    exceptionHealth: 1,
    budgetUtilization: 0,
    collaborationHealth: null,
    sampleSize: 0,
  });
  assert.equal(partial.collaborationHealth, null);
  assert.equal(partial.score, 75);
});
