import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModelCallRecord } from '../../kernel/model-call';
import type { RunRecord } from '../../kernel/run';
import { Store } from '../db';
import {
  estimateModelWorkloadCost,
  modelUsageProfile,
  resolvePricedModel,
} from '../model-cost-estimator';

function addRun(store: Store, tenantId: string): RunRecord {
  const session = store.createSession('fixture-model', 'fixture', tenantId);
  const now = Date.now();
  const run: RunRecord = {
    id: randomUUID(), rootId: randomUUID(), sessionId: session.id, tenantId,
    depth: 0, objective: '成本样本', providerId: 'fixture', model: 'fixture-model',
    status: 'completed', authorization: {
      workspace: process.cwd(), profile: 'standard', readOnly: false, revision: 0,
    },
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now,
  };
  run.rootId = run.id;
  store.runs.create(run);
  return run;
}

function addUsage(store: Store, run: RunRecord, input: number, output: number): void {
  const call: ModelCallRecord = {
    id: randomUUID(), runId: run.id, scope: 'run', purpose: 'agent',
    providerId: 'fixture', model: 'fixture-model', startedAt: Date.now(),
    status: 'running', inputEstimate: input, outputLimit: output, usageStatus: 'unknown',
    priceSource: 'configured', priceIn: 1, priceOut: 2,
  };
  store.runs.startModelCall(call);
  store.runs.finishModelCall({
    ...call, status: 'completed', input, output, usageStatus: 'reported',
  });
}

describe('authoritative model cost estimation', () => {
  test('uses tenant-local reported usage and current configured prices', () => {
    const store = new Store(':memory:');
    try {
      store.upsertProvider({
        id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1',
        apiKey: '', model: 'fixture-model', priceIn: 1, priceOut: 2,
      });
      const tenantRun = addRun(store, 'tenant-a');
      addUsage(store, tenantRun, 10_000, 200);
      const otherRun = addRun(store, 'tenant-b');
      addUsage(store, otherRun, 90_000, 900);

      const priced = resolvePricedModel(store, 'fixture', 'fixture-model')!;
      const profile = modelUsageProfile(store, 'tenant-a', 'fixture', 'fixture-model')!;
      assert.equal(profile.samples, 1);
      assert.equal(profile.inputTokens, 10_000);
      assert.equal(profile.outputTokens, 200);

      const estimate = estimateModelWorkloadCost(store, {
        tenantId: 'tenant-a', pricedModel: priced,
        promptTokens: 100, outputTokens: 100, fallbackCalls: 3,
      });
      assert.equal(estimate.source, 'historical');
      assert.equal(estimate.historySamples, 1);
      assert.equal(estimate.calls, 1);
      assert.equal(estimate.tokens, 10_200);
      assert.equal(estimate.costUsd, 0.0104);
    } finally {
      store.close();
    }
  });

  test('missing configured price cannot produce a priced route', () => {
    const store = new Store(':memory:');
    try {
      store.upsertProvider({
        id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.invalid/v1',
        apiKey: '', model: 'fixture-model',
      });
      assert.equal(resolvePricedModel(store, 'fixture', 'fixture-model'), undefined);
    } finally {
      store.close();
    }
  });
});
