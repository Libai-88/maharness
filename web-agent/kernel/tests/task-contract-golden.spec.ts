import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveTaskContract } from '../task-contract';
import type { TaskContract } from '../task-verifier';

interface GoldenCase {
  name: string;
  objective: string;
  now?: number;
  acceptance: TaskContract['acceptance'];
  risk?: TaskContract['risk'];
  deadlineAt?: number;
  costBudgetUsd?: number;
  inference: NonNullable<TaskContract['inference']>;
}

const cases = JSON.parse(readFileSync(new URL('./fixtures/task-contract-golden.json', import.meta.url), 'utf8')) as GoldenCase[];

describe('任务契约开放式目标 golden', () => {
  for (const expected of cases) {
    test(expected.name, () => {
      const actual = deriveTaskContract(expected.objective, expected.now);
      assert.deepEqual(actual.acceptance, expected.acceptance);
      assert.equal(actual.risk, expected.risk);
      assert.equal(actual.deadlineAt, expected.deadlineAt);
      assert.equal(actual.costBudgetUsd, expected.costBudgetUsd);
      assert.deepEqual(actual.inference, expected.inference);
      if (expected.inference.needsConfirmation) assert.equal(actual.acceptance.length, 0);
    });
  }
});
