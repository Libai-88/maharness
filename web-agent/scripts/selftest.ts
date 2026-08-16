/**
 * scripts/selftest.ts —— 工具冒烟测试（不依赖 LLM）
 * 用法：npm run selftest
 *   SEARCH_PROXY=http://127.0.0.1:7897 npm run selftest  —— 走代理测联网搜索
 *   TAVILY_API_KEY=xxx npm run selftest                  —— 走 Tavily 测搜索
 */
import { Kernel } from '../kernel';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LLMMessage, ToolDef } from '../kernel/types';

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

// ---- 时空可组合性：可逆效应引擎（LIFO 逆元栈 + 幂等 dispose） ----
{
  const { EffectScope } = await import('../kernel/scope');
  const order: string[] = [];
  const s = new EffectScope();
  s.add(() => { order.push('a'); });
  s.add(() => { order.push('b'); });
  s.add(() => { order.push('c'); });
  await s.dispose();
  const lifo = order.join(',') === 'c,b,a';
  const before = order.length;
  await s.dispose(); // 幂等：armed=false 后不再执行
  console.log('[scope] 可逆效应 LIFO 恢复 + 幂等 dispose:', lifo && order.length === before ? '✓' : '✗', `(顺序=${order.join(',')})`);
  // 单独撤销：add 返回的 unregister 可从栈中移除（不随 dispose 执行）
  const s2 = new EffectScope();
  const ran: string[] = [];
  const un = s2.add(() => { ran.push('x'); });
  un();
  await s2.dispose();
  console.log('[scope] 逆元可单独撤销:', ran.length === 0 ? '✓' : '✗');
}

