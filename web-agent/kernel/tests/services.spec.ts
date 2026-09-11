/**
 * kernel/tests/services.spec.ts —— 服务绑定仲裁与「可接管」语义回归测试
 *
 * 第一性原理：可组合性的前提是「同一位置可以被不同实现占据，且占据关系可预测」。
 * 旧实现是单槽 Map —— 两个插件提供同一键时后者静默顶掉前者，先提供者卸载还会
 * 直接把键删掉（把后来者的绑定一起带走）。本测试锁定修复后的语义：
 *  1. 同键多提供者并存：priority 大者生效；
 *  2. 同优先级先提供者胜（不被后到者静默顶掉）；
 *  3. 生效者卸载 → 自动回退次高者（服务不消失）；
 *  4. 接管/回退都会通知依赖方（inject onChange 拿到新值/旧值）；
 *  5. 低优先级候选的登记不惊动依赖方（无多余通知）；
 *  6. 全部候选卸载后才真正 withdrawn；
 *  7. bindingCandidates 可观测「谁生效、谁被接管」。
 *
 * 所有插件目录均为临时目录（mkdtemp），跑完清理，不触碰生产数据。
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel, KERNEL_PROVIDER_ID } from '../index';

interface Fixture {
  kernel: Kernel;
  rootDir: string;
  userPluginsDir: string;
  cleanup: () => void;
}

/** 每个插件在 onLoad 中提供 `svc` 键，值为其自身 id（便于断言「当前生效者是谁」） */
function setup(pluginDefs: Record<string, string>): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-svc-'));
  const dataDir = join(rootDir, 'data');
  const userPluginsDir = join(rootDir, 'plugins');
  mkdirSync(userPluginsDir, { recursive: true });
  for (const [id, onLoadBody] of Object.entries(pluginDefs)) {
    const pdir = join(userPluginsDir, id);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({ id, name: id, version: '0.1.0', entry: 'index.ts' }));
    writeFileSync(join(pdir, 'index.ts'), `export default {\n  id: '${id}',\n  name: '${id}',\n  version: '0.1.0',\n  onLoad: async (ctx) => { ${onLoadBody} },\n}`);
  }
  const kernel = new Kernel(rootDir, {}, { dataDir, userPluginsDir });
  return {
    kernel,
    rootDir,
    userPluginsDir,
    cleanup: () => {
      try { kernel.trace.flush(); } catch { /* 落盘失败不影响清理 */ }
      try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* 句柄迟释放时留待系统清理 */ }
    },
  };
}

after(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__svcOverrides;
});

describe('内核子系统可接管（cache / trace / budget 不再是不可替换的原语）', () => {
  test('无插件接管时解析到内核内置实现（行为与旧实现一致）', async (t) => {
    const f = setup({});
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const cache = f.kernel.cache;
    assert.ok(cache, 'cache 可解析');
    assert.equal(typeof cache.l1Get, 'function');
    assert.equal(typeof f.kernel.trace.startStep, 'function');
    assert.equal(typeof f.kernel.budget.consumeSubagentQuota, 'function');

    // 内置实现在候选表里以 providerId='kernel' 出现——内核是「默认提供者」而非特权旁路
    const cands = f.kernel.plugins.bindingCandidates('service:cache');
    assert.equal(cands.length, 1);
    assert.equal(cands[0].pluginId, KERNEL_PROVIDER_ID);
    assert.equal(cands[0].active, true);
  });

  test('插件以更高优先级接管 service:cache；卸载后自动回退内核内置', async (t) => {
    // 一个最小可用的缓存替身：只需要被测代码实际调用的那几个方法
    const stub = `const impl = {
      l1Get: async () => undefined,
      l1Set: async () => {},
      makeKey: (parts) => parts.join(':'),
      l2Get: () => undefined,
      l2Set: () => {},
      mark: 'plugin-cache',
    };
    ctx.provide('service:cache', impl, 10);`;
    const f = setup({ cacheOverride: stub });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const taken = f.kernel.cache as unknown as { mark?: string };
    assert.equal(taken.mark, 'plugin-cache', '插件接管了内核缓存');
    assert.equal(f.kernel.plugins.bindingCandidates('service:cache').length, 2, '内置与插件候选并存');

    await f.kernel.plugins.disable('cacheOverride');
    const back = f.kernel.cache as unknown as { mark?: string; l1Get?: unknown };
    assert.equal(back.mark, undefined, '停用后回退到内核内置实现');
    assert.equal(typeof back.l1Get, 'function', '回退后仍是可用实现');
  });

  test('无插件接管时 kernel.cache 保持稳定身份（热路径不做无谓重建）', async (t) => {
    const f = setup({});
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.cache, f.kernel.cache, '同一实例（缓存是热路径，身份必须稳定）');
    assert.equal(f.kernel.trace, f.kernel.trace);
  });

  test('插件可接管 service:trace 与 service:budget（内核全部子系统同权可换）', async (t) => {
    const stub = `ctx.provide('service:trace', { startStep: () => ({ id: 'x', finish: () => {}, fail: () => {}, cancel: () => {} }), mark: 'plugin-trace' }, 10);
    ctx.provide('service:budget', { consumeSubagentQuota: () => ({ allowed: true, remaining: 99 }), mark: 'plugin-budget' }, 10);`;
    const f = setup({ subsystemOverride: stub });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    assert.equal((f.kernel.trace as unknown as { mark?: string }).mark, 'plugin-trace');
    assert.equal((f.kernel.budget as unknown as { mark?: string }).mark, 'plugin-budget');
    assert.equal(f.kernel.budget.consumeSubagentQuota('s1').remaining, 99, '调用点经解析层拿到插件实现');
  });
});

