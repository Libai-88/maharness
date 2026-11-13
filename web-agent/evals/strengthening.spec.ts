import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBudget, strengtheningTasks, buildStrengtheningReport, type StrengtheningSample } from './strengthening';

test('token admission is shared, atomic, and conservative for missing usage', () => {
  const budget = new TokenBudget(100);
  const first = budget.reserve(60); const second = budget.reserve(40);
  assert.throws(() => budget.reserve(1), /EVAL_TOKEN_LIMIT/);
  first(20); second(); second(0);
  assert.equal(budget.spent, 60); assert.equal(budget.held, 0); assert.equal(budget.stopped, true);
  assert.throws(() => new TokenBudget(NaN), /INVALID/);
  assert.throws(() => new TokenBudget(100).reserve(-1), /INVALID/);
  const exceeded = new TokenBudget(100); exceeded.reserve(10)(11); assert.equal(exceeded.stopped, true);
});

function fixture() {
  const tasks = strengtheningTasks(); const models = ['tier-1', 'tier-2'];
  const rows: StrengtheningSample[] = models.flatMap(tier => tasks.flatMap(task => (['baseline', 'reference', 'v2'] as const).map(variant => ({
    caseId: task.id, tier, variant, repetition: 1, completed: true, assertions: [{ name: 'artifact', passed: true }], observedModels: ['route'],
    calls: 3, tokensIn: 100, tokensOut: 20, costUsd: 0, costSource: 'free' as const,
    unnecessaryConfirmations: 0, duplicateEffects: 0, permissionViolations: 0, eventGaps: 0,
    usageComplete: true, elapsedMs: 1, interruptionObserved: task.category === 'recovery',
  }))));
  return { models, tasks, rows };
}

test('sixty-sample report remains separate from release acceptance', () => {
  const { tasks, rows, models } = fixture();
  assert.equal(tasks.length, 10); assert.equal(new Set(tasks.map(task => task.id)).size, 10);
  assert.equal(tasks.filter(task => task.category === 'recovery').length, 4);
  const report = buildStrengtheningReport(models, tasks, rows, true);
  assert.equal(report.engineeringTargetsPassed, true); assert.equal(report.readyForRelease, false);
  for (const changed of [rows.slice(1), [...rows, rows[0]], rows.map((row, index) => index ? row : { ...row, caseId: 'unknown' })])
    assert.equal(buildStrengtheningReport(models, tasks, changed, true).matrixComplete, false);
  assert.equal(buildStrengtheningReport(models, tasks, rows, false).engineeringTargetsPassed, false);
});

test('incomplete usage and failed artifacts cannot improve paired performance', () => {
  const { tasks, rows, models } = fixture();
  const incomplete = rows.map(row => ({ ...row, usageComplete: false }));
  const unknown = buildStrengtheningReport(models, tasks, incomplete, true);
  assert.equal(unknown.models[0].paired.samples, 0); assert.equal(unknown.models[0].checks.tokens, null);
  assert.equal(unknown.engineeringTargetsPassed, false);
  const failed = rows.map(row => row.variant === 'v2' && row.caseId === 'recovery-after-append' ? { ...row, assertions: [{ name: 'receipt', passed: false }] } : row);
  const report = buildStrengtheningReport(models, tasks, failed, true);
  assert.equal(report.models[0].checks.recovery, false); assert.equal(report.engineeringTargetsPassed, false);
  const costly = rows.map(row => row.variant === 'v2' ? { ...row, tokensIn: 116, calls: 4 } : row);
  assert.equal(buildStrengtheningReport(models, tasks, costly, true).models[0].checks.tokens, false);
});

test('harness-invalid samples remain occupied and cannot count as runtime failures or approve comparisons', () => {
  const { tasks, rows, models } = fixture();
  const invalid = rows.map(row => row.caseId === 'recovery-after-append' && row.variant !== 'reference'
    ? { ...row, completed: false, runtimeError: row.variant === 'v2' ? 'EVAL_HARNESS_ABORT_RECEIPTS_UNKNOWN' : 'EVAL_CHECKPOINT_INTERRUPT', failureStage: row.variant === 'v2' ? 'harness-abort' : 'recovery' }
    : row);
  const report = buildStrengtheningReport(models, tasks, invalid, true);
  assert.equal(report.matrixComplete, true);
  assert.equal(report.validSamples, 56); assert.equal(report.invalidSamples.length, 4);
  assert.equal(report.failedSamples.length, 0); assert.equal(report.safety, null);
  assert.equal(report.models[0].checks.quality, null); assert.equal(report.models[0].checks.recovery, null);
  assert.equal(report.models[0].paired.samples, 9);
  assert.equal(report.models[0].v2.validSamples, 9); assert.equal(report.models[0].v2.invalidSamples, 1);
  assert.equal(report.engineeringTargetsPassed, false); assert.equal(report.readyForRelease, false);
  const inconsistent = buildStrengtheningReport(models, tasks, rows, true, false);
  assert.equal(inconsistent.procedureConsistent, false);
  assert.equal(inconsistent.models[0].checks.quality, null); assert.equal(inconsistent.models[0].checks.recovery, null);
  assert.equal(inconsistent.engineeringTargetsPassed, false);
});