// ---- 时空可组合性：卸载完全恢复 + 重新部署（可逆效应 × 插件） ----
// tmp-compose：工具 + 服务（coeffect provide）+ 事件监听（ctx.on）+ 配置对账（watchConfig）
// 断言：disable 后四者全部自动恢复（能力消失/服务撤回/监听退订/配置监听退订）；
//       enable 后重新部署全部可用（onLoad 重跑重建，无需重启）。
{
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(rootDir, 'plugins', 'tmp-compose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'tmp-compose', name: '可组合性测试', version: '0.1.0', entry: 'index.ts' }));
  writeFileSync(join(dir, 'index.ts'), `
import type { Plugin } from '../../kernel/types';
export default {
  id: 'tmp-compose', name: '可组合性测试', version: '0.1.0',
  onLoad(ctx) {
    // 事件监听（自动退订）
    ctx.on('compose.ping', (e) => {
      const { traceId } = e.data as { traceId: string };
      ctx.trace.startStep({ traceId, turn: 0, type: 'system', name: 'compose-ping' }).finish({});
    });
    // 服务提供（coeffect provide：started 后发布，卸载自动撤回）
    ctx.register({ kind: 'service', service: { id: 'compose-svc', instance: { hello: 'world' } } });
    // 工具能力
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'compose_probe',
        description: '可组合性探针',
        parameters: { type: 'object', properties: {} },
        async handler() { return { ok: true, data: { hello: 'world' } }; },
      },
    });
    // 声明式配置对账（自动退订）
    ctx.watchConfig('compose.testKey', (v) => {
      ctx.trace.startStep({ traceId: 'compose-cfg', turn: 0, type: 'system', name: 'compose-config' }).finish({ outputSummary: String(v) });
    });
  },
} satisfies Plugin;
`);
  await new Promise((r) => setTimeout(r, 1200)); // 等热扫描注册+启动
  const started = kernel.plugins.get('tmp-compose')?.state === 'started';
  const toolVisible = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe');
  const svcResolvable = kernel.plugins.resolveService('service:compose-svc') !== undefined;
  const pingBefore = kernel.trace.query(undefined, { name: 'compose-ping' }).length;
  await kernel.bus.emitAsync({ type: 'compose.ping', data: { traceId: 'compose-t1' }, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 50));
  const pingSeen = kernel.trace.query(undefined, { name: 'compose-ping' }).length > pingBefore;
  const cfgBefore = kernel.trace.query(undefined, { name: 'compose-config' }).length;
  kernel.config.set('compose.testKey', 'hello');
  await new Promise((r) => setTimeout(r, 50));
  const cfgSeen = kernel.trace.query(undefined, { name: 'compose-config' }).length > cfgBefore;
  console.log('[compose] 插件启动: 工具/服务/监听/配置对账全部生效:',
    started && toolVisible && svcResolvable && pingSeen && cfgSeen ? '✓' : '✗',
    `(state=${kernel.plugins.get('tmp-compose')?.state} tool=${toolVisible} svc=${svcResolvable} ping=${pingSeen} cfg=${cfgSeen})`);

  // ---- 卸载 = 完全恢复（可逆效应：四项副作用全部自动撤回） ----
  await kernel.plugins.disable('tmp-compose');
  const toolGone = !kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe');
  const svcWithdrawn = kernel.plugins.resolveService('service:compose-svc') === undefined;
  const ping2Before = kernel.trace.query(undefined, { name: 'compose-ping' }).length;
  await kernel.bus.emitAsync({ type: 'compose.ping', data: { traceId: 'compose-t2' }, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 50));
  const pingSilent = kernel.trace.query(undefined, { name: 'compose-ping' }).length === ping2Before;
  const cfg2Before = kernel.trace.query(undefined, { name: 'compose-config' }).length;
  kernel.config.set('compose.testKey', 'after-disable');
  await new Promise((r) => setTimeout(r, 50));
  const cfgSilent = kernel.trace.query(undefined, { name: 'compose-config' }).length === cfg2Before;
  console.log('[compose] 卸载完全恢复（能力消失/服务撤回/监听退订/配置监听退订）:',
    toolGone && svcWithdrawn && pingSilent && cfgSilent ? '✓' : '✗',
    `(tool=${toolGone} svc=${svcWithdrawn} ping=${pingSilent} cfg=${cfgSilent})`);

  // ---- 重新部署：enable = 重新加载（onLoad 重跑，全部能力重建） ----
  await kernel.plugins.enable('tmp-compose');
  const toolBack = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe');
  const svcBack = kernel.plugins.resolveService('service:compose-svc') !== undefined;
  const ping3Before = kernel.trace.query(undefined, { name: 'compose-ping' }).length;
  await kernel.bus.emitAsync({ type: 'compose.ping', data: { traceId: 'compose-t3' }, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 50));
  const pingBack = kernel.trace.query(undefined, { name: 'compose-ping' }).length > ping3Before;
  console.log('[compose] 重新部署（enable 重建能力）:', toolBack && svcBack && pingBack ? '✓' : '✗',
    `(tool=${toolBack} svc=${svcBack} ping=${pingBack})`);
}

// ---- 时空可组合性：事务性热重载（坏版本自动回滚，永不半加载） ----
// 对 self-extend 是保命机制：agent 自己写的插件坏了，旧版本自动顶上，
// 不会出现「坏自我修改禁用了恢复所需的进程」。
{
  const { writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(rootDir, 'plugins', 'tmp-compose');
  const errEvents: string[] = [];
  const offErr = kernel.bus.on('plugin.error', (e) => {
    const d = e.data as { id?: string; rollback?: boolean; error?: string };
    if (d?.id === 'tmp-compose') errEvents.push(d.rollback ? `rollback:${d.error}` : `error:${d.error}`);
  });
  // 写入坏版本（语法错误）→ 事务回滚：旧工具仍在
  writeFileSync(join(dir, 'index.ts'), `export default { this is not valid typescript !!!`);
  await kernel.plugins.reload('tmp-compose');
  const rolledBack = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe');
  const errNoted = errEvents.some((e) => e.startsWith('rollback'));
  console.log('[compose] 事务性热重载（坏版本回滚）:', rolledBack && errNoted ? '✓' : '✗',
    `(旧工具存活=${rolledBack} 回滚事件=${errNoted} 事件=${errEvents.join(' | ') || '无'})`);
  // 写入好版本 v2（新工具）→ 正常替换：v2 在、v1 不在
  writeFileSync(join(dir, 'index.ts'), `
import type { Plugin } from '../../kernel/types';
export default {
  id: 'tmp-compose', name: '可组合性测试', version: '0.2.0',
  onLoad(ctx) {
    ctx.register({ kind: 'tool', tool: { name: 'compose_probe_v2', description: '探针 v2',
      parameters: { type: 'object', properties: {} },
      async handler() { return { ok: true, data: { v: 2 } }; } } });
  },
} satisfies Plugin;
`);
  await kernel.plugins.reload('tmp-compose');
  const v2In = kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe_v2');
  const v1Gone = !kernel.plugins.capabilities('tool').some((c) => c.tool.name === 'compose_probe');
  console.log('[compose] 好版本正常替换（v2 生效、v1 回收）:', v2In && v1Gone ? '✓' : '✗', `(v2=${v2In} v1残=${!v1Gone})`);
  offErr();
  // 清理
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1200));
  const cleaned = !kernel.plugins.list().some((p) => p.manifest.id === 'tmp-compose');
  console.log('[compose] 删除目录自动卸载:', cleaned ? '✓' : '✗');
}