describe('服务绑定仲裁（可接管语义）', () => {
  test('priority 大者生效，低优先级候选并存但不生效', async (t) => {
    const f = setup({
      base: `ctx.provide('svc', 'base', 0);`,
      plugin: `ctx.provide('svc', 'plugin', 10);`,
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    assert.equal(f.kernel.plugins.resolveService('svc'), 'plugin', '高优先级插件生效');
    const cands = f.kernel.plugins.bindingCandidates('svc');
    assert.equal(cands.length, 2, '两个候选并存（不再互相覆盖）');
    assert.equal(cands[0].pluginId, 'plugin');
    assert.equal(cands[0].active, true);
    assert.equal(cands[1].pluginId, 'base');
    assert.equal(cands[1].active, false);
  });

  test('同优先级先提供者胜——后到者不静默顶掉', async (t) => {
    const f = setup({
      first: `ctx.provide('svc', 'first', 0);`,
      second: `ctx.provide('svc', 'second', 0);`,
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    assert.equal(f.kernel.plugins.resolveService('svc'), 'first', '同优先级先到者胜（确定性）');
  });

  test('生效者卸载 → 自动回退次高者，服务不消失', async (t) => {
    const f = setup({
      base: `ctx.provide('svc', 'base', 0);`,
      plugin: `ctx.provide('svc', 'plugin', 10);`,
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.plugins.resolveService('svc'), 'plugin');

    await f.kernel.plugins.disable('plugin');
    assert.equal(f.kernel.plugins.resolveService('svc'), 'base', '接管者停用后回退到原实现');
    assert.equal(f.kernel.plugins.bindingCandidates('svc').length, 1);
  });

  test('接管与回退都通知依赖方（inject onChange 收到新值/旧值）', async (t) => {
    const f = setup({
      base: `ctx.provide('svc', 'base', 0);`,
      plugin: `ctx.provide('svc', 'plugin', 10);`,
      consumer: `globalThis.__svcOverrides = []; ctx.inject('svc', (v) => globalThis.__svcOverrides.push(v));`,
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const seen = () => (globalThis as unknown as { __svcOverrides: unknown[] }).__svcOverrides;

    // 装载顺序（core→用户目录按 id 拓扑）：consumer 依赖声明登记后，其收到的事件序列取决于
    // 其余插件的装载顺序。此处只断言「最终生效值」与「回退被通知」两件事实。
    const afterLoad = f.kernel.plugins.resolveService('svc');
    assert.equal(afterLoad, 'plugin');

    await f.kernel.plugins.disable('plugin');
    assert.ok(seen().includes('base'), '回退到 base 时依赖方收到 base（而非 undefined 的「服务消失」）');

    await f.kernel.plugins.enable('plugin');
    assert.ok(seen().includes('plugin'), '接管者重新上线时依赖方收到 plugin');
  });

  test('全部候选卸载后才真正 withdrawn（键从注册表移除）', async (t) => {
    const f = setup({
      base: `ctx.provide('svc', 'base', 0);`,
      plugin: `ctx.provide('svc', 'plugin', 10);`,
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const withdrawn: string[] = [];
    f.kernel.bus.on('service.withdrawn', (e) => withdrawn.push((e.data as { pluginId: string }).pluginId));

    await f.kernel.plugins.disable('plugin');
    assert.equal(withdrawn.length, 0, '仍有候选（base）时不算 withdrawn');

    await f.kernel.plugins.disable('base');
    assert.equal(f.kernel.plugins.resolveService('svc'), undefined, '全部候选卸载后解析为空');
    assert.deepEqual(withdrawn, ['base']);
    assert.equal(f.kernel.plugins.serviceKeys().includes('svc'), false);
  });

  test('注册期（lazy/未启动）的 provide 不生效——「绑定只在提供者 ACTIVE 时可见」', async (t) => {
    const f = setup({ lazyHigh: `ctx.provide('svc', 'lazy', 99);` });
    t.after(f.cleanup);
    writeFileSync(join(f.userPluginsDir, 'lazyHigh', 'plugin.json'), JSON.stringify({
      id: 'lazyHigh', name: 'lazyHigh', version: '0.1.0', entry: 'index.ts', lazy: true,
    }));
    await f.kernel.plugins.loadAll();

    assert.equal(f.kernel.plugins.get('lazyHigh')?.state, 'loaded', 'lazy 插件停在 loaded');
    assert.equal(f.kernel.plugins.resolveService('svc'), undefined, '未启动的插件不占服务（旧实现在 onLoad 即发布）');
    assert.equal(f.kernel.plugins.bindingCandidates('svc').length, 1, '候选已登记（可观测：谁声明了）');

    await f.kernel.plugins.enable('lazyHigh');
    assert.equal(f.kernel.plugins.resolveService('svc'), 'lazy', '启动后才生效');

    await f.kernel.plugins.disable('lazyHigh');
    assert.equal(f.kernel.plugins.resolveService('svc'), undefined, '停用后撤回');
  });

  test('接管发出 service.overridden，非最高优先级登记发出 service.declared', async (t) => {
    const f = setup({
      base: `ctx.provide('svc', 'base', 5);`,
      low1: `ctx.provide('svc', 'low1', 1);`,
      high: `ctx.provide('svc', 'high', 20);`,
    });
    t.after(f.cleanup);
    // high 延迟启动：先让 base 生效，再观察「活动提供者被接管」的事件语义
    writeFileSync(join(f.userPluginsDir, 'high', 'plugin.json'), JSON.stringify({
      id: 'high', name: 'high', version: '0.1.0', entry: 'index.ts', lazy: true,
    }));

    const events: string[] = [];
    f.kernel.bus.on('service.provided', (e) => events.push(`provided:${(e.data as { pluginId: string }).pluginId}`));
    f.kernel.bus.on('service.overridden', (e) => events.push(`overridden:${(e.data as { pluginId: string }).pluginId}`));
    f.kernel.bus.on('service.declared', (e) => events.push(`declared:${(e.data as { pluginId: string }).pluginId}`));

    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.plugins.resolveService('svc'), 'base', 'base 先生效');
    assert.ok(events.includes('provided:base'), '首个生效绑定发 provided');
    assert.ok(events.includes('declared:low1'), '低优先级并存候选发 declared（不惊动依赖方）');
    assert.equal(events.some((e) => e.startsWith('overridden')), false, '无活动提供者被顶替时不发 overridden');

    events.length = 0;
    await f.kernel.plugins.enable('high');
    assert.deepEqual(events, ['overridden:high'], '高优先级上线接管活动绑定：只发 overridden');
    assert.equal(f.kernel.plugins.resolveService('svc'), 'high');

    events.length = 0;
    await f.kernel.plugins.disable('high');
    assert.deepEqual(events, ['provided:base'], '接管者停用：回退到 base（provided 而非 withdrawn）');
    assert.equal(f.kernel.plugins.resolveService('svc'), 'base');
  });
});
