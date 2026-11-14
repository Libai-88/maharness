export type ReleaseVariant = 'baseline' | 'reference' | 'v2';
export type ReleaseCategory = 'code' | 'research' | 'document' | 'recovery' | 'tool-failure';
export interface ReleaseManifest {
  sampleFile?: 'samples.jsonl' | 'scored-samples.jsonl';
  evaluationScope?: string;
  performanceRevisionCurrent?: boolean;
  cases: { id: string; category: ReleaseCategory }[];
  models: { tier: string; requestedModel: string; pinnedVersion?: string; identity: 'version' | 'route' | 'unknown'; versionEvidence?: string }[];
}
export interface ReleaseSample {
  caseId: string; tier: string; variant: ReleaseVariant; repetition: number;
  completed: boolean; assertions: { name: string; passed: boolean }[]; runtimeError?: string;
  observedModels: string[];
  calls: number; tokensIn: number; tokensOut: number;
  costUsd: number | null; costSource: 'reported' | 'configured' | 'free' | 'unknown';
  unnecessaryConfirmations: number; duplicateEffects: number; permissionViolations: number; eventGaps: number;
}
export interface ReleaseValidation { id: string; passed: boolean; evidence: string }
export interface ReleaseGate { id: string; passed: boolean | null; detail: string }
const VARIANTS: ReleaseVariant[] = ['baseline', 'reference', 'v2'];
const CATEGORIES: ReleaseCategory[] = ['code', 'research', 'document', 'recovery', 'tool-failure'];
export const RELEASE_VALIDATIONS = ['typecheck', 'unit', 'security', 'build', 'desktop', 'narrow-screen', 'accessibility', 'reconnect', 'migration-rollback', 'plugin-contract'];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function successful(row: ReleaseSample): boolean {
  return row.completed && !row.runtimeError && row.assertions.length > 0 && row.assertions.every(check => check.passed);
}
function metrics(rows: ReleaseSample[]) {
  const sum = (field: 'calls' | 'tokensIn' | 'tokensOut' | 'unnecessaryConfirmations' | 'duplicateEffects' | 'permissionViolations' | 'eventGaps') => rows.reduce((total, row) => total + row[field], 0);
  const passed = rows.filter(successful).length;
  return {
    samples: rows.length, passed, successRate: rows.length ? passed / rows.length : null,
    medianCostUsd: rows.every(row => row.costUsd !== null && row.costSource !== 'unknown') ? median(rows.map(row => row.costUsd!)) : null,
    medianCalls: median(rows.map(row => row.calls)),
    medianTokensIn: median(rows.map(row => row.tokensIn)), medianTokensOut: median(rows.map(row => row.tokensOut)),
    calls: sum('calls'), tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'),
    unnecessaryConfirmations: sum('unnecessaryConfirmations'), duplicateEffects: sum('duplicateEffects'),
    permissionViolations: sum('permissionViolations'), eventGaps: sum('eventGaps'),
  };
}

