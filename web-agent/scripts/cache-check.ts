/**
 * scripts/cache-check.ts —— 缓存模块聚焦验证（不联网，纯逻辑）
 * 用法：npx tsx scripts/cache-check.ts
 * 覆盖：usage 归一化 / L1 作用域隔离 / 多字停用词 / L3 真实命中 / L2 LRU 淘汰 / 持久化 roundtrip
 */
import { Cache, contentWords } from '../kernel/cache';
import { normalizeUsage } from '../core/chat/provider';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// L5：基于模块路径定位项目 data 目录——任意 cwd 运行行为一致（原 './data/...' 依赖 cwd）
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// ---- usage 归一化：各厂商缓存命中字段统一口径 ----
console.log('[usage] 缓存命中字段归一化');
{
  const ds = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
  ok('DeepSeek 命中/未命中', ds.cachedInput === 800 && ds.missInput === 200, `(${ds.cachedInput}/${ds.missInput})`);
  const oa = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 700 } });
  ok('OpenAI/智谱 cached_tokens', oa.cachedInput === 700 && oa.missInput === 300, `(${oa.cachedInput}/${oa.missInput})`);
  const an = normalizeUsage({ input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 500, cache_creation_input_tokens: 400 });
  ok('Anthropic cache_read', an.cachedInput === 500 && an.missInput === 400, `(${an.cachedInput}/${an.missInput})`);
  const na = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50 });
  ok('无字段 → undefined', na.cachedInput === undefined, `(${na.cachedInput})`);
}

// ---- L1 内容词：多字停用词整词剔除（修复前永不生效） ----
console.log('[L1] 多字停用词整词剔除');
{
  const cw = contentWords('为什么我现在不能运行这个文件呢');
  ok('"为什么/什么"被剔除', !cw.includes('什么'), `内容词="${cw}"`);
  const cw2 = contentWords('帮我看看当前目录下有什么文件');
  ok('"帮我/什么"被剔除', !cw2.includes('帮我') && !cw2.includes('什么'), `内容词="${cw2}"`);
}

// ---- L1 作用域隔离：全局跨会话可见，会话自产仅本会话 ----
console.log('[L1] 作用域隔离');
{
  const c = new Cache(undefined, {}, undefined);
  await c.l1Set('什么是作用域隔离机制', '全局答案', 'pk', undefined);
  await c.l1Set('当前目录下有哪些文件', '会话答案A', 'pk', 'trace-A');
  const g = await c.l1Get('什么是作用域隔离机制', 'pk', 'trace-B');
  const a = await c.l1Get('当前目录下有哪些文件', 'pk', 'trace-A');
  const b = await c.l1Get('当前目录下有哪些文件', 'pk', 'trace-B');
  ok('全局答案跨会话命中', g.hit && g.answer === '全局答案', `(${g.hit})`);
  ok('会话答案本会话命中', a.hit && a.answer === '会话答案A', `(${a.hit})`);
  ok('会话答案跨会话不串', !b.hit, `(${b.hit})`);
  // 命中学习沿用来源作用域：会话答案在 trace-A 换措辞命中后，回填仍在 trace-A 域
  const learn = await c.l1Get('这个目录下有哪些文件', 'pk', 'trace-A');
  ok('会话答案近似问法命中', learn.hit && learn.hitScope === 'trace-A', `(hit=${learn.hit} scope=${learn.hitScope})`);
}

// ---- L1 短问题/动作校验回归 ----
console.log('[L1] 回归');
{
  const c = new Cache(undefined, {}, undefined);
  await c.l1Set('帮我写一个快速排序算法', '快速排序实现', 'pk', undefined);
  const short = await c.l1Get('继续', 'pk');
  ok('短问题不参与', !short.hit);
  const write = await c.l1Get('帮我写一个快速排序算法，用python', 'pk');
  ok('同方向近似命中', write.hit);
  const read = await c.l1Get('帮我读一个快速排序算法文件', 'pk');
  ok('写→读方向拦截', !read.hit);
}

