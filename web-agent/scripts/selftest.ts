/**
 * scripts/selftest.ts —— 工具冒烟测试（不依赖 LLM）
 * 用法：npm run selftest
 *   SEARCH_PROXY=http://127.0.0.1:7897 npm run selftest  —— 走代理测联网搜索
 *   TAVILY_API_KEY=xxx npm run selftest                  —— 走 Tavily 测搜索
 */
import { Kernel } from '../kernel';

const kernel = new Kernel(process.cwd());
await kernel.start();

const tools = kernel.plugins.capabilities('tool').map((c) => c.tool);
console.log('[tools]', tools.map((t) => t.name).sort().join(', '));

const tctx = (turn = 0) => ({
  traceId: `selftest-${Date.now()}`,
  turn,
  sandboxRoot: process.cwd(),
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

await kernel.stop();
console.log('selftest done');
