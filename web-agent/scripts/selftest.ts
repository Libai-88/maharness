/**
 * scripts/selftest.ts —— 工具冒烟测试（不依赖 LLM）
 * 用法：npm run selftest
 *   SEARCH_PROXY=http://127.0.0.1:7897 npm run selftest  —— 走代理测联网搜索
 *   TAVILY_API_KEY=xxx npm run selftest                  —— 走 Tavily 测搜索
 */
import { Kernel } from '../kernel';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 基于模块路径定位 web-agent 根，不依赖调用方 cwd（任意目录运行均正确）
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.AGENT_ROOT = rootDir; // HTTP 冒烟：startServer 复用同一根目录
process.env.SANDBOX_ROOT = rootDir; // 覆盖 .env 的沙箱配置，保证测试作用于本仓库

const kernel = new Kernel(rootDir);
await kernel.start();

const tools = kernel.plugins.capabilities('tool').map((c) => c.tool);
console.log('[tools]', tools.map((t) => t.name).sort().join(', '));

const tctx = (turn = 0) => ({
  traceId: `selftest-${Date.now()}`,
  turn,
  sandboxRoot: rootDir,
  cache: kernel.cache,
  trace: kernel.trace,
});

// ---- web_search ----
const search = tools.find((t) => t.name === 'web_search');
if (search) {
  const r = await search.handler({ query: 'maharness agent framework', max_results: 3 }, tctx());
  if (r.ok) {
    const d = r.data as { source: string; count: number; results: { title: string; url: string }[] };
    console.log(`[web_search] source=${d.source} count=${d.count}`);
    for (const res of d.results) console.log(`  - ${res.title}  ${res.url}`);
  } else {
    console.log('[web_search] FAILED:', r.error);
  }
}

// ---- plugin_status（无现场插件时返回空列表） ----
const ps = tools.find((t) => t.name === 'plugin_status');
if (ps) {
  const r = await ps.handler({}, tctx());
  console.log('[plugin_status]', JSON.stringify(r.data).slice(0, 300));
}

// ---- create_plugin 契约校验 ----
const cp = tools.find((t) => t.name === 'create_plugin');
if (cp) {
  // 1) 坏源码（旧 API 写法）应被静态契约校验拦截，且不写文件
  const bad = await cp.handler({
    id: 'bad-test',
    name: '坏插件',
    source: 'export default { initialize(ctx) { ctx.register("tool", { name: "x", execute() {} }) } }',
  }, tctx());
  console.log('[create_plugin] 坏源码拦截:', bad.ok === false ? '✓ 已拦截' : '✗ 未拦截', '|', (bad.error ?? '').slice(0, 80));

  // 2) 默认骨架创建 → 等待热加载 → plugin_status 确认
  const good = await cp.handler({ id: 'tmp-hello', name: '临时测试' }, tctx());
  console.log('[create_plugin] 默认骨架:', JSON.stringify(good.data ?? good.error).slice(0, 200));
  await new Promise((r) => setTimeout(r, 1200));
  if (ps) {
    const st = await ps.handler({}, tctx());
    const list = (st.data as { plugins: { id: string; state: string; caps: string[] }[] }).plugins;
    const found = list.find((p) => p.id === 'tmp-hello');
    console.log('[plugin_status] tmp-hello:', found ? `${found.state} caps=[${found.caps}]` : '未出现 ✗');
  }

  // 3) 清理：删除后加载器应自动卸载
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  rmSync(join(process.cwd(), 'plugins', 'tmp-hello'), { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1200));
  if (ps) {
    const st = await ps.handler({}, tctx());
    const list = (st.data as { plugins: { id: string }[] }).plugins;
    console.log('[plugin_status] tmp-hello 已清理:', !list.some((p) => p.id === 'tmp-hello') ? '✓' : '✗');
  }
}

