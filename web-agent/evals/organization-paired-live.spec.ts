import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, ProviderDef } from '../kernel/types';
import {
  pairedLiveRuntimeFingerprint,
  pairedLiveRuntimeSources,
  runPairedLive,
  unexecutedPairedReport,
  validatePairedLiveConfig,
  type PairedLiveConfig,
} from '../scripts/organization-paired-live';

function config(reportDir: string): PairedLiveConfig {
  return {
    reportDir,
    providerId: 'mock-provider',
    model: 'mock-model',
    objective: '提取三项事实并生成两份产物。',
    material: 'ALPHA=17\nBETA=29\nGAMMA=41\n',
    valueUsd: 1,
    soloBudgetUsd: 0.2,
    teamBudgetUsd: 0.4,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    maxCalls: 8,
    maxOutputTokens: 256,
    timeoutMs: 10_000,
  };
}

function lastMessage(messages: LLMMessage[]): string {
  return messages.map(message => String(message.content)).join('\n');
}

function mockProvider(completeUsage = true): { provider: ProviderDef; calls: () => number } {
  const responses = new Map<string, number>();
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id: 'mock-provider',
      label: 'mock',
      defaultModel: 'mock-model',
      prices: { in: 1, out: 1 },
      async *chat(messages, options) {
        calls++;
        const text = lastMessage(messages);
        const key = text.includes('ALPHA 与 BETA') ? 'a'
          : text.includes('提取 GAMMA') ? 'b'
            : text.includes('run_paired_team') ? 'team-root'
              : 'root';
        const turn = (responses.get(key) ?? 0) + 1;
        responses.set(key, turn);
        assert.equal(options.model, 'mock-model');
        if (key === 'a' && turn === 1) {
          yield { type: 'tool_call', toolCall: { id: `write-a-${calls}`, type: 'function', function: { name: 'write_paired_artifact', arguments: JSON.stringify({ path: 'analysis-a.md', content: 'ALPHA=17\nBETA=29\n' }) } } };
        } else if (key === 'b' && turn === 1) {
          yield { type: 'tool_call', toolCall: { id: `write-b-${calls}`, type: 'function', function: { name: 'write_paired_artifact', arguments: JSON.stringify({ path: 'review-b.md', content: 'GAMMA=41\n' }) } } };
        } else if (key === 'team-root' && turn === 1) {
          yield { type: 'tool_call', toolCall: { id: `team-${calls}`, type: 'function', function: { name: 'run_paired_team', arguments: '{}' } } };
        } else if (key === 'root' && turn === 1) {
          yield { type: 'tool_call', toolCall: {
            id: `solo-${calls}`,
            type: 'function',
            function: {
              name: 'write_paired_artifact',
              arguments: JSON.stringify({ path: 'analysis-a.md', content: 'ALPHA=17\nBETA=29\n' }),
            },
          } };
        } else if (key === 'root' && turn === 2) {
          yield { type: 'tool_call', toolCall: { id: `solo-b-${calls}`, type: 'function', function: { name: 'write_paired_artifact', arguments: JSON.stringify({ path: 'review-b.md', content: 'GAMMA=41\n' }) } } };
        } else {
          yield { type: 'delta', text: key.endsWith('root') ? 'paired arm complete' : `${key} branch complete` };
        }
        if (completeUsage) {
          yield { type: 'usage', input: 100, output: 10, cachedInput: 20, missInput: 80, cacheWrite: 0 };
        } else {
          yield { type: 'usage', input: 100, output: 10, estimated: true };
        }
        yield { type: 'done' };
      },
    },
  };
}

test('invalid or unconfirmed configurations never call a provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-paired-unexecuted-'));
  try {
    const invalid = config(join(dir, 'invalid'));
    invalid.inputUsdPerMillion = NaN;
    assert.throws(() => validatePairedLiveConfig(invalid), /inputUsdPerMillion/);
    const unexecuted = unexecutedPairedReport(config(join(dir, 'planned')), 'confirmation missing');
    assert.equal(unexecuted.status, 'unexecuted');
    assert.equal(unexecuted.evidenceMode, 'test-double');
    assert.equal(unexecuted.arms.solo, undefined);
    assert.equal(unexecuted.arms.team, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime fingerprint covers execution dependencies and provenance follows the provider boundary', () => {
  const sources = pairedLiveRuntimeSources();
  for (const required of [
    'scripts/organization-paired-live.ts',
    'evals/provider-budget.ts',
    'server/model-cost-estimator.ts',
    'server/run-store.ts',
    'server/run-service.ts',
    'server/society.ts',
    'core/chat/agent.ts',
  ]) {
    assert.ok(sources.includes(required), `missing runtime dependency ${required}`);
  }
  assert.match(pairedLiveRuntimeFingerprint(), /^[a-f0-9]{64}$/);

  const dir = mkdtempSync(join(tmpdir(), 'mh-paired-provenance-'));
  try {
    const report = unexecutedPairedReport(
      config(join(dir, 'planned')),
      'provider was not executed',
      'configured-provider',
    );
    assert.equal(report.evidenceMode, 'configured-provider');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mock provider drives solo and two real team child runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-paired-live-'));
  try {
    const mock = mockProvider();
    const report = await runPairedLive(config(join(dir, 'run')), mock.provider);
    assert.equal(report.status, 'passed');
    assert.equal(report.evidenceMode, 'test-double');
    assert.match(report.runnerFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(report.arms.solo?.status, 'completed');
    assert.equal(report.arms.team?.status, 'completed');
    assert.equal(report.arms.solo?.childRunIds.length, 0);
    assert.equal(report.arms.team?.childRunIds.length, 2);
    assert.equal(report.arms.team?.contractIds.length, 2);
    assert.equal(report.arms.solo?.modelCalls, 3);
    assert.equal(report.arms.team?.modelCalls, 6);
    assert.equal(report.arms.solo?.inputTokens, 300);
    assert.equal(report.arms.solo?.outputTokens, 30);
    assert.equal(report.arms.team?.inputTokens, 600);
    assert.equal(report.arms.team?.outputTokens, 60);
    assert.equal(report.arms.solo?.costUsd, 0.00033);
    assert.equal(report.arms.team?.costUsd, 0.00066);
    assert.deepEqual(report.arms.solo?.artifacts.sort(), ['analysis-a.md', 'review-b.md']);
    assert.deepEqual(report.arms.team?.artifacts.sort(), ['analysis-a.md', 'review-b.md']);
    assert.deepEqual(Object.keys(report.arms.team?.artifactHashes ?? {}).sort(), ['analysis-a.md', 'review-b.md']);
    assert.ok(report.arms.solo?.checks.every(check => check.passed));
    assert.ok(report.arms.team?.checks.every(check => check.passed));
    assert.equal(report.comparison?.tokens.marginal, 330);
    assert.equal(report.comparison?.coordination.tokens, report.comparison?.tokens.marginal);
    assert.equal(report.comparison?.risk.solo, 0);
    assert.equal(report.comparison?.risk.team, 0);
    assert.ok(mock.calls() >= 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete usage keeps a completed paired execution inconclusive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-paired-usage-'));
  try {
    const report = await runPairedLive(config(join(dir, 'run')), mockProvider(false).provider);
    assert.equal(report.status, 'inconclusive');
    assert.equal(report.arms.solo?.usageComplete, false);
    assert.equal(report.arms.team?.usageComplete, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