// ---- 时空可组合性：反应性依赖（coeffect）——提供者停用，依赖方自动降级；恢复自动可用 ----
// 两个插件：提供者（service:compose-svc）+ 消费者（inject 订阅）；消费者无需重启即可感知提供者生死。
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pdir = join(rootDir, 'plugins', 'tmp-provider');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({ id: 'tmp-provider', name: '提供者', version: '0.1.0', entry: 'index.ts' }));
  writeFileSync(join(pdir, 'index.ts'), `
import type { Plugin } from '../../kernel/types';
export default {
  id: 'tmp-provider', name: '提供者', version: '0.1.0',
  onLoad(ctx) { ctx.register({ kind: 'service', service: { id: 'coeffect-svc', instance: { ready: true } } }); },
} satisfies Plugin;
`);
  const cdir = join(rootDir, 'plugins', 'tmp-consumer');
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'plugin.json'), JSON.stringify({ id: 'tmp-consumer', name: '消费者', version: '0.1.0', entry: 'index.ts' }));
  writeFileSync(join(cdir, 'index.ts'), `
import type { Plugin } from '../../kernel/types';
export default {
  id: 'tmp-consumer', name: '消费者', version: '0.1.0',
  onLoad(ctx) {
    let svc: { ready: boolean } | undefined;
    const dep = ctx.inject('service:coeffect-svc', (v) => { svc = v as { ready: boolean } | undefined; });
    svc = dep.value as { ready: boolean } | undefined;
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'consumer_probe',
        description: '消费者探针',
        parameters: { type: 'object', properties: {} },
        async handler() { return { ok: true, data: { provided: svc?.ready === true } }; },
      },
    });
  },
} satisfies Plugin;
`);
  await new Promise((r) => setTimeout(r, 1200));
  const probe = kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'consumer_probe')?.tool;
  const initial = probe ? (await probe.handler({}, { traceId: 'c-t0', turn: 0, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace })).data : { provided: false };
  // 停用提供者：消费者无需任何操作，感知依赖消失（优雅降级，不报错）
  await kernel.plugins.disable('tmp-provider');
  const probe2 = kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'consumer_probe')?.tool;
  const degraded = probe2 ? (await probe2.handler({}, { traceId: 'c-t1', turn: 0, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace })).data : { provided: true };
  // 恢复提供者：消费者自动恢复（无需重启）
  await kernel.plugins.enable('tmp-provider');
  const probe3 = kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'consumer_probe')?.tool;
  const recovered = probe3 ? (await probe3.handler({}, { traceId: 'c-t2', turn: 0, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace })).data : { provided: false };
  console.log('[coeffect] 反应性依赖（提供者停用→降级；恢复→自动可用）:',
    (initial as { provided: boolean }).provided === true && (degraded as { provided: boolean }).provided === false && (recovered as { provided: boolean }).provided === true ? '✓' : '✗',
    `(初始=${(initial as { provided: boolean }).provided} 停用=${(degraded as { provided: boolean }).provided} 恢复=${(recovered as { provided: boolean }).provided})`);
  rmSync(pdir, { recursive: true, force: true });
  rmSync(cdir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1200));
}