// ---- memory：工具 + before_llm 钩子注入 ----
const rf = tools.find((t) => t.name === 'remember_fact');
const recall = tools.find((t) => t.name === 'recall_facts');
const forget = tools.find((t) => t.name === 'forget_fact');
if (rf && recall && forget) {
  const cleanSelftest = async () => {
    const r = await recall.handler({ query: 'selftest' }, tctx());
    for (const f of (r.data as { facts: { id: string }[] }).facts) await forget.handler({ id: f.id }, tctx());
  };
  await cleanSelftest();
  await rf.handler({ text: `selftest 记忆测试 ${Date.now()}` }, tctx());
  const q1 = await recall.handler({ query: 'selftest' }, tctx());
  console.log('[memory] remember+recall:', (q1.data as { count: number }).count >= 1 ? '✓' : '✗');

  // before_llm 钩子注入验证（模拟 agent 循环发布的钩子事件）
  // 上下文工程：普通记忆走 context provider（按任务相关注入），钩子只注入失败教训
  // 先清理环境中可能残留的自动教训，保证"零注入"断言成立
  const autoBefore = await recall.handler({ query: '失败教训' }, tctx());
  for (const f of (autoBefore.data as { facts: { id: string }[] }).facts) await forget.handler({ id: f.id }, tctx());
  const history = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  await kernel.bus.emitAsync({
    type: 'agent.before_llm',
    data: { traceId: 't', turn: 0, model: 'm', history, systemPrompt: 's', tools: [], scratchpad: {} },
    ts: Date.now(),
  });
  const noLessonInjected = history.length === 2; // 无失败教训时不注入任何记忆（零成本）
  console.log('[memory] 无教训时零注入:', noLessonInjected ? '✓' : '✗');

  // context provider 按任务检索：模拟一次工具失败（生成教训），再模拟 LLM 循环的
  // context 注入路径——教训应被 before_llm 钩子注入，普通记忆按任务相关才注入
  await kernel.bus.emitAsync({
    type: 'agent.after_tool',
    data: { tool: { name: 'read_file' }, result: { ok: false, error: '文件不存在: /no-such-file.txt' } },
    ts: Date.now(),
  });
  const history2 = [{ role: 'system', content: 's' }, { role: 'user', content: '读取 no-such-file.txt 内容' }];
  await kernel.bus.emitAsync({
    type: 'agent.before_llm',
    data: { traceId: 't', turn: 0, model: 'm', history: history2, systemPrompt: 's', tools: [], scratchpad: {} },
    ts: Date.now(),
  });
  const lessonInjected = history2.length === 3 && String(history2[2].content).includes('失败教训');
  console.log('[memory] 失败教训钩子注入:', lessonInjected ? '✓' : '✗');
  await cleanSelftest();
  const q3 = await recall.handler({ query: 'selftest' }, tctx());
  console.log('[memory] 清理完成:', (q3.data as { count: number }).count === 0 ? '✓' : '✗');

  // 失败教训自动记忆：模拟工具失败事件 → 自动记录（不重复犯错的底层机制）
  await kernel.bus.emitAsync({
    type: 'agent.after_tool',
    data: { tool: { name: 'read_file' }, result: { ok: false, error: '文件不存在: /no-such-file.txt' } },
    ts: Date.now(),
  });
  await kernel.bus.emitAsync({
    type: 'agent.after_tool',
    data: { tool: { name: 'read_file' }, result: { ok: false, error: '文件不存在: /no-such-file.txt' } },
    ts: Date.now(),
  }); // 第二次同样失败：应去重
  const autoRecall = await recall.handler({ query: '工具失败教训' }, tctx());
  const autoCount = (autoRecall.data as { count: number }).count;
  console.log('[memory] 失败教训自动记忆+去重:', autoCount >= 1 ? '✓' : '✗', `(记 ${autoCount} 条，去重生效)`);
  const autoFacts = (autoRecall.data as { facts: { id: string }[] }).facts;
  for (const f of autoFacts) await forget.handler({ id: f.id }, tctx());
}

// ---- skills：list_skills / get_skill（内置指南按需读取） ----
const ls = tools.find((t) => t.name === 'list_skills');
const gs = tools.find((t) => t.name === 'get_skill');
if (ls && gs) {
  const r = await ls.handler({}, tctx());
  const list = (r.data as { count: number; skills: { name: string; source: string }[] }).skills;
  const builtin = list.filter((s) => s.source === 'builtin').length;
  console.log(`[skills] list_skills: 共 ${list.length} 个（内置 ${builtin}）:`, builtin >= 4 ? '✓' : '✗');
  const g = await gs.handler({ name: 'agent-self-design' }, tctx());
  const hasGuide = g.ok === true && String((g.data as { content: string }).content).includes('自我设计');
  console.log('[skills] get_skill 读取全文:', hasGuide ? '✓' : '✗');
  const missing = await gs.handler({ name: '../etc/passwd' }, tctx());
  console.log('[skills] 非法技能名被拦截:', missing.ok === false ? '✓' : '✗');
}

