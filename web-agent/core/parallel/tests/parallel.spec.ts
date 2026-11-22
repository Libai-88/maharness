import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateParallelResults, normalizeParallelTasks, parallelToolSucceeded, planParallelWaves, splitBudget } from '../index';

describe('并行任务编排纯函数', () => {
  it('拒绝少于 2 个任务、重复 id、未知依赖和环', () => {
    assert.match(normalizeParallelTasks([{ objective: 'one' }]).error ?? '', /至少 2 个/);
    assert.match(
      normalizeParallelTasks([
        { id: 'a', objective: 'A' },
        { id: 'a', objective: 'B' },
      ]).error ?? '',
      /重复/,
    );
    assert.match(
      normalizeParallelTasks([
        { id: 'a', objective: 'A' },
        { id: 'b', objective: 'B', dependsOn: ['missing'] },
      ]).error ?? '',
      /不存在/,
    );
    assert.match(
      normalizeParallelTasks([
        { id: 'a', objective: 'A', dependsOn: ['b'] },
        { id: 'b', objective: 'B', dependsOn: ['a'] },
      ]).error ?? '',
      /环/,
    );
  });

  it('按依赖波次调度并保留原顺序', () => {
    const normalized = normalizeParallelTasks([
      { id: 'a', objective: 'A' },
      { id: 'b', objective: 'B' },
      { id: 'c', objective: 'C', dependsOn: ['a', 'b'] },
    ]);
    assert.ok(normalized.tasks);
    assert.deepEqual(planParallelWaves(normalized.tasks!), [['a', 'b'], ['c']]);
  });

  it('聚合失败仍保留已完成成本与部分成功状态', () => {
    const aggregate = aggregateParallelResults([
      { taskId: 'a', objective: 'A', ok: true, cost: 0.2, tokensIn: 10, tokensOut: 5 },
      { taskId: 'b', objective: 'B', ok: false, cancelled: true, cost: 0.1 },
    ]);
    assert.equal(aggregate.status, 'partial');
    assert.equal(aggregate.completed, 1);
    assert.equal(aggregate.failed, 1);
    assert.equal(aggregate.cancelled, 1);
    assert.equal(aggregate.subagentCost.cost, 0.30000000000000004);
    assert.equal(parallelToolSucceeded(aggregate), true);
    assert.equal(parallelToolSucceeded({ status: 'failed' }), false);
  });

  it('整数预算均分且余数归最后一项', () => {
    assert.deepEqual(splitBudget(10, 3), [3, 3, 4]);
    assert.deepEqual(splitBudget(undefined, 2), [undefined, undefined]);
  });
});