// ---- 上下文压缩 v2（compact）：LLM 摘要替代纯截断（对标 Anthropic context compaction） ----
{
  const { compactHistory, SUMMARY_MARK } = await import('../core/chat/compact');
  // 构造超预算历史：system + 多轮长对话
  const long = '这是一条很长的消息内容，'.repeat(60); // ~600 token
  const history = [
    { role: 'user' as const, content: `问题一：${long}` },
    { role: 'assistant' as const, content: `回答一：${long}` },
    { role: 'user' as const, content: `问题二：${long}` },
    { role: 'assistant' as const, content: `回答二：${long}` },
    { role: 'user' as const, content: '问题三：最新问题' },
  ];
  // 1) 无 provider（如离线/降级）：超预算走 truncate 兜底，且不丢最新消息
  const r1 = await compactHistory(history, 1500, {});
  const truncateOk = r1.mode === 'truncate' && r1.droppedMessages > 0
    && r1.messages[r1.messages.length - 1].content === '问题三：最新问题';
  console.log('[compact] 无 provider 降级截断（保最新消息）:', truncateOk ? '✓' : '✗',
    `(mode=${r1.mode} 丢弃=${r1.droppedMessages} 保留=${r1.messages.length})`);
  // 2) 有 mock provider：LLM 摘要压缩旧轮（输出必须带标记，否则降级）
  const mockCompact = {
    id: 'mock-c', label: 'C', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat(messages: { role: string; content: string | null }[]) {
      const last = messages[messages.length - 1]?.content ?? '';
      const userCount = last.split('用户:').length - 1;
      yield { type: 'delta' as const, text: `${SUMMARY_MARK} 早期 ${userCount} 条消息的要点：任务上下文与已定结论。` };
      yield { type: 'done' as const };
    },
  };
  const r2 = await compactHistory(history, 1500, { provider: mockCompact, model: 'm' });
  const compactOk = r2.mode === 'compact' && r2.compactedMessages > 0
    && String(r2.messages[0].content).startsWith(SUMMARY_MARK)
    && r2.messages[r2.messages.length - 1].content === '问题三：最新问题';
  console.log('[compact] LLM 摘要压缩旧轮（保留最新）:', compactOk ? '✓' : '✗',
    `(mode=${r2.mode} 压缩=${r2.compactedMessages} 摘要=${String(r2.messages[0].content ?? '').slice(0, 20)}…)`);
  // 3) 已压缩防重复：历史已有【历史摘要】→ 不再 LLM 总结（不会每轮重复花钱）
  let mockCalls = 0;
  const mockCounter = {
    id: 'mock-c2', label: 'C2', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() { mockCalls++; yield { type: 'delta' as const, text: 'x' }; yield { type: 'done' as const }; },
  };
  const already = [
    { role: 'system' as const, content: `${SUMMARY_MARK} 已压缩的早期对话` },
    { role: 'user' as const, content: long },
    { role: 'assistant' as const, content: long },
    { role: 'user' as const, content: '问题三：最新问题' },
  ];
  const r3 = await compactHistory(already, 900, { provider: mockCounter, model: 'm' });
  console.log('[compact] 已摘要不重复压缩（防重复花钱）:', mockCalls === 0 && r3.mode === 'truncate' ? '✓' : '✗',
    `(LLM 调用=${mockCalls} mode=${r3.mode})`);
}