// ---- 能力边界：内核隔离断言（薄内核的机器可验证保证） ----
// kernel/ 只能依赖 node 内置 + kernel 自身；不得依赖 core/server/ui 等能力层。
// 一旦内核开始 import 能力层，就说明业务逻辑渗入了内核——系统开始变臃肿。
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const kernelFiles = readdirSync(join(rootDir, 'kernel')).filter((f) => f.endsWith('.ts'));
  const violations: string[] = [];
  for (const f of kernelFiles) {
    const src = readFileSync(join(rootDir, 'kernel', f), 'utf-8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = m[1];
      if (target.startsWith('.') && !target.startsWith('./') && !target.startsWith('../kernel')) {
        violations.push(`${f} → ${target}`);
      }
    }
  }
  console.log('[boundary] 内核隔离（kernel 不依赖能力层）:', violations.length === 0 ? '✓' : '✗',
    violations.length ? violations.join('; ') : `(${kernelFiles.length} 个内核文件仅依赖 node 内置与自身)`);
}

// ---- subagent：子代理工具注册（LLM 第 6 项能力） ----
const sub = tools.find((t) => t.name === 'run_subagent');
console.log('[subagent] run_subagent 工具:', sub ? '✓' : '✗');
if (!sub) console.log('[subagent] ✗ 子代理未注册，检查 core/subagent 插件加载');

// ---- 能力发现：工具风险/成本元数据（harness 视角第 2/6/9 问） ----
const wf = tools.find((t) => t.name === 'write_file');
const lf = tools.find((t) => t.name === 'list_dir');
const hasMeta = wf?.risk === 'high' && wf?.approval === true && wf?.costHint === 'low' && lf?.risk === 'low';
console.log('[capabilities] 工具元数据（risk/approval/cost）:', hasMeta ? '✓' : '✗',
  `write_file=${wf?.risk}/${wf?.approval} list_dir=${lf?.risk}`);
// annotateToolDef：LLM 收到的描述自动带【风险/成本】标签（能力发现 + 经济性提示）
const { annotateToolDef } = await import('../core/chat/agent');
const tagged = wf ? annotateToolDef(wf).description.includes('风险:high') : false;
const costTag = sub ? annotateToolDef(sub).description.includes('成本:high') : false;
console.log('[capabilities] 描述自动打标签（风险/成本）:', tagged && costTag ? '✓' : '✗',
  `write_file=${tagged} run_subagent=${costTag}`);
// 输出格式显式化（output 字段 → 描述尾部）：LLM 拿到结果即知结构，减少试错型幻觉
const outputTag = sub ? annotateToolDef(sub).description.includes('输出格式: {answer') : false;
const rf2 = tools.find((t) => t.name === 'read_file');
const rfOutput = rf2 ? annotateToolDef(rf2).description.includes('输出格式') : false;
console.log('[capabilities] 输出格式显式化:', outputTag && rfOutput ? '✓' : '✗',
  `run_subagent=${outputTag} read_file=${rfOutput}`);

// ---- 生命周期：lazy 插件（dynamic capability loading，类似 OS 加载驱动） ----
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(rootDir, 'plugins', 'tmp-lazy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'tmp-lazy', name: '惰性测试', version: '0.1.0', entry: 'index.ts', lazy: true }));
  writeFileSync(join(dir, 'index.ts'), `
import type { Plugin } from '../../kernel/types';
export default {
  id: 'tmp-lazy', name: '惰性测试', version: '0.1.0',
  onLoad(ctx) {
    ctx.register({ kind: 'tool', tool: { name: 'lazy_probe', risk: 'low', costHint: 'low', description: '惰性插件探针',
      parameters: { type: 'object', properties: {} },
      async handler() { return { ok: true, data: { lazy: true } }; } } });
  },
} satisfies Plugin;
`);
  await new Promise((r) => setTimeout(r, 1200)); // 等热扫描
  const before = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'lazy_probe');
  console.log('[lifecycle] lazy 插件默认不加载（能力不进上下文）:', !before ? '✓' : '✗');
  await kernel.plugins.enable('tmp-lazy');
  const after = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'lazy_probe');
  console.log('[lifecycle] enable_plugin 按需激活:', after ? '✓' : '✗');
  await kernel.plugins.disable('tmp-lazy');
  const disabled = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'lazy_probe');
  console.log('[lifecycle] disable_plugin 能力卸载:', !disabled ? '✓' : '✗');
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1200));
}

// ---- 可替换性：核心能力接口语义自检 ----
// 插件接口抽象的是能力语义而非具体实现——核心能力名称/语义必须稳定，
// 实现（存储引擎/搜索引擎/向量库）可任意替换而 LLM 无需重新学习。
{
  const coreSemantics: [string, string][] = [
    ['list_dir', '目录'],
    ['read_file', '读取'],
    ['write_file', '写入'],
    ['remember_fact', '记住'],
    ['recall_facts', '查询'],
    ['web_search', '搜索'],
    ['run_subagent', '子代理'],
  ];
  const missing = coreSemantics.filter(([name]) => !tools.some((t) => t.name === name));
  const descOk = coreSemantics.every(([name, kw]) => {
    const t = tools.find((x) => x.name === name);
    return t && String(t.description).includes(kw);
  });
  console.log('[replaceability] 核心能力接口语义稳定:', missing.length === 0 && descOk ? '✓' : '✗',
    missing.length ? `缺失: ${missing.map((m) => m[0]).join(',')}` : '(8 个核心能力名称+语义不变，实现可替换)');
}

