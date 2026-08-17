/**
 * kernel/tests/scope.spec.ts —— EffectScope 可逆效应引擎回归测试
 * 覆盖：LIFO 逆序恢复 / dispose 幂等 / armed 后 add no-op / child 级联与摘除 /
 * 异步 effect 登记 / 单逆元失败不阻断 / remove 式 disposer 不二次执行。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectScope } from '../scope';

describe('EffectScope 可逆效应', () => {
  test('dispose 按 LIFO 逆序执行逆元（后注册的先恢复）', async () => {
    const scope = new EffectScope();
    const order: string[] = [];
    scope.add(() => { order.push('first'); });
    scope.add(() => { order.push('second'); });
    scope.add(() => { order.push('third'); });
    await scope.dispose();
    assert.deepEqual(order, ['third', 'second', 'first']);
    assert.equal(scope.reverted, 3);
  });

  test('dispose 幂等：二次调用不重复执行（self-disposal）', async () => {
    const scope = new EffectScope();
    let count = 0;
    scope.add(() => { count++; });
    await scope.dispose();
    await scope.dispose();
    assert.equal(count, 1);
    assert.equal(scope.isArmed, false);
  });

  test('armed=false 后 add 是 no-op（在途操作不留下尾巴）', async () => {
    const scope = new EffectScope();
    await scope.dispose();
    const remove = scope.add(() => { throw new Error('不应执行'); });
    remove(); // 手动调用也应安全
    assert.equal(scope.size, 0);
  });

  test('remove 式 disposer：先移除再手动执行 → dispose 不二次执行', async () => {
    const scope = new EffectScope();
    let count = 0;
    const inverse = () => { count++; };
    const remove = scope.add(inverse);
    remove();       // 从作用域摘除
    inverse();      // 手动执行
    await scope.dispose();
    assert.equal(count, 1, 'dispose 不应再次执行已手动撤销的逆元');
  });

  test('child：父级 dispose 级联回收子级；子级单独 dispose 后父级不再二次回收', async () => {
    const parent = new EffectScope();
    const child = parent.child();
    let childReverted = 0;
    let parentReverted = 0;
    child.add(() => { childReverted++; });
    parent.add(() => { parentReverted++; });

    // 子级单独 dispose：自身逆元执行，且从父级摘除
    await child.dispose();
    assert.equal(childReverted, 1);
    assert.equal(parentReverted, 0);

    await parent.dispose();
    assert.equal(parentReverted, 1, '父级自身逆元执行');
    assert.equal(childReverted, 1, '子级不被父级二次回收');
  });

  test('effect：异步 callback 的逆元被登记并在 dispose 时执行', async () => {
    const scope = new EffectScope();
    const log: string[] = [];
    await scope.effect(
      async () => { log.push('run'); return 'result'; },
      (v) => () => { log.push(`revert:${v}`); },
    );
    assert.deepEqual(log, ['run']);
    await scope.dispose();
    assert.deepEqual(log, ['run', 'revert:result']);
  });

  test('effect：callback 抛错时不登记逆元', async () => {
    const scope = new EffectScope();
    await assert.rejects(
      scope.effect(
        async () => { throw new Error('setup failed'); },
        () => () => { throw new Error('不应执行'); },
      ),
      /setup failed/,
    );
    assert.equal(scope.size, 0);
  });

  test('单个逆元抛错不阻断其余逆元，reverted 只计成功的', async () => {
    const scope = new EffectScope();
    const order: string[] = [];
    scope.add(() => { order.push('bad'); throw new Error('boom'); });
    scope.add(() => { order.push('good'); });
    await scope.dispose();
    assert.deepEqual(order, ['good', 'bad'], 'LIFO 逆序，坏逆元不阻断');
    assert.equal(scope.reverted, 1, '只计成功的');
  });
});
