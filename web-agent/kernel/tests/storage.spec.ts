/**
 * kernel/tests/storage.spec.ts —— 界外效应收敛与补偿台账回归测试
 *
 * 覆盖：私有存储读写落在 <data>/plugins/<id> / 文件名防目录穿越 /
 * 界外发射台账（jsonl + 事件 + 卸载摘要计数）/ 卸载清理策略 keep 与 purge。
 * 全部使用临时目录，跑完清理，不触碰生产数据。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../index';

interface Fixture {
  kernel: Kernel;
  rootDir: string;
  dataDir: string;
  cleanup: () => void;
}

/** 建一个只含 tmp-store 插件的内核；插件把探针结果写到 globalThis.__mhStore */
function setup(manifestExtra: Record<string, unknown> = {}): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-store-'));
  const dataDir = join(rootDir, 'data');
  const pluginsDir = join(rootDir, 'plugins');
  const coreDir = join(rootDir, 'core-empty');
  const dir = join(pluginsDir, 'tmp-store');
  mkdirSync(dir, { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'tmp-store', name: '存储探针', version: '0.1.0', entry: 'index.ts', ...manifestExtra }));
  writeFileSync(join(dir, 'index.ts'), `
export default {
  id: 'tmp-store', name: '存储探针', version: '0.1.0',
  onLoad(ctx) {
    ctx.storage.write('note.txt', 'hello');
    ctx.storage.write('../escaped.txt', 'nope');
    ctx.outbound.record({ kind: 'http', detail: 'POST https://example.com/hook' });
    ctx.outbound.record({ kind: 'file', detail: '/tmp/report.csv' });
    globalThis.__mhStore = {
      dir: ctx.storage.dir,
      note: ctx.storage.read('note.txt'),
      list: ctx.storage.list(),
      missing: ctx.storage.read('nope.txt'),
    };
  },
};
`);
  const kernel = new Kernel(rootDir, {}, { dataDir, userPluginsDir: pluginsDir, corePluginsDir: coreDir });
  return { kernel, rootDir, dataDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

type Probe = { dir: string; note: string | null; list: string[]; missing: string | null };
const probe = (): Probe | undefined => (globalThis as unknown as { __mhStore?: Probe }).__mhStore;

describe('界外效应收敛', () => {
  test('私有存储落在 <data>/plugins/<id>，读写/列举可用，文件名不可越出目录', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    const p = probe();
    assert.ok(p, '插件应已加载');
    assert.equal(p.dir, join(f.dataDir, 'plugins', 'tmp-store'));
    assert.equal(p.note, 'hello');
    assert.equal(p.missing, null);
    assert.deepEqual(p.list, ['escaped.txt', 'note.txt'].sort());
    assert.equal(existsSync(join(f.dataDir, 'plugins', 'escaped.txt')), false, '穿越写法被规整回插件目录内');
    assert.equal(readFileSync(join(f.dataDir, 'plugins', 'tmp-store', 'escaped.txt'), 'utf-8'), 'nope');
    await f.kernel.stop();
    f.cleanup();
  });

  test('界外发射登记到 jsonl 台账，事件广播，卸载摘要带条数', async () => {
    const f = setup();
    const seen: { kind: string; detail: string }[] = [];
    const reverted: { effects: number; outbound?: number }[] = [];
    f.kernel.bus.on('plugin.outbound', (e) => { seen.push(e.data as { kind: string; detail: string }); });
    f.kernel.bus.on('plugin.reverted', (e) => { reverted.push(e.data as { effects: number; outbound?: number }); });

    await f.kernel.plugins.loadAll();
    const ledger = join(f.dataDir, 'outbound', 'tmp-store.jsonl');
    assert.equal(existsSync(ledger), true, '台账文件应已生成');
    const rows = readFileSync(ledger, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; detail: string });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.kind), ['http', 'file']);
    assert.equal(seen.length, 2, '每次登记都应广播事件');

    await f.kernel.plugins.disable('tmp-store');
    const last = reverted.at(-1);
    assert.ok(last, '停用应产生 plugin.reverted');
    assert.equal(last.outbound, 2, '卸载摘要应带本次生命周期的界外发射数');
    await f.kernel.stop();
    f.cleanup();
  });

  test('cleanup: purge 在卸载时清除私有存储', async () => {
    const f = setup({ cleanup: 'purge' });
    const cleanupEvents: { id: string; strategy: string }[] = [];
    f.kernel.bus.on('plugin.cleanup', (e) => { cleanupEvents.push(e.data as { id: string; strategy: string }); });
    await f.kernel.plugins.loadAll();
    const dir = join(f.dataDir, 'plugins', 'tmp-store');
    assert.equal(existsSync(dir), true);

    await f.kernel.plugins.uninstall('tmp-store');
    assert.equal(existsSync(dir), false, 'purge 应清除私有存储');
    assert.equal(cleanupEvents.at(-1)?.strategy, 'purge');
    await f.kernel.stop();
    f.cleanup();
  });

  test('cleanup 缺省为 keep：卸载后私有存储保留', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    const dir = join(f.dataDir, 'plugins', 'tmp-store');
    await f.kernel.plugins.uninstall('tmp-store');
    assert.equal(existsSync(dir), true, '默认策略下数据应保留');
    assert.equal(readFileSync(join(dir, 'note.txt'), 'utf-8'), 'hello');
    await f.kernel.stop();
    f.cleanup();
  });
});