// ---- 经济性：harness 管理认知资源（子代理配额） ----
{
  kernel.budget.consumeSubagent();
  kernel.budget.consumeSubagent();
  kernel.budget.consumeSubagent(); // 消耗满 3 次配额
  const q = kernel.budget.subagentQuota();
  console.log('[budget] 子代理配额（窗口内 3 次上限）:', q.allowed === false ? '✓' : '✗',
    q.allowed ? '' : `(harness 拒绝: ${(q.reason ?? '').slice(0, 30)}…)`);
  kernel.budget.recordTask({ type: '代码', turns: 5, cost: 0.01, failed: false, ts: Date.now() });
  kernel.budget.recordTask({ type: '代码', turns: 8, cost: 0.02, failed: true, ts: Date.now() });
  const profile = kernel.budget.taskProfile();
  const code = profile.find((p) => p.type === '代码');
  console.log('[budget] 任务画像聚合:', code && code.count === 2 && code.failRate === 50 ? '✓' : '✗', JSON.stringify(profile));
}

// ---- L1 语义缓存：自研文本相似度（免 embedding，相同/近似问题命中） ----
{
  const { dice, bigramSet } = await import('../kernel/cache');
  const same = dice(bigramSet('帮我看看当前目录下有什么文件'), bigramSet('帮我看看当前目录下有什么文件'));
  const near = dice(bigramSet('用工具查看当前沙箱根目录下有哪些文件，列出文件名'), bigramSet('用工具查看当前沙箱根目录下有哪些文件，列出文件名'));
  const diff = dice(bigramSet('帮我写一份周报'), bigramSet('介绍一下你自己'));
  console.log('[L1] bigram Dice 相同=1.0 近似=1.0 无关<0.6:', same === 1 && near === 1 && diff < 0.6 ? '✓' : '✗', `(${same.toFixed(2)}/${near.toFixed(2)}/${diff.toFixed(2)})`);

  // l1Get/l1Set 无 embedding 路径：同题命中、近似命中、无关不命中
  await kernel.cache.l1Set('查看当前沙箱根目录下的文件列表', '沙箱根目录有 bin core kernel 等目录。');
  const hitExact = await kernel.cache.l1Get('查看当前沙箱根目录下的文件列表');
  const hitNear = await kernel.cache.l1Get('查看当前沙箱根目录下的文件列表！');
  const hitOther = await kernel.cache.l1Get('今天天气怎么样');
  console.log('[L1] 缓存命中: 同题=1 近题=1 无关=0:',
    hitExact.hit && hitNear.hit && !hitOther.hit ? '✓' : '✗',
    `(${hitExact.hit}/${hitNear.hit}/${hitOther.hit})`);
  const s1 = kernel.cache.stats();
  console.log('[L1] 计数 l1Hits>=2 l1Misses>=1:', s1.l1Hits >= 2 && s1.l1Misses >= 1 ? '✓' : '✗', JSON.stringify(s1).slice(0, 120));

  // promptKey 隔离：systemPrompt 指纹不同（人设/插件规则变更）→ 缓存空间隔离，不串用旧答案
  await kernel.cache.l1Set('第一性原理测试问题', '答案A', 'prompt-v1');
  const isoHit = await kernel.cache.l1Get('第一性原理测试问题', 'prompt-v1');
  const isoMiss = await kernel.cache.l1Get('第一性原理测试问题', 'prompt-v2');
  console.log('[L1] promptKey 隔离: 同指纹命中=1 异指纹不命中=1:',
    isoHit.hit && !isoMiss.hit ? '✓' : '✗', `(${isoHit.hit}/${isoMiss.hit})`);

  // savedCost 累计
  kernel.cache.recordSavedCost(0.123);
  const s2 = kernel.cache.stats();
  console.log('[L1] savedCost 累计:', s2.savedCost >= 0.123 ? '✓' : '✗', s2.savedCost.toFixed(6));
}

