import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlans, savePlans, MAX_PLANS, type PlanState } from '../store';

const root = mkdtempSync(join(tmpdir(), 'maharness-plans-'));
after(() => rmSync(root, { recursive: true, force: true }));

function plan(objective: string): PlanState {
  return {
    objective,
    steps: [{ title: 'step 1', status: 'pending' }],
    current: 0,
    completed: false,
    createdAt: 1,
  };
}

describe('goal-plan 持久化', () => {
  it('原子保存并恢复计划', () => {
    const file = join(root, 'plans.json');
    const plans = new Map([['session-a', plan('a')], ['session-b', plan('b')]]);
    savePlans(file, plans);
    const loaded = loadPlans(file);
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get('session-a')?.objective, 'a');
    assert.equal(loaded.get('session-b')?.steps[0].title, 'step 1');
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
  });

  it('损坏文件回退为空计划集', () => {
    const file = join(root, 'broken.json');
    writeFileSync(file, '{broken', 'utf8');
    assert.equal(loadPlans(file).size, 0);
  });

  it('拒绝非法计划形状，保留合法项', () => {
    const file = join(root, 'mixed.json');
    writeFileSync(file, JSON.stringify({
      good: plan('good'),
      bad: { objective: 'bad', steps: [{ title: 'x', status: 'unknown' }] },
      scalar: 1,
    }), 'utf8');
    const loaded = loadPlans(file);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.get('good')?.objective, 'good');
  });

  it('恢复时执行 LRU 上限', () => {
    const file = join(root, 'lru.json');
    const plans = new Map<string, PlanState>();
    for (let i = 0; i <= MAX_PLANS; i++) plans.set(`session-${i}`, plan(`p${i}`));
    savePlans(file, plans);
    const loaded = loadPlans(file);
    assert.equal(loaded.size, MAX_PLANS);
    assert.equal(loaded.has('session-0'), false);
    assert.equal(loaded.has(`session-${MAX_PLANS}`), true);
  });
});
