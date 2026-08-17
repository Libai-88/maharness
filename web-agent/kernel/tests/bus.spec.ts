/**
 * kernel/tests/bus.spec.ts —— EventBus 五语义派发回归测试（node:test，零新依赖）
 * 覆盖：serial 短路 / bail / parallel 聚合错误 / waterfall 洋葱链（顺序、改写、短路接管）/
 * onPhase 三阶段 / 通配符 / priority 排序 / 递归深度保护 / 退订。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus';

describe('EventBus 基础', () => {
  test('on/off：退订后不再收到事件', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('x', () => { count++; });
    bus.emit(EventBus.event('x'));
    assert.equal(count, 1);
    off();
    bus.emit(EventBus.event('x'));
    assert.equal(count, 1, '退订后不应再收到');
  });

  test('通配符：agent.* 匹配 agent.turn.started，不匹配其他域', () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.on('agent.*', (e) => got.push(e.type));
    bus.emit(EventBus.event('agent.turn.started'));
    bus.emit(EventBus.event('agent.before_llm'));
    bus.emit(EventBus.event('tool.call'));
    assert.deepEqual(got, ['agent.turn.started', 'agent.before_llm']);
  });

  test('priority：高优先级先执行；同优先级按订阅序', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('x', () => order.push('a'), 0);
    bus.on('x', () => order.push('b'), 10);
    bus.on('x', () => order.push('c'), 5);
    bus.emit(EventBus.event('x'));
    assert.deepEqual(order, ['b', 'c', 'a']);
  });

  test('emit 中单个监听器抛错不影响其他监听器', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => order.push('ok'));
    assert.doesNotThrow(() => bus.emit(EventBus.event('x')));
    assert.deepEqual(order, ['ok']);
  });

  test('递归深度保护：监听器无条件 re-emit 超过 64 层抛错', () => {
    const bus = new EventBus();
    bus.on('loop', () => bus.emit(EventBus.event('loop')));
    assert.throws(() => bus.emit(EventBus.event('loop')), /递归深度/);
  });
});

describe('EventBus serial / bail（短路）', () => {
  test('serial：首个非 null/undefined/false 的返回短路，后续监听器不执行', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('x', () => { order.push('a'); return null; });
    bus.on('x', () => { order.push('b'); return 42; });
    bus.on('x', () => { order.push('c'); return 7; });
    const r = await bus.serial(EventBus.event('x'));
    assert.equal(r, 42);
    assert.deepEqual(order, ['a', 'b'], 'c 不应执行（已短路）');
  });

  test('serial：全链无返回 → undefined', async () => {
    const bus = new EventBus();
    bus.on('x', () => undefined);
    bus.on('x', () => false);
    const r = await bus.serial(EventBus.event('x'));
    assert.equal(r, undefined);
  });

  test('bail：同步版本的首个非空返回', () => {
    const bus = new EventBus();
    bus.on('x', () => undefined);
    bus.on('x', () => 'answer');
    bus.on('x', () => 'later');
    const r = bus.bail(EventBus.event('x'));
    assert.equal(r, 'answer');
  });

  test('serial 等待异步监听器', async () => {
    const bus = new EventBus();
    bus.on('x', async () => { await new Promise((r) => setTimeout(r, 5)); return 'async-value'; });
    const r = await bus.serial(EventBus.event('x'));
    assert.equal(r, 'async-value');
  });
});

describe('EventBus parallel（并发）', () => {
  test('parallel：全部完成后返回，错误聚合成 AggregateError', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('x', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('slow'); });
    bus.on('x', async () => { order.push('fast'); throw new Error('boom1'); });
    bus.on('x', async () => { throw new Error('boom2'); });
    await assert.rejects(
      bus.parallel(EventBus.event('x')),
      (err: unknown) => err instanceof AggregateError
        && err.errors.length === 2
        && err.errors.every((e) => e instanceof Error && e.message.startsWith('boom')),
    );
    assert.deepEqual(order, ['fast', 'slow'], '并发执行，全部 await');
  });

  test('parallel：全部成功则 resolve', async () => {
    const bus = new EventBus();
    bus.on('x', () => Promise.resolve());
    await assert.doesNotReject(bus.parallel(EventBus.event('x')));
  });
});

describe('EventBus waterfall（洋葱中间件）', () => {
  test('按 priority 顺序串联，监听器改写 e.data 传播到下游与 final', async () => {
    const bus = new EventBus();
    const out: string[] = [];
    bus.on('wf', (e) => {
      out.push('m1');
      (e.data as { count: number }).count += 1; // 改写
    }, 10);
    bus.on('wf', (e) => {
      out.push(`m2:${(e.data as { count: number }).count}`);
    }, 0);
    const r = await bus.waterfall('wf', { count: 1 }, (data: unknown) => {
      out.push(`final:${JSON.stringify(data)}`);
      return 'done';
    });
    assert.equal(r, 'done');
    assert.deepEqual(out, ['m1', 'm2:2', 'final:{"count":2}'], '改写沿链传播');
  });

  test('监听器 return 非 undefined 短路接管（链停，final 不执行）', async () => {
    const bus = new EventBus();
    const out: string[] = [];
    bus.on('wf', () => { out.push('short'); return '接管结果'; });
    bus.on('wf', () => { out.push('m2'); });
    const r = await bus.waterfall('wf', { count: 1 }, () => { out.push('final'); return 'done'; });
    assert.equal(r, '接管结果');
    assert.deepEqual(out, ['short'], '短路后链停止');
  });

  test('e.next 手动调用：监听器可在异步操作后改写再继续', async () => {
    const bus = new EventBus();
    const out: string[] = [];
    bus.on('wf', async (e) => {
      out.push('before-await');
      await new Promise((r) => setTimeout(r, 5));
      out.push('after-await');
      e.next?.({ rewritten: true }); // 携带改写后的 data 继续
    });
    const r = await bus.waterfall('wf', { raw: 1 }, (data: unknown) => {
      out.push(`final:${JSON.stringify(data)}`);
      return 'ok';
    });
    assert.equal(r, 'ok');
    assert.deepEqual(out, ['before-await', 'after-await', 'final:{"rewritten":true}']);
  });

  test('无监听器时直接落 final', async () => {
    const bus = new EventBus();
    const r = await bus.waterfall('wf', { a: 1 }, (data: unknown) => (data as { a: number }).a + 1);
    assert.equal(r, 2);
  });

  test('缺少 final 回调抛 TypeError', async () => {
    const bus = new EventBus();
    // waterfall 是 async 函数：throw 在 promise 内 → 用 rejects 断言
    await assert.rejects(bus.waterfall('wf', { a: 1 }), TypeError);
  });
});

describe('EventBus onPhase（声明式三阶段钩子）', () => {
  test('before/rewrite/after 依次执行，after 收到最终结果', async () => {
    const bus = new EventBus();
    const phases: string[] = [];
    bus.onPhase('ph', {
      before: (v) => phases.push(`before:${v}`),
      rewrite: (v) => { phases.push('rewrite'); return `${v}!`; },
      after: (result, value) => phases.push(`after:${result}:${value}`),
    });
    const r = await bus.waterfall('ph', 'data', (d: unknown) => { phases.push(`final:${d}`); return 'RESULT'; });
    assert.equal(r, 'RESULT');
    assert.deepEqual(phases, ['before:data', 'rewrite', 'final:data!', 'after:RESULT:data!']);
  });

  test('onPhase 不短路：next 继续链', async () => {
    const bus = new EventBus();
    const out: string[] = [];
    bus.onPhase('ph', { before: () => out.push('hook') });
    bus.on('ph', () => { out.push('listener'); }); // 块体：返回 undefined，不误触短路
    const r = await bus.waterfall('ph', 1, (d: unknown) => { out.push(`final:${d}`); return d; });
    assert.equal(r, 1);
    assert.deepEqual(out, ['hook', 'listener', 'final:1']);
  });
});