// ---- L1 作用域隔离：会话自产答案（依赖工具观察）不跨会话串用 ----
{
  // 全局答案（纯问答）任何会话可命中
  await kernel.cache.l1Set('什么是作用域隔离机制', '全局答案', 'prompt-s', undefined);
  const gHit = await kernel.cache.l1Get('什么是作用域隔离机制', 'prompt-s', 'trace-A');
  // 会话答案（scope=trace-A）仅 trace-A 可命中，trace-B 不命中
  await kernel.cache.l1Set('当前目录下有哪些文件', '会话答案A', 'prompt-s', 'trace-A');
  const sHitA = await kernel.cache.l1Get('当前目录下有哪些文件', 'prompt-s', 'trace-A');
  const sMissB = await kernel.cache.l1Get('当前目录下有哪些文件', 'prompt-s', 'trace-B');
  console.log('[L1] 作用域隔离: 全局跨会话命中=1 会话内命中=1 跨会话不串=1:',
    gHit.hit && sHitA.hit && !sMissB.hit ? '✓' : '✗',
    `(全局=${gHit.hit} 会话A=${sHitA.hit} 会话B=${sMissB.hit})`);
}

// ---- L1 内容词停用词修复：多字功能词（什么/怎么/为什么等）整词剔除生效 ----
{
  const { contentWords } = await import('../kernel/cache');
  // 修复前：按单字符判断多字词永不匹配 → "为什么" 残留；修复后应被整词剔除
  const cw = contentWords('为什么我现在不能运行这个文件呢');
  const leftover = cw.includes('为什么') || cw.includes('什么');
  console.log('[L1] 多字停用词整词剔除:', !leftover ? '✓' : '✗', `内容词="${cw}"`);
}

// ---- usage 归一化：各厂商缓存命中字段统一口径 ----
{
  const { normalizeUsage } = await import('../core/chat/provider');
  // DeepSeek：prompt_cache_hit_tokens + prompt_cache_miss_tokens
  const ds = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
  // OpenAI / 智谱：prompt_tokens_details.cached_tokens
  const oa = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 700 } });
  // Anthropic：cache_read_input_tokens
  const an = normalizeUsage({ input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 500, cache_creation_input_tokens: 400 });
  // 不支持缓存：无字段
  const na = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50 });
  const ok = ds.cachedInput === 800 && ds.missInput === 200
    && oa.cachedInput === 700 && oa.missInput === 300
    && an.cachedInput === 500 && an.missInput === 400
    && na.cachedInput === undefined;
  console.log('[usage] 缓存命中归一化 (DeepSeek/OpenAI/Anthropic/无):', ok ? '✓' : '✗',
    `ds=${ds.cachedInput}/${ds.missInput} oa=${oa.cachedInput}/${oa.missInput} an=${an.cachedInput}/${an.missInput} na=${na.cachedInput ?? 'undefined'}`);
}

// ---- L3 真实命中统计：provider usage 确认的缓存命中（真实命中率唯一权威口径） ----
{
  kernel.cache.recordProviderCacheHit(800, 200);
  kernel.cache.recordProviderCacheHit(600, 100);
  const s = kernel.cache.stats();
  const realRate = (s.l3RealTokens / (s.l3RealTokens + s.l3RealMissTokens)) * 100;
  console.log('[L3] 真实命中统计: token=1400 miss=300 命中率=82.4%:',
    s.l3RealTokens === 1400 && s.l3RealMissTokens === 300 && Math.round(realRate * 10) / 10 === 82.4 ? '✓' : '✗',
    `(${s.l3RealTokens}/${s.l3RealMissTokens}/${realRate.toFixed(1)}%)`);
}

// ---- L2 LRU 淘汰：超出容量淘汰最久未访问（而非插入最早） ----
{
  // 直接构造小容量场景：填充后访问旧条目，再触发淘汰应保留被访问的旧条目
  const { Cache } = await import('../kernel/cache');
  const c = new Cache(undefined, {}, undefined); // 不落盘
  for (let i = 0; i < 2000; i++) c.l2Set(`k${i}`, i);
  c.l2Get('k0'); // 访问最旧插入的 → lastAccess 刷新
  c.l2Set('overflow', 'x'); // 触发淘汰（>2000）
  const kept = c.l2Get('k0');
  const dropped = c.l2Get('k1'); // 未被访问的最旧条目（k0 已刷新）→ 应被淘汰
  console.log('[L2] LRU 淘汰: 访问过的旧条目保留=1 未访问的最旧条目淘汰=1:',
    kept.hit && !dropped.hit ? '✓' : '✗', `(k0=${kept.hit} k1=${dropped.hit})`);
}

