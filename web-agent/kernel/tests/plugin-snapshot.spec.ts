/**
 * kernel/tests/plugin-snapshot.spec.ts —— 插件模块图版本化（内容快照）回归测试
 *
 * 覆盖：内容聚合哈希的稳定性与敏感度 / 快照镜像与复用 / 历史快照清理 /
 * 依赖文件变更触发的热重载（此前依赖级改动静默失效）/ 跨目录导入在快照下仍成立 /
 * 坏版本回滚后旧版本继续可用 / 快照目录不被当作插件重复加载。
 * 全部使用临时目录，跑完清理，不触碰生产数据。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirDigest, fileDigest, materialize, pruneSnapshots, SNAPSHOT_SUFFIX } from '../plugin-snapshot';
import { Kernel } from '../index';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'mh-snap-'));

describe('plugin-snapshot 单元', () => {
  test('dirDigest：同内容稳定，任一源码文件变化即变', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'b.js'), 'export const b = 2;\n');
    const h1 = dirDigest(dir);
    assert.match(h1, /^[0-9a-f]{10}$/);
    assert.equal(dirDigest(dir), h1);
    writeFileSync(join(dir, 'b.js'), 'export const b = 3;\n');
    assert.notEqual(dirDigest(dir), h1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('dirDigest：忽略 node_modules 与历史快照，无源码时返回空串', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'index.ts'), 'export default {};\n');
    const base = dirDigest(dir);
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x.ts'), 'changed!');
    mkdirSync(join(dir, 'pkg@0123456789'), { recursive: true });
    writeFileSync(join(dir, 'pkg@0123456789', 'dep.ts'), 'changed too!');
    assert.equal(dirDigest(dir), base);
    const empty = tmp();
    writeFileSync(join(empty, 'readme.md'), '# nothing here');
    assert.equal(dirDigest(empty), '');
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });

  test('fileDigest：可读返回摘要，不可读返回空串', () => {
    const dir = tmp();
    const file = join(dir, 'x.ts');
    writeFileSync(file, 'export const x = 1;\n');
    assert.match(fileDigest(file), /^[0-9a-f]{10}$/);
    assert.equal(fileDigest(join(dir, 'missing.ts')), '');
    rmSync(dir, { recursive: true, force: true });
  });

  test('materialize：生成同层快照、内容一致、同哈希复用、目录名可被识别', () => {
    const pluginsDir = tmp();
    const dir = join(pluginsDir, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export default { id: "demo" };\n');
    const hash = dirDigest(dir);
    const snap = materialize(dir, hash);
    assert.equal(snap.skipped, false);
    assert.equal(snap.dir, join(pluginsDir, `demo@${hash}`));
    assert.match(`demo@${hash}`, SNAPSHOT_SUFFIX);
    assert.equal(readFileSync(join(snap.dir, 'index.ts'), 'utf-8'), readFileSync(join(dir, 'index.ts'), 'utf-8'));
    assert.equal(materialize(dir, hash).dir, snap.dir, '同哈希复用既有快照');
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  test('pruneSnapshots：只保留 keep 指定的快照', () => {
    const pluginsDir = tmp();
    const dir = join(pluginsDir, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export default {};\n');
    const keep = join(pluginsDir, 'demo@bbbbbbbbbb');
    const stale = join(pluginsDir, 'demo@aaaaaaaaaa');
    const other = join(pluginsDir, 'other@cccccccccc');
    for (const p of [keep, stale, other]) mkdirSync(p, { recursive: true });
    pruneSnapshots(dir, [keep]);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(other), true, '别的插件的快照不受影响');
    rmSync(pluginsDir, { recursive: true, force: true });
  });
});

interface Fixture {
  kernel: Kernel;
  pluginsDir: string;
  pluginDir: string;
  cleanup: () => void;
}

/**
 * 建一个只含 tmp-a 插件的内核。rootDir 下另有 shared/ 目录：
 * 插件以 `../../shared/kernel.ts` 跨目录导入它——用于验证快照目录「同层同深度」
 * 未破坏指向插件目录之外的相对路径。
 */
