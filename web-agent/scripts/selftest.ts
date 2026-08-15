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
  const history = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  await kernel.bus.emitAsync({
    type: 'agent.before_llm',
    data: { traceId: 't', turn: 0, model: 'm', history, systemPrompt: 's', tools: [], scratchpad: {} },
    ts: Date.now(),
  });
  const injected = history.length === 3 && String(history[2].content).includes('长期记忆');
  console.log('[memory] before_llm 注入:', injected ? '✓' : '✗');
  await cleanSelftest();
  const q3 = await recall.handler({ query: 'selftest' }, tctx());
  console.log('[memory] 清理完成:', (q3.data as { count: number }).count === 0 ? '✓' : '✗');
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
