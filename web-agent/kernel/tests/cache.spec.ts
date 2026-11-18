import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache, contentWords, actionGroups, bigramSet, dice } from '../cache';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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

describe('L2 并发单航班', () => {
  it('同一租户和 key 的并发 loader 只执行一次', async () => {
    const cache = new Cache();
    const gate = deferred<string>();
    const started = deferred();
    let loads = 0;
    let loaderSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      loads++;
      loaderSignal = signal;
      started.resolve();
      return gate.promise;
    };

    const first = cache.l2GetOrLoad('read_file:shared', load, { tenantId: 'tenant-a' });
    const second = cache.l2GetOrLoad('read_file:shared', load, { tenantId: 'tenant-a' });
    await started.promise;
    assert.equal(loads, 1);

    gate.resolve('parsed');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.value, 'parsed');
    assert.equal(b.value, 'parsed');
    assert.equal(a.hit, false);
    assert.equal(b.hit, false);
    assert.equal(loaderSignal?.aborted, false);

    const cached = await cache.l2GetOrLoad('read_file:shared', async () => {
      throw new Error('loader must not run on a cache hit');
    }, { tenantId: 'tenant-a' });
    assert.equal(cached.hit, true);
    assert.equal(cached.value, 'parsed');
    assert.equal(loads, 1);
  });

  it('单个 waiter 取消只结束自身，不取消共享 loader 或其他 waiter', async () => {
    const cache = new Cache();
    const gate = deferred<string>();
    const started = deferred();
    const controller = new AbortController();
    let loaderSignal: AbortSignal | undefined;

    const first = cache.l2GetOrLoad('document:shared', signal => {
      loaderSignal = signal;
      started.resolve();
      return gate.promise;
    }, { tenantId: 'tenant-a', signal: controller.signal });
    const second = cache.l2GetOrLoad('document:shared', signal => {
      loaderSignal = signal;
      return gate.promise;
    }, { tenantId: 'tenant-a' });
    await started.promise;

    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(loaderSignal?.aborted, false);

    gate.resolve('document');
    const result = await second;
    assert.equal(result.value, 'document');
    assert.equal(loaderSignal?.aborted, false);
  });

  it('全部 waiter 取消时立即 abort 底层 loader', async () => {
    const cache = new Cache();
    const started = deferred();
    const never = new Promise<string>(() => undefined);
    const firstController = new AbortController();
    const secondController = new AbortController();
    let loaderSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      loaderSignal = signal;
      started.resolve();
      return never;
    };

    const first = cache.l2GetOrLoad('document:cancel', load, { tenantId: 'tenant-a', signal: firstController.signal });
    const second = cache.l2GetOrLoad('document:cancel', load, { tenantId: 'tenant-a', signal: secondController.signal });
    await started.promise;

    firstController.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(loaderSignal?.aborted, false);

    secondController.abort();
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(loaderSignal?.aborted, true);
  });

  it('loader 失败不缓存，后续调用可重试', async () => {
    const cache = new Cache();
    let attempts = 0;
    await assert.rejects(cache.l2GetOrLoad('document:retry', async () => {
      attempts++;
      throw new Error('parse failed');
    }, { tenantId: 'tenant-a' }), /parse failed/);

    const retried = await cache.l2GetOrLoad('document:retry', async () => {
      attempts++;
      return 'ok';
    }, { tenantId: 'tenant-a' });
    assert.equal(retried.hit, false);
    assert.equal(retried.value, 'ok');
    assert.equal(attempts, 2);

    const cached = await cache.l2GetOrLoad('document:retry', async () => 'unexpected', { tenantId: 'tenant-a' });
    assert.equal(cached.hit, true);
    assert.equal(cached.value, 'ok');
    assert.equal(attempts, 2);
  });

  it('租户清理只 abort 目标租户的 in-flight，不提供跨租户缓存值', async () => {
    const cache = new Cache();
    const key = 'document:tenant-shared';
    const starts = { a: deferred(), b: deferred() };
    const gates = { a: deferred<string>(), b: deferred<string>() };
    const signals: Partial<Record<'a' | 'b', AbortSignal>> = {};
    const load = (tenant: 'a' | 'b') => (signal: AbortSignal) => {
      signals[tenant] = signal;
      starts[tenant].resolve();
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        gates[tenant].promise.then(value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        }, reject);
      });
    };

    const tenantA = cache.l2GetOrLoad(key, load('a'), { tenantId: 'tenant-a' });
    const tenantB = cache.l2GetOrLoad(key, load('b'), { tenantId: 'tenant-b' });
    await Promise.all([starts.a.promise, starts.b.promise]);
    cache.l2DeleteTenant('tenant-a');
    assert.equal(signals.a?.aborted, true);
    assert.equal(signals.b?.aborted, false);
    await assert.rejects(tenantA, { name: 'AbortError' });

    gates.b.resolve('tenant-b');
    assert.equal((await tenantB).value, 'tenant-b');
    const cached = await cache.l2GetOrLoad(key, async () => 'unexpected', { tenantId: 'tenant-b' });
    assert.equal(cached.hit, true);
    assert.equal(cached.value, 'tenant-b');

    await cache.l2GetOrLoad('document:cached-only', async () => 'tenant-a-value', { tenantId: 'tenant-a' });
    let loads = 0;
    const otherTenant = await cache.l2GetOrLoad('document:cached-only', async () => {
      loads++;
      return 'tenant-b-value';
    }, { tenantId: 'tenant-b' });
    assert.equal(otherTenant.hit, false);
    assert.equal(otherTenant.value, 'tenant-b-value');
    assert.equal(loads, 1);
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

  it('忽略未知持久化 schema，避免跨版本误命中', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'cache-schema-'));
    const file = join(dir, 'cache.json');
    try {
      writeFileSync(file, JSON.stringify({ v: 1, l1: [{ k: 'pk|问题', answer: '旧答案', hits: 0, promptKey: 'pk', expiresAt: Date.now() + 60_000, bigrams: ['问题'] }] }));
      const cache = new Cache(undefined, {}, file);
      assert.equal((await cache.l1Get('问题内容足够长', 'pk')).hit, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Cache 作用域与命名空间隔离', () => {
  it('L2 缓存键带租户作用域，跨租户与无租户调用不碰撞', () => {
    const cache = new Cache();
    const a = cache.makeKey(['read_file', 'x', 'v1'], { tenantId: 'tenant-a' });
    const b = cache.makeKey(['read_file', 'x', 'v1'], { tenantId: 'tenant-b' });
    const none = cache.makeKey(['read_file', 'x', 'v1']);
    assert.notEqual(a, b);
    assert.notEqual(a, none);
    assert.equal(a, cache.makeKey(['read_file', 'x', 'v1'], { tenantId: 'tenant-a' }));
    assert.ok(a.startsWith('read_file:'), '命名空间必须保持为 parts[0]，便于按工具失效');
  });

  it('同一问题的不同 promptKey 和 session scope 不互相命中', async () => {
    const cache = new Cache();
    await cache.l1Set('请分析这个配置文件的内容', 'Provider A 的答案足够详细，可以直接使用。', 'provider-a', 'session-a');
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'provider-b', 'session-a')).hit, false);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'provider-a', 'session-b')).hit, false);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'provider-a', 'session-a')).hit, true);
  });

  it('L1 显式租户隔离：跨租户不命中，default 兼容旧全局条目', async () => {
    const cache = new Cache();
    await cache.l1Set('请分析这个配置文件的内容', '这是租户 A 的详细答案，包含完整的配置说明。', 'pk', undefined, 'tenant-a');
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk', undefined, 'tenant-a')).hit, true);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk', undefined, 'tenant-b')).hit, false);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk', undefined, 'default')).hit, false);
    await cache.l1Set('请分析这个配置文件的内容', '这是无租户的通用答案，包含完整的配置说明。', 'pk2');
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk2', undefined, 'default')).hit, true);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk2', undefined, 'tenant-b')).hit, false);
  });

  it('按租户清理只移除该租户的 L1/L2 条目', async () => {
    const cache = new Cache();
    await cache.l1Set('请分析这个配置文件的内容', '这是租户 A 的详细答案，包含完整的配置说明。', 'pk-a', undefined, 'tenant-a');
    await cache.l1Set('请分析这个配置文件的内容', '这是租户 B 的详细答案，包含完整的配置说明。', 'pk-b', undefined, 'tenant-b');
    cache.l2Set('read_file:a', 'a', undefined, 'tenant-a');
    cache.l2Set('read_file:b', 'b', undefined, 'tenant-b');
    cache.l2Set('read_file:legacy', 'legacy');
    const removed = cache.clearScope({ tenantId: 'tenant-a' });
    assert.equal(removed.l1, 1);
    assert.equal(removed.l2, 1);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk-a', undefined, 'tenant-a')).hit, false);
    assert.equal((await cache.l1Get('请分析这个配置文件的内容', 'pk-b', undefined, 'tenant-b')).hit, true);
    assert.equal(cache.l2Get('read_file:a').hit, false);
    assert.equal(cache.l2Get('read_file:b').hit, true);
    assert.equal(cache.l2Get('read_file:legacy').hit, true);
  });

  it('命名空间失效不误伤其他 L2 条目', () => {
    const cache = new Cache();
    cache.l2Set('read_file:key', 'file');
    cache.l2Set('web_search:key', 'web');
    cache.l2DeleteNamespace('read_file');
    assert.equal(cache.l2Get('read_file:key').hit, false);
    assert.equal(cache.l2Get('web_search:key').hit, true);
  });

  it('L2 命中返回可解释来源：命名空间、年龄、剩余 TTL 与命中次数', () => {
    const cache = new Cache(undefined, { l2TtlMs: 60_000 });
    const key = cache.makeKey(['read_file', 'v3', 'a.txt']);
    cache.l2Set(key, { content: 'x' });

    const first = cache.l2Get(key);
    assert.equal(first.hit, true);
    assert.equal(first.meta?.namespace, 'read_file');
    assert.equal(first.meta?.hits, 1);
    assert.ok((first.meta?.ttlRemainingMs ?? 0) > 0 && (first.meta?.ttlRemainingMs ?? 0) <= 60_000);
    assert.ok((first.meta?.ageMs ?? -1) >= 0);

    const second = cache.l2Get(key);
    assert.equal(second.meta?.hits, 2);
    assert.equal(second.meta?.createdAt, first.meta?.createdAt);
  });

  it('L1 命中返回匹配方式、作用域、剩余 TTL 与命中次数', async () => {
    const cache = new Cache();
    await cache.l1Set('请分析这个配置文件的内容', '配置文件包含三个服务与两个数据库连接。', 'pk', 'session-a');

    const exact = await cache.l1Get('请分析这个配置文件的内容', 'pk', 'session-a');
    assert.equal(exact.hit, true);
    assert.equal(exact.meta?.match, 'exact');
    assert.equal(exact.meta?.scope, 'session-a');
    assert.equal(exact.meta?.promptKey, 'pk');
    assert.equal(exact.meta?.hits, 1);
    assert.ok((exact.meta?.ttlRemainingMs ?? 0) > 0);

    const near = await cache.l1Get('请分析这个配置文件里内容', 'pk', 'session-a');
    assert.equal(near.hit, true);
    assert.notEqual(near.meta?.match, 'exact');
    assert.equal(near.meta?.hits, 2);
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

  it('bigramSet 对相近中文短语产生重叠', () => {
    const near = dice(bigramSet('打开配置文件'), bigramSet('帮我打开配置文件'));
    assert.ok(near > 0.3, `相近短语应有 bigram 重叠，实际: ${near}`);
    assert.equal(dice(bigramSet('aaaa'), bigramSet('zzzz')), 0);
    assert.equal(dice(bigramSet('单'), bigramSet('配置')), 0);
  });
});
