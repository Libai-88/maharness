import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData, mergeDiary, mergeMeta } from '../index';

const t = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, updatedAt, ...extra });

describe('workbench 桥合并', () => {
  it('LWW：updatedAt 大者胜出', () => {
    const local = { tasks: [t('a', 100, { title: '旧' })], notes: [], projects: [], tomb: {} };
    const remote = { tasks: [t('a', 200, { title: '新' })], notes: [], projects: [], tomb: {} };
    const m = mergeData(local, remote);
    assert.equal(m.tasks.length, 1);
    assert.equal(m.tasks[0].title, '新');
  });

  it('并集：单边独有记录保留', () => {
    const m = mergeData(
      { tasks: [t('a', 1)], notes: [], projects: [], tomb: {} },
      { tasks: [t('b', 1)], notes: [], projects: [], tomb: {} },
    );
    assert.deepEqual(m.tasks.map(x => x.id).sort(), ['a', 'b']);
  });

  it('墓碑：删除时间较新则消失，较旧则复活并清除墓碑', () => {
    const T0 = Date.now();
    const gone = mergeData(
      { tasks: [t('a', T0 - 5000)], notes: [], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [], tomb: { a: T0 } },
    );
    assert.equal(gone.tasks.length, 0);

    const revived = mergeData(
      { tasks: [t('a', T0 + 5000)], notes: [], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [], tomb: { a: T0 } },
    );
    assert.equal(revived.tasks.length, 1);
    assert.equal(revived.tomb.a, undefined);
  });

  it('墓碑：超过 90 天自动清理', () => {
    const ancient = Date.now() - 91 * 864e5;
    const m = mergeData(
      { tasks: [], notes: [], projects: [], tomb: { a: ancient } },
      { tasks: [], notes: [], projects: [], tomb: {} },
    );
    assert.equal(m.tomb.a, undefined);
  });

  it('_s 示例记录：仅一方存在示例时不把示例合并进真实数据', () => {
    const m = mergeData(
      { tasks: [t('real', 100)], notes: [], projects: [], tomb: {} },
      { tasks: [t('demo', 200, { _s: true })], notes: [], projects: [], tomb: {} },
    );
    assert.deepEqual(m.tasks.map(x => x.id), ['real']);
  });

  it('notes / projects 独立合并，互不串档', () => {
    const m = mergeData(
      { tasks: [], notes: [{ id: 'n1', text: 'x', tags: [], createdAt: 1, updatedAt: 5 }], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [{ id: 'p1', name: 'P', stage: '', next: '', blocker: '', status: 'active', updatedAt: 5 }], tomb: {} },
    );
    assert.equal(m.notes.length, 1);
    assert.equal(m.projects.length, 1);
    assert.equal(m.tasks.length, 0);
  });

  it('mergeDiary 按日期时间戳取新', () => {
    const r = mergeDiary({ '2026-09-01': '本地' }, { '2026-09-01': 100 }, { '2026-09-01': '远端' }, { '2026-09-01': 200 });
    assert.equal(r.diary['2026-09-01'], '远端');
    assert.equal(r.diaryTs['2026-09-01'], 200);
  });

  it('mergeMeta pomoLog 取每日最大值，sample 需双方同时存在', () => {
    const local = { meta: { pomoLog: { '2026-09-01': 5 }, sample: true } } as never;
    const remote = { meta: { pomoLog: { '2026-09-01': 3 }, sample: false } } as never;
    const m = mergeMeta(local, remote);
    assert.equal(m.pomoLog['2026-09-01'], 5);
    assert.equal(m.sample, false);
  });
});
