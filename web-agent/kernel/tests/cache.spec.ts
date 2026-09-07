import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache, contentWords, actionGroups, bigramSet, dice } from '../cache';

describe('Cache LRU 修复', () => {
  it('l1Set 对已有 key 移动到队尾（高频条目不被误淘汰）', async () => {
    const cache = new Cache(undefined, { maxL1: 3 });
    // 填满 3 条
    await cache.l1Set('问题一：什么是缓存', '答案一', 'pk');
    await cache.l1Set('问题二：什么是事件总线', '答案二', 'pk');
    await cache.l1Set('问题三：什么是插件系统', '答案三', 'pk');
    // 再次访问第一条（应该移到队尾）
    await cache.l1Set('问题一：什么是缓存', '答案一更新', 'pk');
    // 插入第四条（应该淘汰最久未访问的 = 问题二）
    await cache.l1Set('问题四：什么是热重载', '答案四', 'pk');
    // 问题一应该还在（刚访问过），问题二应该被淘汰
    const r1 = await cache.l1Get('问题一：什么是缓存', 'pk');
    assert.equal(r1.hit, true, '问题一应命中（刚访问过，不应被淘汰）');
    const r2 = await cache.l1Get('问题二：什么是事件总线', 'pk');
    assert.equal(r2.hit, false, '问题二应被淘汰（最久未访问）');
  });

  it('l2 LRU O(1)：命中条目移到队尾', () => {
    const cache = new Cache(undefined, { maxL2: 3 });
    cache.l2Set('a:1', 'va');
    cache.l2Set('b:2', 'vb');
    cache.l2Set('c:3', 'vc');
    // 命中 a（移到队尾）
    cache.l2Get('a:1');
    // 插入 d（应该淘汰 b，因为 b 最久未访问）
    cache.l2Set('d:4', 'vd');
    assert.equal(cache.l2Get('a:1').hit, true, 'a 应命中');
    assert.equal(cache.l2Get('b:2').hit, false, 'b 应被淘汰');
    assert.equal(cache.l2Get('c:3').hit, true, 'c 应命中');
    assert.equal(cache.l2Get('d:4').hit, true, 'd 应命中');
  });
});

describe('Cache 质量过滤', () => {
  it('过滤过短答案', async () => {
    const cache = new Cache();
    await cache.l1Set('这是一个足够长的问题用来测试质量过滤', '好的', 'pk');
    const r = await cache.l1Get('这是一个足够长的问题用来测试质量过滤', 'pk');
    assert.equal(r.hit, false, '过短答案不应入缓存');
  });

  it('过滤不确定性答案', async () => {
    const cache = new Cache();
    await cache.l1Set('请帮我分析这段代码的问题', '抱歉，我无法完成这个任务', 'pk');
    const r = await cache.l1Get('请帮我分析这段代码的问题', 'pk');
    assert.equal(r.hit, false, '不确定性答案不应入缓存');
  });

  it('正常答案可以入缓存', async () => {
    const cache = new Cache();
    await cache.l1Set('什么是 TypeScript 的泛型', '泛型是 TypeScript 中一种参数化类型的机制，允许创建可复用的组件', 'pk');
    const r = await cache.l1Get('什么是 TypeScript 的泛型', 'pk');
    assert.equal(r.hit, true, '正常答案应命中');
  });
});

describe('Cache 持久化', () => {
  it('save/load 原子性（临时文件不残留）', async () => {
    const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'cache-test-'));
    const file = join(dir, 'cache.json');
    try {
      const cache = new Cache(undefined, {}, file);
      await cache.l1Set('持久化测试问题：什么是原子操作', '原子操作是不可中断的最小执行单元', 'pk');
      cache.l2Set('test:key', { data: 42 });
      cache.save();
      // 验证主文件存在，临时文件不存在
      assert.ok(existsSync(file), '主缓存文件应存在');
      assert.ok(!existsSync(file + '.tmp'), '临时文件不应残留');
      // 验证加载
      const cache2 = new Cache(undefined, {}, file);
      const r = await cache2.l1Get('持久化测试问题：什么是原子操作', 'pk');
      assert.equal(r.hit, true, '加载后应命中');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('文本工具函数', () => {
  it('contentWords 去停用词', () => {
    const result = contentWords('请帮我查看一下这个文件的内容');
    assert.ok(!result.includes('请'), '应去除"请"');
    assert.ok(!result.includes('帮'), '应去除"帮"');
    assert.ok(result.includes('查看'), '应保留"查看"');
    assert.ok(result.includes('文件'), '应保留"文件"');
  });

  it('actionGroups 识别动作方向', () => {
    const read = actionGroups('请帮我读取这个文件');
    assert.ok(read.has('query'), '读取应归类为 query');
    const write = actionGroups('请帮我写入这个文件');
    assert.ok(write.has('write'), '写入应归类为 write');
    const del = actionGroups('请帮我删除这个文件');
    assert.ok(del.has('delete'), '删除应归类为 delete');
  });

  it('dice 系数计算', () => {
    const a = new Set(['ab', 'bc', 'cd']);
    const b = new Set(['bc', 'cd', 'de']);
    const score = dice(a, b);
    assert.ok(score > 0.4 && score < 0.8, `Dice 系数应在合理范围，实际: ${score}`);
  });
});
