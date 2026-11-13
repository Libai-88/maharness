import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseReport, RELEASE_VALIDATIONS, type ReleaseManifest, type ReleaseSample, type ReleaseCategory, type ReleaseVariant } from './release-report';

function fixture() {
  const categories: ReleaseCategory[] = ['code', 'research', 'document', 'recovery', 'tool-failure'];
  const variants: ReleaseVariant[] = ['baseline', 'reference', 'v2'];
  const manifest: ReleaseManifest = {
    cases: Array.from({ length: 30 }, (_, index) => ({ id: 'case-' + index, category: categories[index % categories.length] })),
    models: ['small', 'large'].map(tier => ({ tier, requestedModel: tier, identity: 'version', pinnedVersion: tier + '-2026-11', versionEvidence: 'mock provider version receipt' })),
  };
  const samples: ReleaseSample[] = manifest.models.flatMap(model => manifest.cases.flatMap(task => variants.flatMap(variant => [1, 2, 3].map(repetition => ({
    caseId: task.id, tier: model.tier, variant, repetition, completed: true, assertions: [{ name: 'artifact assertion', passed: true }],
    observedModels: [model.pinnedVersion!], calls: 2, tokensIn: 100, tokensOut: 20,
    costUsd: variant === 'v2' ? 1.1 : 1, costSource: 'reported' as const,
    unnecessaryConfirmations: 0, duplicateEffects: 0, permissionViolations: 0, eventGaps: 0,
  })))));
  return { manifest, samples, validations: RELEASE_VALIDATIONS.map(id => ({ id, passed: true, evidence: 'mock:' + id })) };
}

test('complete two-tier, three-variant matrix requires 540 independently scored executions', () => {
  const { manifest, samples, validations } = fixture();
  const report = buildReleaseReport(manifest, samples, validations);
  assert.equal(report.expectedSamples, 540);
  assert.equal(report.readyForRelease, true);
  assert.equal(report.models[0].v2.passed, 90);
  assert.equal(report.models[0].medianCostRatio, 1.1);
});

test('missing, duplicate, and out-of-matrix rows cannot satisfy the release gate', () => {
  const { manifest, samples, validations } = fixture();
  for (const rows of [samples.slice(1), [...samples, samples[0]], [...samples.slice(1), { ...samples[0], repetition: 4 }]]) {
    const report = buildReleaseReport(manifest, rows, validations);
    assert.equal(report.readyForRelease, false);
    assert.ok(report.errors.length);
  }
});

test('a complete matrix for an earlier runtime revision cannot approve the current release', () => {
  const { manifest, samples, validations } = fixture();
  manifest.performanceRevisionCurrent = false;
  manifest.evaluationScope = 'A later tool read-boundary repair is not covered by this matrix.';
  const report = buildReleaseReport(manifest, samples, validations);
  assert.equal(report.readyForRelease, false);
  assert.equal(report.gates.find(gate => gate.id === 'performance-revision')!.passed, false);
});

test('routing aliases and changed observed model versions cannot be reported as fixed models', () => {
  const { manifest, samples, validations } = fixture();
  manifest.models[0].identity = 'route';
  assert.equal(buildReleaseReport(manifest, samples, validations).gates.find(gate => gate.id === 'model-identity')!.passed, false);
  manifest.models[0].identity = 'version';
  samples[0].observedModels = ['changed-version'];
  assert.equal(buildReleaseReport(manifest, samples, validations).readyForRelease, false);
});

test('free pricing and absent usage costs remain unmeasurable rather than a zero overhead claim', () => {
  const { manifest, samples, validations } = fixture();
  for (const row of samples) { row.costUsd = 0; row.costSource = 'free'; }
  let report = buildReleaseReport(manifest, samples, validations);
  assert.equal(report.readyForRelease, false);
  assert.equal(report.models[0].medianCostRatio, null);
  assert.equal(report.gates.find(gate => gate.id === 'cost:small')!.passed, null);
  for (const row of samples) { row.costUsd = null; row.costSource = 'unknown'; }
  report = buildReleaseReport(manifest, samples, validations);
  assert.equal(report.models[0].v2.medianCostUsd, null);
});

test('model completion does not replace artifact assertions or hide execution errors', () => {
  const { manifest, samples, validations } = fixture();
  const rows = samples.filter(row => row.tier === 'small' && row.variant === 'v2');
  rows[0].assertions = [];
  rows[1].assertions[0].passed = false;
  rows[2].runtimeError = 'tool operation outcome unknown';
  const report = buildReleaseReport(manifest, samples, validations);
  assert.equal(report.models[0].v2.passed, 87);
  assert.equal(report.readyForRelease, false);
});

test('five percentage point and fifteen percent thresholds stay unchanged', () => {
  const { manifest, samples, validations } = fixture();
  const current = samples.filter(row => row.tier === 'small' && row.variant === 'v2');
  for (const row of current.slice(0, 4)) row.assertions[0].passed = false;
  assert.equal(buildReleaseReport(manifest, samples, validations).gates.find(gate => gate.id === 'reference-success:small')!.passed, true);
  current[4].assertions[0].passed = false;
  assert.equal(buildReleaseReport(manifest, samples, validations).gates.find(gate => gate.id === 'reference-success:small')!.passed, false);
  for (const row of current) row.costUsd = 1.15;
  assert.equal(buildReleaseReport(manifest, samples, validations).gates.find(gate => gate.id === 'cost:small')!.passed, true);
  for (const row of current) row.costUsd = 1.151;
  assert.equal(buildReleaseReport(manifest, samples, validations).gates.find(gate => gate.id === 'cost:small')!.passed, false);
});

test('side effect violations and missing deterministic validation block release independently', () => {
  const { manifest, samples, validations } = fixture();
  const row = samples.find(sample => sample.variant === 'v2')!;
  row.duplicateEffects = 1;
  assert.equal(buildReleaseReport(manifest, samples, validations).readyForRelease, false);
  row.duplicateEffects = 0;
  assert.equal(buildReleaseReport(manifest, samples, validations.slice(1)).readyForRelease, false);
  row.tokensOut = NaN;
  assert.throws(() => buildReleaseReport(manifest, samples, validations), /Invalid sample counter/);
});
