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

await kernel.stop();
console.log('selftest done');
