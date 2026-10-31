import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateTokenBudget } from '../tokens';

describe('allocateTokenBudget', () => {
  test('分项总和稳定等于总预算，剩余额度归历史', () => {
    const budget = allocateTokenBudget(10_000);
    assert.equal(budget.total, 10_000);
    assert.equal(budget.system + budget.task + budget.history + budget.tools + budget.memory + budget.output, 10_000);
    assert.equal(budget.system, 800);
    assert.equal(budget.task, 800);
    assert.equal(budget.tools, 1200);
    assert.equal(budget.memory, 500);
    assert.equal(budget.output, 1500);
    assert.equal(budget.history, 5_200);
  });

  test('非法或小预算归一化为非负整数，显式保留区不会产生负历史', () => {
    assert.deepEqual(allocateTokenBudget(-1), { total: 0, system: 0, task: 0, history: 0, tools: 0, memory: 0, output: 0 });
    const budget = allocateTokenBudget(10, { system: 20, task: 20, tools: 20, memory: 20, output: 20 });
    assert.equal(budget.history, 0);
    assert.equal(budget.system + budget.task + budget.history + budget.tools + budget.memory + budget.output, 10);
  });
});
