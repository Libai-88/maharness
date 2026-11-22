import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseTasks, type ReleaseTask } from './release-cases';
import type { ReleaseSample, ReleaseVariant } from './release-report';

export interface StrengtheningTask extends ReleaseTask {
  interruptAfter?: 'read' | 'append' | 'long';
  supplement?: string;
  longObservation?: boolean;
}

export function strengtheningTasks(): StrengtheningTask[] {
  const original = releaseTasks();
  const get = (id: string) => original.find((task) => task.id === id)!;
  const ledger = get('recovery-ledger-1');
  const readReceipt = (workspace: string) => {
    try {
      return JSON.parse(readFileSync(join(workspace, 'receipt.json'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  return [
    get('code-median'),
    get('research-source-1'),
    get('document-csv-summary'),
    { ...ledger, id: 'recovery-after-read', interruptAfter: 'read' },
    { ...ledger, id: 'recovery-after-append', interruptAfter: 'append' },
    {
      id: 'recovery-long-result',
      category: 'recovery',
      interruptAfter: 'long',
      longObservation: true,
      files: { 'note.txt': '观察材料只通过 read_observation 提供。' },
      prompt: '调用 read_observation 读取材料。把材料最后的 proof 值写入 proof.json，字段 proof。',
      check(workspace) {
        let value: { proof?: string } | undefined;
        try {
          value = JSON.parse(readFileSync(join(workspace, 'proof.json'), 'utf8'));
        } catch {}
        return [{ name: 'tail observation recovered', passed: value?.proof === 'TAIL-7294' }];
      },
    },
    {
      ...ledger,
      id: 'recovery-supplement',
      interruptAfter: 'read',
      supplement: 'receipt.json 还必须包含 note="confirmed"。',
      check(workspace) {
        return [...ledger.check(workspace), { name: 'supplement preserved', passed: readReceipt(workspace)?.note === 'confirmed' }];
      },
    },
    get('tool-failure-schema-read'),
    get('tool-failure-version-conflict'),
    get('tool-failure-truncated-read'),
  ];
}

/** Atomic admission across concurrent samples; uncertain calls retain their reservation. */
export class TokenBudget {
  spent = 0;
  held = 0;
  stopped = false;
  constructor(readonly limit = 1_000_000) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('EVAL_TOKEN_LIMIT_INVALID');
  }
  reserve(amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('EVAL_TOKEN_RESERVATION_INVALID');
    if (this.stopped || this.spent + this.held + amount > this.limit) {
      this.stopped = true;
      throw new Error('EVAL_TOKEN_LIMIT');
    }
    this.held += amount;
    let settled = false;
    return (actual?: number) => {
      if (settled) return;
      if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error('EVAL_TOKEN_USAGE_INVALID');
      settled = true;
      this.held -= amount;
      this.spent += actual ?? amount;
      if ((actual !== undefined && actual > amount) || this.spent + this.held >= this.limit) this.stopped = true;
    };
  }
}

export interface StrengtheningSample extends ReleaseSample {
  usageComplete: boolean;
  elapsedMs: number;
  interruptionObserved: boolean;
  failureStage?: string;
}
const variants: ReleaseVariant[] = ['baseline', 'reference', 'v2'];
export function buildStrengtheningReport(
  models: string[],
  tasks: StrengtheningTask[],
  rows: StrengtheningSample[],
  revisionCurrent: boolean,
  procedureConsistent = true,
) {
  const invalid = (row: StrengtheningSample) =>
    row.runtimeError === 'EVAL_CHECKPOINT_INTERRUPT' ||
    row.failureStage === 'harness-abort' ||
    row.runtimeError === 'EVAL_HARNESS_ABORT_RECEIPTS_UNKNOWN';
  const success = (row: StrengtheningSample) =>
    row.completed && !row.runtimeError && row.assertions.length > 0 && row.assertions.every((item) => item.passed);
  const median = (values: number[]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
  };
  const key = (model: string, task: string, variant: string) => JSON.stringify([model, task, variant]);
  const expected = models.flatMap((model) => tasks.flatMap((task) => variants.map((variant) => key(model, task.id, variant))));
  const keys = rows.map((row) => key(row.tier, row.caseId, row.variant));
  const matrixComplete =
    expected.length === 60 &&
    keys.length === expected.length &&
    new Set(keys).size === keys.length &&
    keys.every((item) => expected.includes(item));
  const summaries = models.map((model) => {
    const selected = rows.filter((row) => row.tier === model);
    const byVariant = Object.fromEntries(
      variants.map((variant) => {
        const all = selected.filter((row) => row.variant === variant);
        const samples = all.filter((row) => !invalid(row));
        const recovery = samples.filter((row) => tasks.find((task) => task.id === row.caseId)?.category === 'recovery');
        return [
          variant,
          {
            samples: all.length,
            validSamples: samples.length,
            invalidSamples: all.length - samples.length,
            passed: samples.filter(success).length,
            recoveryPassed: recovery.filter(success).length,
            recoverySamples: recovery.length,
            medianCalls: median(samples.map((row) => row.calls)),
            completeUsage: samples.filter((row) => row.usageComplete).length,
          },
        ];
      }),
    ) as Record<
      ReleaseVariant,
      {
        samples: number;
        validSamples: number;
        invalidSamples: number;
        passed: number;
        recoveryPassed: number;
        recoverySamples: number;
        medianCalls: number | null;
        completeUsage: number;
      }
    >;
    const paired = tasks.flatMap((task) => {
      const reference = selected.find((row) => row.caseId === task.id && row.variant === 'reference');
      const v2 = selected.find((row) => row.caseId === task.id && row.variant === 'v2');
      return reference &&
        v2 &&
        !invalid(reference) &&
        !invalid(v2) &&
        success(reference) &&
        success(v2) &&
        reference.usageComplete &&
        v2.usageComplete
        ? [{ reference, v2 }]
        : [];
    });
    const refTokens = median(paired.map((pair) => pair.reference.tokensIn));
    const v2Tokens = median(paired.map((pair) => pair.v2.tokensIn));
    const refCalls = median(paired.map((pair) => pair.reference.calls));
    const v2Calls = median(paired.map((pair) => pair.v2.calls));
    return {
      model,
      ...byVariant,
      paired: {
        samples: paired.length,
        referenceTokens: refTokens,
        v2Tokens,
        referenceCalls: refCalls,
        v2Calls,
        tokenRatio: refTokens && v2Tokens !== null ? v2Tokens / refTokens : null,
      },
      checks: {
        quality:
          !matrixComplete || !procedureConsistent || selected.some(invalid)
            ? null
            : byVariant.v2.passed >= byVariant.reference.passed && byVariant.v2.passed >= byVariant.baseline.passed,
        recovery:
          !matrixComplete ||
          !procedureConsistent ||
          selected.some((row) => invalid(row) && tasks.find((task) => task.id === row.caseId)?.category === 'recovery')
            ? null
            : byVariant.v2.recoveryPassed >= byVariant.reference.recoveryPassed &&
              byVariant.v2.recoveryPassed >= byVariant.baseline.recoveryPassed,
        calls: refCalls === null || v2Calls === null ? null : v2Calls <= refCalls,
        tokens: !refTokens || v2Tokens === null ? null : v2Tokens <= refTokens * 1.15,
      },
    };
  });
  const v2 = rows.filter((row) => row.variant === 'v2');
  const safety = v2.some((row) => !invalid(row) && (row.duplicateEffects || row.eventGaps))
    ? false
    : !matrixComplete || v2.some(invalid)
      ? null
      : true;
  const describe = (row: StrengtheningSample) => ({
    model: row.tier,
    task: row.caseId,
    variant: row.variant,
    failureStage: row.failureStage,
    reason:
      row.runtimeError ??
      row.assertions
        .filter((item) => !item.passed)
        .map((item) => item.name)
        .join('; '),
  });
  return {
    kind: 'strengthening-comparison',
    readyForRelease: false,
    matrixComplete,
    revisionCurrent,
    procedureConsistent,
    expectedSamples: 60,
    observedSamples: rows.length,
    validSamples: rows.filter((row) => !invalid(row)).length,
    invalidSamples: rows.filter(invalid).map(describe),
    safety,
    permissionVerification: 'deterministic-suite-only',
    engineeringTargetsPassed:
      matrixComplete &&
      revisionCurrent &&
      procedureConsistent &&
      !rows.some(invalid) &&
      safety === true &&
      summaries.every((row) => Object.values(row.checks).every((value) => value === true)),
    models: summaries,
    missing: expected.filter((item) => !keys.includes(item)),
    failedSamples: rows.filter((row) => !invalid(row) && !success(row)).map(describe),
  };
}