// ---- L3 真实命中统计 ----
console.log('[L3] 真实命中统计');
{
  const c = new Cache(undefined, {}, undefined);
  c.recordProviderCacheHit(800, 200);
  c.recordProviderCacheHit(600, 100);
  c.recordPrefixRepeat(300); // 估算口径独立
  const s = c.stats();
  ok('真实命中 token=1400', s.l3RealTokens === 1400, `(${s.l3RealTokens})`);
  ok('真实未命中 token=300', s.l3RealMissTokens === 300, `(${s.l3RealMissTokens})`);
  ok('真实命中次数=2', s.l3RealHits === 2, `(${s.l3RealHits})`);
  ok('估算口径共存', s.l3Tokens === 300 && s.l3Hits === 1, `(${s.l3Tokens}/${s.l3Hits})`);
}

// ---- L2 LRU 淘汰：访问过的旧条目保留，未访问的最旧条目淘汰 ----
console.log('[L2] LRU 淘汰');
{
  const c = new Cache(undefined, {}, undefined);
  for (let i = 0; i < 2000; i++) c.l2Set(`k${i}`, i);
  c.l2Get('k0'); // 访问最旧插入的 → lastAccess 更新，不再是最旧
  c.l2Set('overflow', 'x'); // 触发淘汰（>2000）
  const kept = c.l2Get('k0');
  const keptNewest = c.l2Get('k1999'); // 最新插入，保留
  const dropped = c.l2Get('k1');       // 未被访问的最旧条目（k0 已刷新）→ 被淘汰
  const overflow = c.l2Get('overflow');
  ok('访问过的旧条目保留', kept.hit && kept.value === 0, `(${kept.hit})`);
  ok('最新插入条目保留', keptNewest.hit && keptNewest.value === 1999, `(${keptNewest.hit})`);
  ok('未访问的最旧条目淘汰', !dropped.hit, `(${dropped.hit})`);
  ok('新条目已入缓存', overflow.hit && overflow.value === 'x', `(${overflow.hit})`);
}

// ---- L2 命名空间失效：只失效受影响工具的缓存，不误伤其他工具 ----
console.log('[L2] 命名空间失效');
{
  const c = new Cache(undefined, {}, undefined);
  const kList = c.makeKey(['list_dir', 'v2', 'root']);
  const kRead = c.makeKey(['read_file', 'v2', 'a.txt']);
  const kSearch = c.makeKey(['web_search', 'v2', 'query']);
  c.l2Set(kList, 'dirs');
  c.l2Set(kRead, 'content');
  c.l2Set(kSearch, 'results');
  c.l2DeleteNamespace('list_dir');
  c.l2DeleteNamespace('read_file');
  const searchAlive = c.l2Get(kSearch);
  const listGone = c.l2Get(kList);
  const readGone = c.l2Get(kRead);
  ok('写操作后 list_dir/read_file 失效', !listGone.hit && !readGone.hit, `(${listGone.hit}/${readGone.hit})`);
  ok('web_search 缓存保留', searchAlive.hit && searchAlive.value === 'results', `(${searchAlive.hit})`);
}

// ---- 持久化 roundtrip：scope 字段跨重启保留 ----
console.log('[persist] scope 持久化');
{
  const file = join(rootDir, 'data', 'cache-check.json');
  const c1 = new Cache(undefined, {}, file);
  await c1.l1Set('持久化测试问题的内容', '答案', 'pk', 'trace-Z');
  c1.l2Set('tk', { a: 1 });
  c1.save();
  const c2 = new Cache(undefined, {}, file);
  const hit = await c2.l1Get('持久化测试问题的内容', 'pk', 'trace-Z');
  const cross = await c2.l1Get('持久化测试问题的内容', 'pk', 'trace-OTHER');
  const l2 = c2.l2Get('tk');
  ok('L1 scope 跨重启恢复', hit.hit && !cross.hit, `(${hit.hit}/${cross.hit})`);
  ok('L2 跨重启恢复', l2.hit, `(${l2.hit})`);
  // 清理测试文件
  const { rmSync } = await import('node:fs');
  rmSync(file, { force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