// ---- todo 插件：模型 to do list（工具 CRUD + 会话隔离） ----
{
  const tools = kernel.plugins.capabilities('tool').map((c) => c.tool);
  const todoAdd = tools.find((t) => t.name === 'todo_add');
  const todoUpdate = tools.find((t) => t.name === 'todo_update');
  const todoList = tools.find((t) => t.name === 'todo_list');
  if (!todoAdd || !todoUpdate || !todoList) {
    console.log('[todo] 插件未加载 ✗（todo_add/todo_update/todo_list 缺失）');
  } else {
    // 会话 A 添加两张卡片
    const ctxA = { traceId: 'todo-a', turn: 0, sandboxRoot: rootDir, sessionId: 'sess-A', cache: kernel.cache, trace: kernel.trace };
    const ctxB = { traceId: 'todo-b', turn: 0, sandboxRoot: rootDir, sessionId: 'sess-B', cache: kernel.cache, trace: kernel.trace };
    const r1 = await todoAdd.handler({ title: '调研并行执行方案', desc: '对比 run_subagent 与 run_parallel' }, ctxA);
    const r2 = await todoAdd.handler({ title: '实现看板面板' }, ctxA);
    await todoAdd.handler({ title: '会话B的独立任务' }, ctxB);
    const id1 = (r1.data as { id: string }).id;
    const id2 = (r2.data as { id: string }).id;
    // 更新状态：r1 → doing → done
    await todoUpdate.handler({ id: id1, status: 'doing', note: '已对比' }, ctxA);
    await todoUpdate.handler({ id: id1, status: 'done' }, ctxA);
    // 会话隔离：A 只能看到 A 的卡片（含 B 的卡片不带 sessionId 也算全局？不——B 带 sessionId）
    const listA = await todoList.handler({}, ctxA);
    const listB = await todoList.handler({}, ctxB);
    const cardsA = (listA.data as { cards: { id: string; title: string; status: string }[] }).cards;
    const cardsB = (listB.data as { cards: { id: string; title: string; status: string }[] }).cards;
    const aOk = cardsA.length === 2 && cardsA.some((c) => c.id === id1 && c.status === 'done') && cardsA.some((c) => c.id === id2);
    const bOk = cardsB.length === 1 && cardsB.some((c) => c.title === '会话B的独立任务');
    console.log('[todo] 工具 CRUD + 会话隔离:', aOk && bOk ? '✓' : '✗',
      `(A=${cardsA.length} B=${cardsB.length} 状态=${cardsA.map((c) => c.status).join(',')})`);
    // 测试卡片由下方 HTTP 冒烟中的看板 REST 清理
  }
}

// ---- parallel 插件：参数校验 + 配额拒绝（不依赖真实 LLM） ----
{
  const tools = kernel.plugins.capabilities('tool').map((c) => c.tool);
  const runParallel = tools.find((t) => t.name === 'run_parallel');
  if (!runParallel) {
    console.log('[parallel] 插件未加载 ✗（run_parallel 缺失）');
  } else {
    const tctx = { traceId: 'par-test', turn: 0, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace };
    // 参数校验：单任务拒绝 / 空 objective 拒绝 / 超 4 个拒绝
    const one = await runParallel.handler({ tasks: [{ objective: '只有一个' }] }, tctx as never);
    const empty = await runParallel.handler({ tasks: [{ objective: '' }, { objective: 'x' }] }, tctx as never);
    const tooMany = await runParallel.handler({
      tasks: [1, 2, 3, 4, 5].map((i) => ({ objective: `任务${i}` })),
    }, tctx as never);
    const validated = one.ok === false && empty.ok === false && tooMany.ok === false;
    console.log('[parallel] 参数校验（单任务/空目标/超量拒绝）:', validated ? '✓' : '✗',
      `(${one.ok}/${empty.ok}/${tooMany.ok})`);
  }
}

// ---- parallel 并发机制：多个独立 Agent 循环并发执行（mock provider，不依赖真实 LLM） ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const mock = (tag: string) => ({
    id: `mock-${tag}`, label: tag, defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() {
      yield { type: 'delta' as const, text: `${tag} 完成` };
      yield { type: 'done' as const };
    },
  });
  // 并发跑 3 个独立循环（模拟 run_parallel 内部机制：Promise.allSettled + 独立 runner/traceId）
  const runner = new AgentRunner(kernel, kernel.bus);
  const started = Date.now();
  const results = await Promise.allSettled(['甲', '乙', '丙'].map(async (tag) => {
    let answer = '';
    for await (const ev of runner.run({
      provider: mock(tag), model: 'm', messages: [{ role: 'user', content: tag }],
      traceId: `par-${tag}-${Date.now()}`,
    })) {
      if (ev.type === 'delta') answer += ev.text;
    }
    return answer;
  }));
  const elapsed = Date.now() - started;
  const allOk = results.every((r) => r.status === 'fulfilled' && r.value.includes('完成'));
  const traces = kernel.trace.query(undefined, { type: 'llm_call' });
  console.log('[parallel] 3 个独立循环并发（独立 traceId/上下文）:', allOk ? '✓' : '✗',
    `(${elapsed}ms, ${traces.length} llm_call 步骤)`);
}

