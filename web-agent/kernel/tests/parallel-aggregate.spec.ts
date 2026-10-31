import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateParallelResults, parallelToolSucceeded } from '../../core/parallel';

describe('并行任务结果聚合', () => {
  test('全部成功标记 completed 并准确汇总成本', () => {
    const r = aggregateParallelResults([
      { taskId: 'a', objective: 'a', ok: true, cost: 0.1, tokensIn: 10, tokensOut: 4 },
      { taskId: 'b', objective: 'b', ok: true, cost: 0.2, tokensIn: 20, tokensOut: 6 },
    ]);
    assert.equal(r.status, 'completed');
    assert.equal(r.completed, 2);
    assert.ok(Math.abs(r.subagentCost.cost - 0.3) < 1e-9);
    assert.deepEqual({ tokensIn: r.subagentCost.tokensIn, tokensOut: r.subagentCost.tokensOut }, { tokensIn: 30, tokensOut: 10 });
  });
  test('一项失败保留失败项消耗并标记 partial', () => {
    const r = aggregateParallelResults([
      { taskId: 'a', objective: 'a', ok: true, cost: 0.1 },
      { taskId: 'b', objective: 'b', ok: false, cost: 0.07, tokensIn: 8, cancelled: false },
    ]);
    assert.equal(r.status, 'partial');
    assert.equal(r.failed, 1);
    assert.ok(Math.abs(r.subagentCost.cost - 0.17) < 1e-9);
    assert.equal(r.subagentCost.tokensIn, 8);
  });
  test('全失败且含取消标记 failed/cancelled', () => {
    const r = aggregateParallelResults([
      { taskId: 'a', objective: 'a', ok: false, cost: 0.02, cancelled: true },
      { taskId: 'b', objective: 'b', ok: false, cost: 0.03 },
    ]);
    assert.equal(r.status, 'failed');
    assert.equal(r.cancelled, 1);
    assert.equal(r.completed, 0);
    assert.equal(parallelToolSucceeded(r), false);
  });

  test('部分成功仍可作为编排工具成功返回，但保留 partial 状态', () => {
    const r = aggregateParallelResults([
      { taskId: 'a', objective: 'a', ok: true },
      { taskId: 'b', objective: 'b', ok: false },
    ]);
    assert.equal(r.status, 'partial');
    assert.equal(parallelToolSucceeded(r), true);
  });
});
