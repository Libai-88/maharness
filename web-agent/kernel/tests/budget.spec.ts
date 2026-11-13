/** Delegation capacity and accounting contracts. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, classifyTask, reasoningBudgetFor, reserveBudget } from '../budget';

const tmp = () => mkdtempSync(join(tmpdir(), 'mh-budget-'));

describe('委派次数与模型方法独立', () => {
  test('同会话连续委派不受时间窗口次数限制', () => {
    const budget = new Budget(1);
    for (let i = 0; i < 100; i++) {
      const reservation = budget.consumeSubagentQuota('s');
      assert.equal(reservation.allowed, true);
      reservation.refund?.(); reservation.refund?.();
      budget.consumeSubagent();
    }
    assert.equal(budget.subagentQuota().allowed, true);
  });
  test('画像分类不改变模型预算', () => {
    assert.equal(classifyTask('代码 bug'), '代码');
    for (const type of ['代码', '问答', '其他']) assert.equal(reasoningBudgetFor(type, 800), 800);
  });
});

describe('并行预算预留与结算', () => {
  test('份额总和等于预算，实际消耗后释放未用部分', () => {
    const r = reserveBudget(1, 3);
    assert.equal(r.shares.reduce((a, b) => a + b, 0), 1);
    assert.equal(r.reserved, 1);
    assert.equal(r.settle(0, 0.1).refund, r.shares[0] - 0.1);
    assert.equal(r.settle(0, 0.2).actual, 0, '重复结算幂等');
    assert.equal(r.settle(1, 0.2).actual, 0.2);
    assert.ok(r.remaining <= 0.7 + 1e-9);
  });
  test('非法预算与空任务不产生负份额', () => {
    assert.deepEqual(reserveBudget(-1, 2).shares, [0, 0]);
    assert.deepEqual(reserveBudget(1, 0).shares, []);
  });
});

describe('并行子任务全局并发上限', () => {
  test('子代理、审查与并行批次共用原子槽位，release 幂等', () => {
    const dir = tmp();
    try {
    const budget = new Budget(24, join(dir, 'task-profile.json'));
    const releaseA = budget.reserveSubagentSlots(8)!;
    const releaseB = budget.reserveSubagentSlots(8)!;
    assert.equal(budget.activeSubagentCount(), 16);
    assert.equal(budget.reserveSubagentSlots(1), undefined);
    releaseA();
    releaseA();
    assert.equal(budget.activeSubagentCount(), 8);
    const releaseC = budget.reserveSubagentSlots(8);
    assert.ok(releaseC);
    releaseB();
    releaseC();
    assert.equal(budget.activeSubagentCount(), 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('重叠压力：100 个并发申请最多允许 16 个活动槽位，最终完全释放', async () => {
    const dir = tmp();
    try {
      const budget = new Budget(24, join(dir, 'task-profile.json'));
      let peak = 0;
      const releases: (() => void)[] = [];
      await Promise.all(Array.from({ length: 100 }, async () => {
        await Promise.resolve();
        const release = budget.reserveSubagentSlots(1);
        if (release) {
          releases.push(release);
          peak = Math.max(peak, budget.activeSubagentCount());
        }
      }));
      assert.equal(releases.length, 16);
      assert.equal(peak, 16);
      for (const release of releases) release();
      assert.equal(budget.activeSubagentCount(), 0);
      const finalRelease = budget.reserveSubagentSlots(16);
      assert.ok(finalRelease, '释放后应可重新取得完整容量');
      finalRelease?.();
      assert.equal(budget.activeSubagentCount(), 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