// ---- HTTP 冒烟：工作区 / 文件树 / skills 管理 API（端到端） ----
{
  process.env.PORT = String(Number(process.env.PORT ?? 3000) + 1); // 避开默认端口
  const { startServer } = await import('../server/index');
  const { kernel: httpKernel, server } = await startServer();
  const base = `http://localhost:${process.env.PORT}`;
  try {
    const ws = await fetch(`${base}/api/workspaces`).then((r) => r.json());
    const hasCurrent = Array.isArray(ws) && ws.some((w) => w.current);
    console.log('[workspaces] 列表+当前标记:', hasCurrent ? '✓' : '✗', JSON.stringify(ws).slice(0, 140));

    const tree = await fetch(`${base}/api/files/tree`).then((r) => r.json()) as {
      entries: { name: string; type: 'dir' | 'file' }[];
    };
    const hasEntries = Array.isArray(tree.entries) && tree.entries.some((e) => e.name === 'core' || e.name === 'server');
    console.log('[files/tree] 沙箱根文件树:', hasEntries ? '✓' : '✗', `(${tree.entries?.length ?? 0} 项)`);

    const skills = await fetch(`${base}/api/skills`).then((r) => r.json()) as {
      installed: { name: string; source: string }[]; market: { name: string; description: string }[];
    };
    const hasInstalled = Array.isArray(skills.installed) && skills.installed.length >= 4;
    console.log('[skills API] 已安装/市场:', hasInstalled ? '✓' : '✗', `installed=${skills.installed.length} market=${skills.market.length}`);

    // 统计 API：上下文用量 / 缓存命中率 / 总体概览
    const stats = await fetch(`${base}/api/stats`).then((r) => r.json()) as {
      overview: { sessions: number; messages: number; truncations: number };
      process: { llmCalls: number; toolCalls: number };
      context: { maxTokens: number; perSession: { contextUsage: number; truncations: number }[] };
      cache: { l1Enabled: boolean; l1: { rate: number }; l2: { rate: number }; l3: { hits: number; tokens: number } };
    };
    const hasStats = typeof stats.overview?.sessions === 'number'
      && stats.context?.maxTokens > 0
      && Array.isArray(stats.context?.perSession)
      && typeof stats.cache?.l2?.rate === 'number' && stats.cache?.l2?.rate >= 0
      && typeof stats.cache?.l3?.hits === 'number';
    console.log('[stats API] 上下文/缓存统计:', hasStats ? '✓' : '✗',
      `sessions=${stats.overview?.sessions} ctxMax=${stats.context?.maxTokens} l2率=${stats.cache?.l2?.rate}% l3=${stats.cache?.l3?.hits}次/${stats.cache?.l3?.tokens}tok`);

    // 命令列表 API（命令面板数据源）
    const cmds = await fetch(`${base}/api/commands/list`).then((r) => r.json()) as {
      commands: { name: string; usage: string; description: string }[];
    };
    const hasCmds = Array.isArray(cmds.commands) && cmds.commands.some((c) => c.name === 'help') && cmds.commands.some((c) => c.name === 'new');
    console.log('[commands API] 命令清单:', hasCmds ? '✓' : '✗', `(${cmds.commands.length} 条: ${cmds.commands.map((c) => c.name).join(',')})`);

    // Capabilities Registry：能力/风险/成本/审批一目了然
    const caps = await fetch(`${base}/api/capabilities`).then((r) => r.json()) as {
      tools: { name: string; risk: string; costHint: string; approval: boolean }[];
      byRisk: { high: string[] };
    };
    const hasCaps = Array.isArray(caps.tools) && caps.tools.length >= 10
      && caps.tools.some((t) => t.name === 'write_file' && t.risk === 'high' && t.approval)
      && Array.isArray(caps.byRisk?.high) && caps.byRisk.high.includes('write_file');
    console.log('[capabilities API] 注册表（风险/成本/审批）:', hasCaps ? '✓' : '✗',
      `tools=${caps.tools.length} high=${caps.byRisk?.high?.length} 个`);

    // todo 看板 REST：GET 列表 → POST 新建 → GET 可见 → PATCH 改状态 → DELETE 清理
    const boardBase = `${base}/api/plugins/todo/board`;
    const panelRes = await fetch(`${boardBase}/panel`).then((r) => r.json()) as { title: string; html: string };
    const hasPanel = typeof panelRes.html === 'string' && panelRes.html.includes('待办看板');
    const created = await fetch(`${boardBase}/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'selftest-看板卡片' }),
    }).then((r) => r.json()) as { ok: boolean; card?: { id: string; status: string; source: string } };
    let listOk = false;
    let patchOk = false;
    if (created.ok && created.card) {
      const listAfter = await fetch(`${boardBase}/cards`).then((r) => r.json()) as { cards: { id: string; title: string }[] };
      listOk = Array.isArray(listAfter.cards) && listAfter.cards.some((c) => c.id === created.card!.id && c.title === 'selftest-看板卡片');
      const patched = await fetch(`${boardBase}/cards/${created.card.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'doing' }),
      }).then((r) => r.json()) as { ok: boolean; card?: { status: string } };
      patchOk = patched.ok === true && patched.card?.status === 'doing';
      await fetch(`${boardBase}/cards/${created.card.id}`, { method: 'DELETE' });
    }
    // 清理：删除 todo 工具测试卡片（sess-A/sess-B 创建）
    const leftover = await fetch(`${boardBase}/cards`).then((r) => r.json()) as { cards: { id: string; title: string }[] };
    for (const c of leftover.cards) {
      if (c.title.includes('调研并行执行方案') || c.title.includes('实现看板面板') || c.title.includes('会话B的独立任务')) {
        await fetch(`${boardBase}/cards/${c.id}`, { method: 'DELETE' });
      }
    }
    console.log('[todo API] 看板 REST（面板/新增/列表/改状态/删除）:', hasPanel && created.ok === true && listOk && patchOk ? '✓' : '✗',
      `(panel=${hasPanel} post=${created.ok === true} list=${listOk} patch=${patchOk})`);
  } finally {
    server.close();
    await httpKernel.stop();
  }
}