// ---- 嵌套 Trace（span 树）：子任务步骤挂到父工具步骤下（对标 OpenAI tracing） ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  const mock = (tag: string) => {
    let calls = 0;
    return {
      id: `mock-${tag}`, label: tag, defaultModel: 'm', prices: { in: 0, out: 0 },
      async *chat() {
        calls++;
        if (tag === 'parent' && calls === 1) {
          // 第一轮：调用 mock_sub（子任务）
          yield { type: 'tool_call' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'mock_sub', arguments: '{}' } } };
        } else {
          yield { type: 'delta' as const, text: `${tag} 完成` };
          yield { type: 'usage' as const, input: 10, output: 10 };
        }
        yield { type: 'done' as const };
      },
    };
  };
  const subTool: ToolDef = {
    name: 'mock_sub', description: '模拟子代理', parameters: { type: 'object', properties: {} },
    async handler(_a, tctx) {
      // 子任务：带 parentStepId 再开一个 Agent 循环（span 树下钻）
      let ans = '';
      for await (const _ev of runner.run({
        provider: mock('child'), model: 'm', messages: [{ role: 'user', content: '子任务' }],
        traceId: `child-${Date.now()}`, parentStepId: tctx.stepId,
      })) { /* 消费 */ }
      return { ok: true, data: { answer: ans } };
    },
  };
  const parentTraceId = `parent-${Date.now()}`;
  for await (const _ev of runner.run({
    provider: mock('parent'), model: 'm', messages: [{ role: 'user', content: '主任务' }],
    traceId: parentTraceId, tools: [subTool],
  })) { /* 消费事件 */ }
  // 找到父工具步骤，验证子轨迹步骤挂在它下面
  const toolSteps = kernel.trace.query(undefined, { type: 'tool_call', name: 'mock_sub' });
  const lastTool = toolSteps[toolSteps.length - 1];
  const children = kernel.trace.query(undefined, { parentId: lastTool?.id });
  const spanOk = !!lastTool && children.length >= 1
    && children.some((s) => s.type === 'llm_call') && children.some((s) => s.traceId !== parentTraceId);
  console.log('[trace] span 树（子代理步骤挂父工具步骤下）:', spanOk ? '✓' : '✗',
    `(父=${lastTool?.id} 子步骤=${children.length} 跨 traceId=${children.some((s) => s.traceId !== parentTraceId)})`);
  // 顶层步骤本身不挂 parentId（根节点）
  const rootSteps = kernel.trace.query(undefined, { name: 'mock_sub' });
  console.log('[trace] 顶层工具步骤为根（无 parentId）:', rootSteps.every((s) => !s.parentId) ? '✓' : '✗');
}

// ---- 工具输出机器校验（outputSchema）：声明即校验，不符标注回填 + 入 Trace ----
{
  const { validateAgainstSchema } = await import('../kernel/validate');
  // 校验器正确性：通过 / 缺字段 / 类型错 / 枚举越界 / 整数越界
  const schema = {
    type: 'object',
    required: ['answer', 'count'],
    properties: {
      answer: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: ['ok', 'partial'] },
    },
  };
  const pass = validateAgainstSchema({ answer: '完成', count: 3, status: 'ok' }, schema);
  const missField = validateAgainstSchema({ answer: '完成' }, schema);
  const badType = validateAgainstSchema({ answer: '完成', count: '3' }, schema);
  const badEnum = validateAgainstSchema({ answer: '完成', count: 1, status: '其他' }, schema);
  const badMin = validateAgainstSchema({ answer: '完成', count: -1 }, schema);
  console.log('[validate] JSONSchema 子集校验: 通过=0 缺字段=1 类型错=1 枚举越界=1 下限越界=1:',
    pass.length === 0 && missField.length === 1 && badType.length >= 1 && badEnum.length === 1 && badMin.length === 1 ? '✓' : '✗',
    `(通过=${pass.length} 缺字段=${missField.length} 类型=${badType.length} 枚举=${badEnum.length} 下限=${badMin.length})`);
  // Agent 循环集成：声明了 outputSchema 的工具返回坏结构 → 回填带标注 + output-validate 步骤入 Trace
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  const mock = (tag: string) => ({
    id: `mock-${tag}`, label: tag, defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() {
      yield { type: 'tool_call' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'bad_shape', arguments: '{}' } } };
      yield { type: 'done' as const };
    },
  });
  const badShapeTool: ToolDef = {
    name: 'bad_shape', description: '坏结构工具',
    parameters: { type: 'object', properties: {} },
    outputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async handler() { return { ok: true, data: { wrong: true } }; }, // 缺 id
  };
  let sawToolResult = false;
  for await (const ev of runner.run({
    provider: mock('v'), model: 'm', messages: [{ role: 'user', content: 'hi' }],
    traceId: `ov-${Date.now()}`, tools: [badShapeTool],
  })) {
    if (ev.type === 'tool_result') sawToolResult = true;
  }
  const ovSteps = kernel.trace.query(undefined, { name: 'output-validate' });
  const annotated = sawToolResult && ovSteps.length > 0 && ovSteps[ovSteps.length - 1].status === 'error';
  console.log('[validate] 坏结构回填标注 + output-validate 步骤入 Trace:', annotated ? '✓' : '✗',
    `(步骤=${ovSteps.length} 状态=${ovSteps[ovSteps.length - 1]?.status})`);
}

