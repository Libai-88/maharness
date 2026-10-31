/**
 * kernel/tests/config.spec.ts —— 配置分层与持久化（B12 回归）
 * 覆盖：defaults ← config.json 读取顺序、set 不落盘 / setPersistent 落盘、
 * 跨实例保持、合并保留用户手写键、对象值整子树覆盖、坏文件拒绝覆写。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../bus';
import { Config } from '../config';

const tmp = () => mkdtempSync(join(tmpdir(), 'maharness-config-'));

describe('Config 分层读取', () => {
  test('defaults 被 config.json 覆盖；缺失文件时走 defaults', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      const c1 = new Config(new EventBus(), { agent: { maxTurns: 12 } }, path);
      assert.equal(c1.get('agent.maxTurns'), 12, '无文件 → default');

      writeFileSync(path, JSON.stringify({ agent: { maxTurns: 30 } }), 'utf-8');
      const c2 = new Config(new EventBus(), { agent: { maxTurns: 12 } }, path);
      assert.equal(c2.get('agent.maxTurns'), 30, 'config.json 优先于 defaults');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('点路径平铺键也可用（defaults 与 config.json 两种写法都归一化）', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      // defaults 用平铺键：旧实现 Object.assign 后 get('agent.maxTurns') 读不到
      const c1 = new Config(new EventBus(), { 'agent.maxTurns': 12 }, path);
      assert.equal(c1.get('agent.maxTurns'), 12, '平铺 default 键应可用');

      // config.json 用平铺键（用户手写常见写法）
      writeFileSync(path, JSON.stringify({ 'context.maxTokens': 100 }), 'utf-8');
      const c2 = new Config(new EventBus(), { context: { maxTokens: 60000 } }, path);
      assert.equal(c2.get('context.maxTokens'), 100, '平铺 config 键应覆盖嵌套 default');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('config.json 顶层非法（数组/标量）时忽略用户配置且不抛', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, '[1,2,3]', 'utf-8');
      const c = new Config(new EventBus(), { agent: { maxTurns: 12 } }, path);
      assert.equal(c.get('agent.maxTurns'), 12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('显式 null 视同未设置（回退默认值）', () => {
    const c = new Config(new EventBus(), { cache: { l1Threshold: 0.58 } });
    c.set('cache.l1Threshold', null);
    assert.equal(c.get<number>('cache.l1Threshold', 0.58), 0.58);
  });
});

describe('Config 持久化（B12：用户改动必须下次还在）', () => {
  test('set 只改内存，不落盘', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      const c = new Config(new EventBus(), {}, path);
      c.set('context.maxTokens', 999);
      assert.equal(existsSync(path), false, '未调用 setPersistent 不应创建文件');
      assert.equal(c.persistNow(), false, '无待落盘键时 persistNow 返回 false');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('setPersistent 落盘，且新实例（模拟重启）读到同值', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      const c = new Config(new EventBus(), {}, path);
      c.setPersistent('context.maxTokens', 999);
      c.setPersistent('agent.modelRouting', { 代码: 'deepseek@deepseek-reasoner' });
      assert.equal(c.persistNow(), true);

      // 模拟进程重启：新实例从同一文件读
      const after = new Config(new EventBus(), { context: { maxTokens: 60000 } }, path);
      assert.equal(after.get('context.maxTokens'), 999);
      assert.deepEqual(after.get('agent.modelRouting'), { 代码: 'deepseek@deepseek-reasoner' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('落盘合并保留用户手写的其它键（不清空 config.json）', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ mcp: { servers: { fs: { type: 'stdio' } } } }), 'utf-8');
      const c = new Config(new EventBus(), {}, path);
      c.setPersistent('cache.l2TtlMin', 5);
      c.persistNow();
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      assert.equal(raw.cache.l2TtlMin, 5, '新键写入');
      assert.deepEqual(raw.mcp.servers.fs, { type: 'stdio' }, '既有手写键不被销毁');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('批量写入先提交文件再广播配置变更', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ handWritten: { keep: true } }), 'utf-8');
      const bus = new EventBus();
      const c = new Config(bus, { context: { maxTokens: 60000 }, cache: { warmup: 'auto' } }, path);
      let persistedAtPublish: Record<string, unknown> | undefined;
      bus.on('config.changed', () => { persistedAtPublish = JSON.parse(readFileSync(path, 'utf-8')); });

      assert.equal(c.setPersistentBatch([
        ['context.maxTokens', 12000],
        ['cache.warmup', 'off'],
      ]), true);

      assert.equal(c.get('context.maxTokens'), 12000);
      assert.equal(c.get('cache.warmup'), 'off');
      assert.deepEqual(persistedAtPublish?.context, { maxTokens: 12000 });
      assert.deepEqual(persistedAtPublish?.cache, { warmup: 'off' });
      assert.deepEqual(persistedAtPublish?.handWritten, { keep: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('批量写入提交失败时保留原文件和运行配置', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      const original = '{invalid config';
      writeFileSync(path, original, 'utf-8');
      const c = new Config(new EventBus(), { context: { maxTokens: 60000 } }, path);

      assert.equal(c.setPersistentBatch([['context.maxTokens', 12000]]), false);
      assert.equal(c.get('context.maxTokens'), 60000);
      assert.equal(readFileSync(path, 'utf-8'), original);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('批量写入检测外部版本变化并拒绝覆盖更新后的文件', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ context: { maxTokens: 60000 } }), 'utf8');
      const c = new Config(new EventBus(), {}, path);
      const revision = c.getPersistedRevision();
      writeFileSync(path, JSON.stringify({ context: { maxTokens: 70000 } }), 'utf8');

      assert.equal(c.setPersistentBatch([['context.maxTokens', 12000]], revision), false);
      assert.equal(c.getPersistentFailureCode(), 'concurrent_write');
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).context.maxTokens, 70000);
      assert.equal(c.get('context.maxTokens'), 60000, '冲突时运行态也保持原值');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('对象值整子树覆盖：被删除的路由条目不残留', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ agent: { modelRouting: { 代码: 'a', 写作: 'b' } } }), 'utf-8');
      const c = new Config(new EventBus(), {}, path);
      // 用户删掉「写作」这条路由
      c.setPersistent('agent.modelRouting', { 代码: 'a' });
      c.persistNow();
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      assert.deepEqual(raw.agent.modelRouting, { 代码: 'a' }, '逐个叶键合并会让 写作 残留（旧实现的坑）');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('config.json 已损坏时拒绝落盘（不销毁用户文件）', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, '{这不是合法 JSON', 'utf-8');
      const c = new Config(new EventBus(), {}, path);
      c.setPersistent('context.maxTokens', 1234);
      assert.equal(c.persistNow(), false, '解析失败 → 拒绝覆写');
      assert.equal(readFileSync(path, 'utf-8'), '{这不是合法 JSON', '原文件内容未被破坏');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('未绑定 config 路径时 setPersistent 仍可用（只改内存，不抛）', () => {
    const c = new Config(new EventBus(), {});
    c.setPersistent('x.y', 1);
    assert.equal(c.get('x.y'), 1);
    assert.equal(c.persistNow(), false);
  });

  test('config.changed 事件照常广播（持久化不改变热更新语义）', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'config.json');
      const bus = new EventBus();
      const got: Array<[string, unknown]> = [];
      const c = new Config(bus, {}, path);
      c.watch('agent.*', (k, v) => got.push([k, v]));
      c.setPersistent('agent.maxTurns', 7);
      c.persistNow();
      assert.deepEqual(got, [['agent.maxTurns', 7]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
