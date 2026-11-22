import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDependencyContext, normalizeParallelTasks, planParallelWaves } from '../../core/parallel';

describe('并行任务依赖 DAG', () => {
  test('无依赖任务同批调度，依赖任务进入后续批次', () => {
    const normalized = normalizeParallelTasks([
      { id: 'research', objective: '调研' },
      { id: 'draft', objective: '起草', dependsOn: ['research'] },
      { id: 'review', objective: '复核', dependsOn: ['draft'] },
    ]);
    assert.equal(normalized.error, undefined);
    assert.deepEqual(planParallelWaves(normalized.tasks!), [['research'], ['draft'], ['review']]);
  });

  test('多个独立起点可与共同下游共存', () => {
    const normalized = normalizeParallelTasks([
      { id: 'a', objective: 'A' },
      { id: 'b', objective: 'B' },
      { id: 'merge', objective: '汇总', dependsOn: ['a', 'b'] },
    ]);
    assert.deepEqual(planParallelWaves(normalized.tasks!), [['a', 'b'], ['merge']]);
  });

  test('重复 id、未知依赖与环均被拒绝', () => {
    assert.match(
      String(
        normalizeParallelTasks([
          { id: 'same', objective: 'A' },
          { id: 'same', objective: 'B' },
        ]).error,
      ),
      /重复/,
    );
    assert.match(
      String(
        normalizeParallelTasks([
          { id: 'a', objective: 'A', dependsOn: ['missing'] },
          { id: 'b', objective: 'B' },
        ]).error,
      ),
      /不存在/,
    );
    assert.match(
      String(
        normalizeParallelTasks([
          { id: 'a', objective: 'A', dependsOn: ['b'] },
          { id: 'b', objective: 'B', dependsOn: ['a'] },
        ]).error,
      ),
      /环/,
    );
  });

  test('依赖结论只注入成功上游并限制长度', () => {
    const result = composeDependencyContext(
      { objective: '基于上游起草', dependsOn: ['a', 'b'] },
      new Map([
        ['a', { objective: 'A', ok: true, answer: 'A 的结论' }],
        ['b', { objective: 'B', ok: false, answer: '不应注入' }],
      ]),
    );
    assert.match(result, /基于上游起草/);
    assert.match(result, /A 的结论/);
    assert.doesNotMatch(result, /不应注入/);
  });
});