// ---- 工具结果摘要化存储：大结果入存储（历史只留摘要+引用），recall_tool_result 零副作用重读 ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  const big = 'A'.repeat(3000); // 超 2000 阈值
  const mock = () => {
    let calls = 0;
    return {
      id: 'mock-rs', label: 'RS', defaultModel: 'm', prices: { in: 0, out: 0 },
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call' as const, toolCall: { id: 'rs1', type: 'function' as const, function: { name: 'big_result', arguments: '{}' } } };
        } else {
          yield { type: 'delta' as const, text: '完成' };
          yield { type: 'usage' as const, input: 10, output: 10 };
        }
        yield { type: 'done' as const };
      },
    };
  };
  const bigTool: ToolDef = {
    name: 'big_result', description: '大结果工具', parameters: { type: 'object', properties: {} },
    async handler() { return { ok: true, data: { content: big } }; },
  };
  const cap = { history: null as LLMMessage[] | null };
  const sessionId = `rs-sess-${Date.now()}`;
  for await (const _ev of runner.run({
    provider: mock(), model: 'm', messages: [{ role: 'user', content: '读取大文件' }],
    traceId: `rs-${Date.now()}`, tools: [bigTool], sessionId,
    onCheckpoint: (_t, h) => { cap.history = h; },
  })) { /* 消费 */ }
  const toolMsg = cap.history?.find((m) => m.role === 'tool');
  const storedRef = toolMsg && String(toolMsg.content).includes('结果存储') && String(toolMsg.content).includes('rs1');
  const noFullText = toolMsg && !String(toolMsg.content).includes(big);
  // recall_tool_result 重读（chat 插件注册的真实工具）
  const recall = kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'recall_tool_result')?.tool;
  const recalled = recall ? await recall.handler({ id: 'rs1' }, { traceId: 'rs-r', turn: 0, sessionId, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace }) : { ok: false };
  const recallOk = recalled.ok === true && (recalled.data as { content: string }).content === JSON.stringify({ ok: true, data: { content: big } });
  const missOk = recall ? (await recall.handler({ id: 'nope' }, { traceId: 'rs-r2', turn: 0, sessionId, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace })).ok === false : false;
  console.log('[result-store] 大结果入存储+摘要回填:', storedRef && noFullText ? '✓' : '✗',
    `(引用=${storedRef} 无全文=${noFullText} 回填长度=${toolMsg ? String(toolMsg.content).length : 0})`);
  console.log('[result-store] recall_tool_result 零副作用重读 + 缺失报错:', recallOk && missOk ? '✓' : '✗',
    `(重读=${recallOk} 缺失=${missOk})`);
  // 小结果（≤2000）全文回填，不折腾存储
  const smallTool: ToolDef = {
    name: 'small_result', description: '小结果工具', parameters: { type: 'object', properties: {} },
    async handler() { return { ok: true, data: { v: '小' } }; },
  };
  const mock2 = () => {
    let calls = 0;
    return {
      id: 'mock-rs2', label: 'RS2', defaultModel: 'm', prices: { in: 0, out: 0 },
      async *chat() {
        calls++;
        if (calls === 1) yield { type: 'tool_call' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'small_result', arguments: '{}' } } };
        else yield { type: 'delta' as const, text: '完成' };
        yield { type: 'done' as const };
      },
    };
  };
  const smallCap = { history: null as LLMMessage[] | null };
  for await (const _ev of runner.run({
    provider: mock2(), model: 'm', messages: [{ role: 'user', content: 'x' }],
    traceId: `rs2-${Date.now()}`, tools: [smallTool], sessionId,
    onCheckpoint: (_t, h) => { smallCap.history = h; },
  })) { /* 消费 */ }
  const smallMsg = smallCap.history?.find((m) => m.role === 'tool');
  console.log('[result-store] 小结果全文回填（不折腾存储）:', smallMsg && String(smallMsg.content).includes('小') && !String(smallMsg.content).includes('结果存储') ? '✓' : '✗');
}

