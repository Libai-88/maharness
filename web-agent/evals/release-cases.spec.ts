import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTasks } from './release-cases';

test('recovery grading ignores JSON key order but rejects wrong values and duplicate effects', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'maharness-grader-'));
  try {
    const task = releaseTasks().find((item) => item.id === 'recovery-ledger-1')!;
    writeFileSync(join(workspace, 'receipt.json'), JSON.stringify({ status: 'recorded', amount: 7, id: 'order-1' }));
    const check = (records: unknown[]) => {
      writeFileSync(join(workspace, 'ledger.jsonl'), records.map((record) => JSON.stringify(record)).join(String.fromCharCode(10)));
      return task.check(workspace).find((item) => item.name === 'side effect occurred once')!.passed;
    };
    assert.equal(check([{ amount: 7, id: 'order-1' }]), true);
    assert.equal(check([{ id: 'order-1', amount: '7' }]), false);
    assert.equal(
      check([
        { id: 'order-1', amount: 7 },
        { id: 'order-1', amount: 7 },
      ]),
      false,
    );
    assert.equal(check([]), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('code grading ignores object key order and preserves array order requirements', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'maharness-grader-'));
  try {
    const task = releaseTasks().find((item) => item.id === 'code-group')!;
    writeFileSync(join(workspace, 'solution.mjs'), 'export const solve = xs => xs.length ? { b: [2], a: [1, 3] } : {};');
    assert.equal(task.check(workspace)[0].passed, true);
    writeFileSync(join(workspace, 'solution.mjs'), 'export const solve = xs => xs.length ? { b: [2], a: [3, 1] } : {};');
    assert.equal(task.check(workspace)[0].passed, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