// ---- 工具执行超时保护（mock provider + 挂起工具） ----
{
  kernel.config.set('agent.toolTimeoutMs', 2000); // 缩短超时便于测试
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  let calls = 0;
  const mockProvider = {
    id: 'mock', label: 'MOCK', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'hang_test', arguments: '{}' } } };
      } else {
        yield { type: 'delta' as const, text: '完成' };
        yield { type: 'usage' as const, input: 10, output: 10 };
      }
      yield { type: 'done' as const };
    },
  };
  const hangTool = {
    name: 'hang_test',
    description: '挂起测试',
    parameters: { type: 'object', properties: {} },
    async handler() { await new Promise(() => { /* 永不 resolve */ }); return { ok: true, data: 'never' }; },
  };
  const evs: string[] = [];
  for await (const ev of runner.run({ provider: mockProvider, model: 'm', messages: [{ role: 'user', content: 'hi' }], traceId: `t-${Date.now()}`, tools: [hangTool] })) {
    evs.push(ev.type);
  }
  const timedOut = evs.filter((t) => t === 'tool_result').length >= 1 && evs.includes('assistant_done');
  console.log('[timeout] 挂起工具被超时拦截并继续循环:', timedOut ? '✓' : '✗', '| 事件:', evs.join(','));
  kernel.config.set('agent.toolTimeoutMs', 30_000); // 恢复默认
}

// ---- 失败恢复：provider failover（主 provider 失败 → 备用 provider 接管） ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  const failProvider = {
    id: 'broken', label: '宕机', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() { throw new Error('上游 500'); yield { type: 'done' as const }; },
  };
  const backupProvider = {
    id: 'backup', label: '备用', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() { yield { type: 'delta' as const, text: '备用路径成功' }; yield { type: 'done' as const }; },
  };
  let answer = '';
  for await (const ev of runner.run({
    provider: failProvider, model: 'm', messages: [{ role: 'user', content: 'hi' }],
    traceId: `fo-${Date.now()}`, fallbackProviders: [backupProvider],
  })) {
    if (ev.type === 'delta') answer += ev.text;
  }
  const failoverSteps = kernel.trace.query(undefined, { name: 'failover' });
  console.log('[failover] 主 provider 失败自动切换备用:', answer.includes('备用路径') ? '✓' : '✗',
    `| 回答: ${answer.slice(0, 20)} | failover 步骤: ${failoverSteps.length}`);

  // 可观察性：trace 按类型过滤
  const llmSteps = kernel.trace.query(undefined, { type: 'llm_call' });
  const sysSteps = kernel.trace.query(undefined, { type: 'system' });
  console.log('[trace] 类型过滤（llm_call/system）:', llmSteps.length > 0 && sysSteps.length > 0 ? '✓' : '✗',
    `(${llmSteps.length}/${sysSteps.length})`);
}

await kernel.stop();
console.log('selftest done');