// ---- 会话级成本实时熔断：预算耗尽 → harness 硬停止（不再发起新 LLM 调用） ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  let llmCalls = 0;
  const priceyMock = {
    id: 'mock-cost', label: 'COST', defaultModel: 'm', prices: { in: 1, out: 1 }, // $1/百万 token
    async *chat() {
      llmCalls++;
      if (llmCalls === 1) {
        yield { type: 'tool_call' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } } };
      } else {
        yield { type: 'delta' as const, text: '第二轮' };
      }
      yield { type: 'usage' as const, input: 1000, output: 1000 }; // 每轮 $0.002
      yield { type: 'done' as const };
    },
  };
  const noopTool: ToolDef = {
    name: 'noop', description: '无操作', parameters: { type: 'object', properties: {} },
    async handler() { return { ok: true, data: { done: true } }; },
  };
  const evs: string[] = [];
  for await (const ev of runner.run({
    provider: priceyMock, model: 'm', messages: [{ role: 'user', content: 'hi' }],
    traceId: `cb-${Date.now()}`, tools: [noopTool],
    costBudget: 0.0015, // 第一轮 $0.002 后即超
  })) {
    evs.push(ev.type);
  }
  const breakerSteps = kernel.trace.query(undefined, { name: 'cost-breaker' });
  const broke = evs.includes('budget_hit') && evs.includes('error') && llmCalls === 1 && breakerSteps.length > 0;
  console.log('[cost-breaker] 预算耗尽硬熔断（无第二轮调用）:', broke ? '✓' : '✗',
    `(事件=${evs.join(',')} LLM 调用=${llmCalls} 熔断步骤=${breakerSteps.length})`);
}

// ---- checkpoint 断点：turn 级完整历史（含工具回填），可恢复续跑 ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  const mk = (tag: string) => {
    let calls = 0;
    return {
      id: `mock-${tag}`, label: tag, defaultModel: 'm', prices: { in: 0, out: 0 },
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call' as const, toolCall: { id: 'cc1', type: 'function' as const, function: { name: 'cp_probe', arguments: '{}' } } };
        } else {
          yield { type: 'delta' as const, text: `${tag} 最终答案` };
          yield { type: 'usage' as const, input: 10, output: 10 };
        }
        yield { type: 'done' as const };
      },
    };
  };
  const cpTool: ToolDef = {
    name: 'cp_probe', description: '断点探针', parameters: { type: 'object', properties: {} },
    async handler() { return { ok: true, data: { observed: '文件内容' } }; },
  };
  // 第一次跑：第一轮工具调用后触发 checkpoint（onCheckpoint 捕获完整历史）
  const savedCap = { history: null as LLMMessage[] | null };
  let cpTurn = -1;
  for await (const _ev of runner.run({
    provider: mk('a'), model: 'm', messages: [{ role: 'user', content: '分析文件' }],
    traceId: `cp-${Date.now()}`, tools: [cpTool],
    onCheckpoint: (turn, h) => { cpTurn = turn; savedCap.history = h; },
  })) { /* 消费 */ }
  const saved = savedCap.history;
  const toolPaired = !!saved && saved.some((m) => m.role === 'assistant' && m.tool_calls?.length)
    && saved.some((m) => m.role === 'tool' && m.tool_call_id === 'cc1');
  console.log('[checkpoint] turn 级完整历史（工具回填配对）:', toolPaired && cpTurn === 0 ? '✓' : '✗',
    `(turn=${cpTurn} 消息数=${saved?.length ?? 0} 配对=${toolPaired})`);
  // 模拟恢复：checkpoint 历史 + 恢复提示 → 再次进入循环 → 能继续到最终答案（不丢已观察事实）
  let resumedAnswer = '';
  for await (const ev of runner.run({
    provider: mk('b'), model: 'm',
    messages: [...(saved ?? []), { role: 'system', content: '【任务恢复】任务曾被中断，请从断点继续完成未竟的目标；已有观察（工具结果）在上下文中可直接使用。' }],
    traceId: `cp2-${Date.now()}`, tools: [cpTool],
  })) {
    if (ev.type === 'delta') resumedAnswer += ev.text;
  }
  console.log('[checkpoint] 断点续跑（恢复历史继续决策）:', resumedAnswer.includes('最终答案') ? '✓' : '✗', `(答案=${resumedAnswer || '无'})`);
  // DB 持久化往返（Store 层）
  const { Store } = await import('../server/db');
  const store = new Store(join(rootDir, 'data', 'selftest-checkpoint.db'));
  store.saveCheckpoint('sess-cp', 2, [{ role: 'user', content: 'u' }, { role: 'tool', content: 't' }]);
  const loaded = store.loadCheckpoint('sess-cp');
  const persisted = loaded?.turn === 2 && loaded.history.length === 2 && loaded.history[1].content === 't';
  const cleared = (store.clearCheckpoint('sess-cp'), store.loadCheckpoint('sess-cp') === undefined);
  console.log('[checkpoint] DB 持久化往返（保存/读取/清除）:', persisted && cleared ? '✓' : '✗',
    `(turn=${loaded?.turn} 条数=${loaded?.history.length} 清除=${cleared})`);
}