export function buildReleaseReport(manifest: ReleaseManifest, samples: ReleaseSample[], validations: ReleaseValidation[]) {
  const errors: string[] = [];
  const gates: ReleaseGate[] = [];
  const add = (id: string, passed: boolean | null, detail: string) => gates.push({ id, passed, detail });
  const caseIds = manifest.cases.map(row => row.id);
  const tiers = manifest.models.map(row => row.tier);
  if (caseIds.length !== 30 || new Set(caseIds).size !== 30 || caseIds.some(id => !id.trim())) errors.push('Exactly 30 distinct task IDs are required');
  if (CATEGORIES.some(category => !manifest.cases.some(row => row.category === category))) errors.push('All five task categories are required');
  if (2 > tiers.length || new Set(tiers).size !== tiers.length || tiers.some(id => !id.trim())) errors.push('At least two distinct model tiers are required');
  if (new Set(manifest.models.map(row => row.requestedModel)).size !== manifest.models.length) errors.push('Model tiers must use distinct requested models');
  const expected = manifest.models.flatMap(model => manifest.cases.flatMap(task => VARIANTS.flatMap(variant => [1, 2, 3].map(repetition => JSON.stringify([model.tier, task.id, variant, repetition])))));
  const keys = samples.map(row => JSON.stringify([row.tier, row.caseId, row.variant, row.repetition]));
  if (new Set(keys).size !== keys.length) errors.push('Duplicate matrix samples are not allowed');
  const missing = expected.filter(key => !keys.includes(key));
  const unexpected = keys.filter(key => !expected.includes(key));
  if (missing.length) errors.push('Missing matrix samples: ' + missing.length);
  if (unexpected.length) errors.push('Unexpected matrix samples: ' + unexpected.length);
  for (const row of samples) {
    for (const value of [row.calls, row.tokensIn, row.tokensOut, row.unnecessaryConfirmations, row.duplicateEffects, row.permissionViolations, row.eventGaps]) {
      if (!Number.isSafeInteger(value) || 0 > value) throw new Error('Invalid sample counter');
    }
    if (row.costUsd !== null && (!Number.isFinite(row.costUsd) || 0 > row.costUsd)) throw new Error('Invalid sample cost');
    if (!row.assertions.every(check => check.name.trim() && typeof check.passed === 'boolean')) throw new Error('Invalid machine assertion');
  }
  add('matrix', !errors.length, errors.join('; ') || String(samples.length) + ' samples');
  add('performance-revision', manifest.performanceRevisionCurrent !== false, manifest.evaluationScope ?? 'Performance evidence applies to the evaluated revision');
  const pinned = manifest.models.every(model => model.identity === 'version' && model.pinnedVersion?.trim() && model.versionEvidence?.trim()
    && samples.filter(row => row.tier === model.tier).every(row => row.observedModels.length > 0 && row.observedModels.every(version => version === model.pinnedVersion)));
  add('model-identity', pinned && new Set(manifest.models.map(model => model.pinnedVersion)).size === manifest.models.length, 'Every call must match the fixed model version; route names alone are insufficient');
  const summaries = manifest.models.map(model => {
    const rows = samples.filter(row => row.tier === model.tier);
    const baseline = metrics(rows.filter(row => row.variant === 'baseline'));
    const reference = metrics(rows.filter(row => row.variant === 'reference'));
    const v2 = metrics(rows.filter(row => row.variant === 'v2'));
    const complete = VARIANTS.every(variant => rows.filter(row => row.variant === variant).length === 90);
    const qualityKnown = complete && v2.successRate !== null && reference.successRate !== null && baseline.successRate !== null;
    add('reference-success:' + model.tier, qualityKnown ? reference.successRate! - v2.successRate! <= 0.05 + 1e-12 : null, 'Maximum success-rate decline: 5 percentage points');
    add('baseline-success:' + model.tier, qualityKnown ? v2.successRate! >= baseline.successRate! : null, 'Success rate must meet the old baseline');
    const costKnown = complete && reference.medianCostUsd !== null && reference.medianCostUsd > 0 && v2.medianCostUsd !== null
      && rows.filter(row => row.variant !== 'baseline').every(row => row.costSource === 'reported' || row.costSource === 'configured');
    add('cost:' + model.tier, costKnown ? v2.medianCostUsd! <= reference.medianCostUsd! * 1.15 + 1e-12 : null, 'Maximum median cost increase: 15%; zero-price or missing-cost samples cannot measure a percentage increase');
    add('confirmations:' + model.tier, complete ? v2.unnecessaryConfirmations <= baseline.unnecessaryConfirmations : null, 'Unnecessary confirmations must not increase');
    return { tier: model.tier, requestedModel: model.requestedModel, pinnedVersion: model.pinnedVersion ?? null, baseline, reference, v2, medianCostRatio: costKnown ? v2.medianCostUsd! / reference.medianCostUsd! : null };
  });
  const current = samples.filter(row => row.variant === 'v2');
  for (const field of ['duplicateEffects', 'permissionViolations', 'eventGaps'] as const) add(field, current.length > 0 && current.every(row => row[field] === 0), 'No observed violations');
  for (const id of RELEASE_VALIDATIONS) {
    const matching = validations.filter(row => row.id === id);
    add('validation:' + id, matching.length === 1 && matching[0].passed && !!matching[0].evidence.trim(), matching[0]?.evidence ?? 'Missing validation evidence');
  }
  return { kind: 'release-comparison' as const, readyForRelease: gates.every(gate => gate.passed === true), expectedSamples: expected.length, observedSamples: samples.length, errors, models: summaries, gates };
}
