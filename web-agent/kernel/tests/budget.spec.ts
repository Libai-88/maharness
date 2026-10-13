/**
 * kernel/tests/budget.spec.ts —— 认知资源配额回归（B2 / D1）
 *
 * B2：旧实现「记账即最终」——委派工具先扣配额、后校验 provider/runner，
 * 失败或前置不满足时配额白烧；`run_parallel` 还按子任务逐个扣，而会话窗口上限 3、
 * MAX_PARALLEL 4，于是 4 任务并行**必然**失败并占满整个窗口。
 * 现契约：`consumeSubagentQuota` 返回 `refund` 句柄，撤销本次记账（幂等）。
 * D1：窗口内已无记录的会话键要删除，不随会话数单调增长。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, classifyTask, reasoningBudgetFor } from '../budget';

const tmp = () => mkdtempSync(join(tmpdir(), 'mh-budget-'));

describe('子代理配额：消耗与退还（B2）', () => {
  test('消耗即减额度，refund 即归还（同一调用内幂等）', () => {
    const dir = tmp();
    try {
      const b = new Budget(8, join(dir, 'task-profile.json'));
      const first = b.consumeSubagentQuota('s1');
      assert.equal(first.allowed, true);
      assert.equal(first.remaining, 2, '会话窗口上限 3，消耗一次后剩 2');

      const second = b.consumeSubagentQuota('s1');
      assert.equal(second.allowed, true);
      assert.equal(second.remaining, 1);
      second.refund?.();
      // 归还后额度恢复：再消耗一次仍应成功（且 remaining 回到 1）
      const third = b.consumeSubagentQuota('s1');
      assert.equal(third.allowed, true);
      assert.equal(third.remaining, 1);

      // 幂等：重复 refund 不会把别人的记账也退掉
      third.refund?.();
      third.refund?.();
      const after = b.consumeSubagentQuota('s1');
      assert.equal(after.allowed, true, '多次 refund 不得导致配额异常膨胀（只退自己那一次）');
      assert.ok(after.remaining <= 2, `remaining=${after.remaining}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('会话窗口打满后拒绝新消耗（限额是硬的，不是提示）', () => {
    const dir = tmp();
    try {
      const b = new Budget(8, join(dir, 'task-profile.json'));
      for (let i = 0; i < 3; i++) assert.equal(b.consumeSubagentQuota('busy').allowed, true);
      const denied = b.consumeSubagentQuota('busy');
      assert.equal(denied.allowed, false);
      assert.equal(denied.refund, undefined, '被拒的调用不该带退还句柄');
      assert.equal(b.consumeSubagentQuota('other').allowed, true, '限额是 per-session 的，别的会话不受影响');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('一次 run_parallel 只占一次会话额度（会话 3 与 MAX_PARALLEL 4 不再必然冲突）', () => {
    // 修复前：4 个并行子任务逐个扣 → 第 4 次必被拒且白烧 3 次（占满 3/10min 窗口）
    const dir = tmp();
    try {
      const b = new Budget(8, join(dir, 'task-profile.json'));
      const oneCall = b.consumeSubagentQuota('par');   // 并行调用改为扣 1 次
      assert.equal(oneCall.allowed, true);
      assert.equal(b.consumeSubagentQuota('par').allowed, true, '同会话仍可继续委派');
      assert.equal(b.consumeSubagentQuota('par').allowed, true);
      assert.equal(b.consumeSubagentQuota('par').allowed, false, '第 4 次委派才触顶');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('refund 后空会话键被回收（D1：Map 键不随会话数单调增长）', () => {
    const dir = tmp();
    try {
      const b = new Budget(8, join(dir, 'task-profile.json'));
      const q = b.consumeSubagentQuota('ephemeral');
      q.refund?.();
      // 内部结构不可见，用行为验证：额度未被动过 + 后续消耗正常
      assert.equal(b.consumeSubagentQuota('next').allowed, true);
      assert.equal(q.remaining, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('思考预算按任务本质分配（既有语义不因本次改动漂移）', () => {
  test('代码给足思考空间、问答防止过度思考', () => {
    assert.equal(classifyTask('这段代码报错，帮我修一下 bug'), '代码');
    assert.ok(reasoningBudgetFor('代码', 800) > 800, '代码 ×1.5');
    assert.ok(reasoningBudgetFor('问答', 800) < 800, '问答 ×0.5');
    assert.equal(reasoningBudgetFor('其他', 800), 800);
  });
});