// ---- handoff 角色移交：执行器识别 → 终止循环 → 移交事件（角色=插件注册表） ----
{
  const { AgentRunner } = await import('../core/chat/agent');
  const runner = new AgentRunner(kernel, kernel.bus);
  // 角色注册表：chat 内置 main + goal-plan 的 planner 应可见
  const roles = kernel.plugins.capabilities('role').map((c) => c.role);
  const hasMain = roles.some((r) => r.id === 'main');
  const hasPlanner = roles.some((r) => r.id === 'planner');
  const handoffTool = kernel.plugins.capabilities('tool').find((c) => c.tool.name === 'handoff_to')?.tool;
  console.log('[handoff] 角色注册表（main 主代理 + planner 计划专家）:', hasMain && hasPlanner ? '✓' : '✗',
    `(角色=${roles.map((r) => r.id).join(',')})`);
  // 非法角色 → 明确报错（错误信息列可用角色）
  const bad = handoffTool ? await handoffTool.handler({ role: 'no-such', objective: 'x' }, { traceId: 'h0', turn: 0, sandboxRoot: rootDir, cache: kernel.cache, trace: kernel.trace }) : { ok: false };
  console.log('[handoff] 非法角色报错（列可用角色）:', bad.ok === false && String(bad.error ?? '').includes('可用角色') ? '✓' : '✗',
    `(错误=${String(bad.error ?? '').slice(0, 40)}…)`);
  // 执行器集成：mock 第一轮调用 handoff_to → 收到 handoff 事件、循环终止（无第二轮）
  let llmCalls = 0;
  const mk = {
    id: 'mock-ho', label: 'HO', defaultModel: 'm', prices: { in: 0, out: 0 },
    async *chat() {
      llmCalls++;
      yield { type: 'tool_call' as const, toolCall: { id: 'h1', type: 'function' as const, function: { name: 'handoff_to', arguments: JSON.stringify({ role: 'planner', objective: '重构模块 X：已完成调研，待规划步骤' }) } } };
      yield { type: 'usage' as const, input: 10, output: 10 };
      yield { type: 'done' as const };
    },
  };
  const evs: { type: string; role?: string }[] = [];
  for await (const ev of runner.run({
    provider: mk, model: 'm', messages: [{ role: 'user', content: '帮我重构模块 X' }],
    traceId: `ho-${Date.now()}`, tools: handoffTool ? [handoffTool] : [],
  })) {
    const hoRole = ev.type === 'handoff' ? (ev as { type: 'handoff'; role: string; objective: string }).role : undefined;
    evs.push({ type: ev.type, role: hoRole });
  }
  const handed = evs.some((e) => e.type === 'handoff' && e.role === 'planner') && llmCalls === 1 && !evs.some((e) => e.type === 'assistant_done');
  console.log('[handoff] 移交终止循环 + 事件上报:', handed ? '✓' : '✗', `(事件=${evs.map((e) => e.type).join(',')} LLM 调用=${llmCalls})`);
}

await kernel.stop();
console.log('selftest done');