function setup(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-snap-k-'));
  const pluginsDir = join(rootDir, 'plugins');
  const coreDir = join(rootDir, 'core-empty');
  const pluginDir = join(pluginsDir, 'tmp-a');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(join(rootDir, 'shared'), { recursive: true });
  writeFileSync(join(rootDir, 'shared', 'kernel.ts'), 'export const SHARED_ID = Math.random().toString(36).slice(2);\n');
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'tmp-a', name: '快照探针', version: '0.1.0', entry: 'index.ts' }));
  writeFileSync(join(pluginDir, 'dep.ts'), 'export const tool = () => "probe";\n');
  writeFileSync(join(pluginDir, 'index.ts'), pluginSource());
  const kernel = new Kernel(rootDir, {}, { dataDir: join(rootDir, 'data'), userPluginsDir: pluginsDir, corePluginsDir: coreDir });
  return { kernel, pluginsDir, pluginDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

/** 入口：依赖 dep.ts 提供工具名，跨目录依赖 shared/kernel.ts 提供实例标识 */
function pluginSource(): string {
  return `
import { tool } from './dep.ts';
import { SHARED_ID } from '../../shared/kernel.ts';
export default {
  id: 'tmp-a', name: '快照探针', version: '0.1.0',
  onLoad(ctx) {
    ctx.register({ kind: 'tool', tool: { name: tool(), description: SHARED_ID,
      parameters: { type: 'object', properties: {} }, async handler() { return { ok: true }; } } });
  },
};
`;
}

const hasTool = (k: Kernel, name: string): boolean =>
  k.plugins.capabilities('tool').some((c) => c.tool.name === name);

const toolDesc = (k: Kernel): string | undefined =>
  k.plugins.capabilities('tool')[0]?.tool.description;

const snapshotCount = (pluginsDir: string): number =>
  readdirSync(pluginsDir).filter((n) => SNAPSHOT_SUFFIX.test(n)).length;

describe('plugin-snapshot 集成（loader）', () => {
  test('依赖文件变更触发热重载（此前依赖级改动静默失效）', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    assert.equal(hasTool(f.kernel, 'probe'), true);

    writeFileSync(join(f.pluginDir, 'dep.ts'), 'export const tool = () => "probe_v2";\n');
    await f.kernel.plugins.reload('tmp-a');
    assert.equal(hasTool(f.kernel, 'probe_v2'), true, '新依赖行为应生效');
    assert.equal(hasTool(f.kernel, 'probe'), false, '旧依赖能力应被回收');
    assert.equal(snapshotCount(f.pluginsDir), 1, '提交后只保留当前快照');
    await f.kernel.stop();
    f.cleanup();
  });

  test('跨目录导入在快照加载下仍解析到同一模块实例', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    const before = toolDesc(f.kernel);
    assert.ok(before, '首次加载应注册工具');

    writeFileSync(join(f.pluginDir, 'dep.ts'), 'export const tool = () => "probe_v2";\n');
    writeFileSync(join(f.pluginDir, 'index.ts'), pluginSource() + '\n// touched\n');
    await f.kernel.plugins.reload('tmp-a');
    assert.equal(hasTool(f.kernel, 'probe_v2'), true, '跨目录导入不阻断热重载');
    assert.equal(toolDesc(f.kernel), before, '插件目录之外共享的模块仍是同一实例');
    await f.kernel.stop();
    f.cleanup();
  });

  test('坏版本回滚：旧版本继续可用，失败版本的快照被回收', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    writeFileSync(join(f.pluginDir, 'index.ts'), 'export default { this is broken !!!');
    await f.kernel.plugins.reload('tmp-a');
    assert.equal(hasTool(f.kernel, 'probe'), true, '回滚后旧能力仍在');
    assert.equal(f.kernel.plugins.get('tmp-a')?.state, 'started');
    assert.equal(snapshotCount(f.pluginsDir), 1, '失败版本的快照应被回收');
    await f.kernel.stop();
    f.cleanup();
  });

  test('快照目录不被当作插件重复加载', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    assert.equal(snapshotCount(f.pluginsDir), 1);
    await f.kernel.plugins.loadAll(); // 第二次全量扫描：快照目录必须被跳过
    assert.deepEqual(f.kernel.plugins.list().map((p) => p.manifest.id), ['tmp-a']);
    await f.kernel.stop();
    f.cleanup();
  });

  test('插件目录消失后的孤儿快照在下次扫描时被回收', async () => {
    const f = setup();
    await f.kernel.plugins.loadAll();
    const orphan = join(f.pluginsDir, 'ghost@0123456789');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'index.ts'), 'export default {};\n');

    await f.kernel.plugins.loadAll();
    assert.equal(existsSync(orphan), false, '无归属的快照应被回收');
    assert.equal(snapshotCount(f.pluginsDir), 1, '在用的快照不受影响');
    await f.kernel.stop();
    f.cleanup();
  });
});
