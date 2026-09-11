/**
 * kernel/tests/nav-contributions.spec.ts —— 声明式前端导航的契约测试
 *
 * 第一性原理：前端不该认识任何插件。插件在 plugin.json 声明 nav 即拥有自己的一页，
 * 内核把这个声明投影成清单，前端遍历清单生成导航——新增插件页面无需改前端。
 * 本测试锁定该通道的语义：
 *   1. 声明了 nav 且已启动的插件出现在清单里，字段完整（含可直接使用的 url）；
 *   2. 未声明 nav 的插件不出现（前端不会为它凭空多出一个页面）；
 *   3. 停用后从清单消失（页面随能力一起下线，不留死标签）；
 *   4. 声明了 nav 但没有 api 能力的插件不出现（声明与数据通道不一致 = 配置错误）；
 *   5. iframe / panel 两种模式的 url 各自按约定拼接。
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../index';

interface Fixture { kernel: Kernel; rootDir: string; userPluginsDir: string; cleanup: () => void }

/** 每个插件：注册一个 api 能力（页面数据通道），是否声明 nav 由 manifests 决定 */
function setup(plugins: Record<string, { nav?: Record<string, unknown>; withApi?: boolean }>): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-nav-'));
  const dataDir = join(rootDir, 'data');
  const userPluginsDir = join(rootDir, 'plugins');
  mkdirSync(userPluginsDir, { recursive: true });
  for (const [id, def] of Object.entries(plugins)) {
    const pdir = join(userPluginsDir, id);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({
      id, name: `插件${id}`, version: '0.1.0', entry: 'index.ts',
      ...(def.nav ? { nav: def.nav } : {}),
    }));
    const apiBody = def.withApi === false ? '' :
      `ctx.register({ kind: 'api', api: { mount: 'ui', router: () => {} } });`;
    writeFileSync(join(pdir, 'index.ts'), `export default {\n  id: '${id}',\n  name: '插件${id}',\n  version: '0.1.0',\n  onLoad: (ctx) => { ${apiBody} },\n}`);
  }
  const kernel = new Kernel(rootDir, {}, { dataDir, userPluginsDir });
  return {
    kernel,
    rootDir,
    userPluginsDir,
    cleanup: () => {
      try { kernel.trace.flush(); } catch { /* 落盘失败不影响清理 */ }
      try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* 句柄迟释放时留待系统清理 */ }
    },
  };
}

after(() => { /* 无全局状态：每个夹具独立临时目录 */ });

describe('插件声明式前端导航（nav 贡献）', () => {
  test('声明 nav 且已启动的插件进入清单，字段完整', async (t) => {
    const f = setup({
      board: { nav: { label: '看板', icon: 'todo', order: 50, mode: 'iframe', page: '/page' } },
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const list = f.kernel.plugins.navContributions();
    assert.equal(list.length, 1);
    assert.equal(list[0].pluginId, 'board');
    assert.equal(list[0].mount, 'ui');
    assert.equal(list[0].nav.label, '看板');
    assert.equal(list[0].nav.mode, 'iframe');
  });

  test('未声明 nav 的插件不进入清单', async (t) => {
    const f = setup({
      board: { nav: { label: '看板', mode: 'iframe' } },
      quiet: {},
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.deepEqual(f.kernel.plugins.navContributions().map((c) => c.pluginId), ['board']);
  });

  test('停用后从清单消失（页面随能力一起下线）', async (t) => {
    const f = setup({ board: { nav: { label: '看板', mode: 'iframe' } } });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.plugins.navContributions().length, 1);

    await f.kernel.plugins.disable('board');
    assert.equal(f.kernel.plugins.navContributions().length, 0, '停用即下线，不留死标签');

    await f.kernel.plugins.enable('board');
    assert.equal(f.kernel.plugins.navContributions().length, 1, '重新启用即回归');
  });

  test('声明 nav 但未注册 api 能力 → 不出现（避免产出死页面）', async (t) => {
    const f = setup({
      broken: { nav: { label: '坏页面', mode: 'iframe' }, withApi: false },
      good: { nav: { label: '好页面', mode: 'iframe' } },
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.deepEqual(f.kernel.plugins.navContributions().map((c) => c.pluginId), ['good']);
  });

  test('两种渲染模式：iframe 用 page、panel 用 panel，缺省各自取默认路径', async (t) => {
    const f = setup({
      a: { nav: { label: 'A', mode: 'iframe' } },
      b: { nav: { label: 'B', mode: 'panel' } },
      c: { nav: { label: 'C', mode: 'iframe', page: '/custom' } },
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const byId = new Map(f.kernel.plugins.navContributions().map((x) => [x.pluginId, x.nav]));
    assert.equal(byId.get('a')?.mode, 'iframe');
    assert.equal(byId.get('a')?.page ?? '/page', '/page', 'iframe 缺省 page=/page');
    assert.equal(byId.get('b')?.mode, 'panel');
    assert.equal(byId.get('b')?.panel ?? '/panel', '/panel', 'panel 缺省 panel=/panel');
    assert.equal(byId.get('c')?.page, '/custom', '显式 page 生效');
  });

  test('module 模式：投影出带内容哈希的 UI 入口 URL，改动即换 URL', async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mh-nav-mod-'));
    const userPluginsDir = join(rootDir, 'plugins');
    const pdir = join(userPluginsDir, 'mod');
    mkdirSync(join(pdir, 'ui'), { recursive: true });
    writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({
      id: 'mod', name: '模块插件', version: '0.1.0', entry: 'index.ts',
      nav: { label: '模块', mode: 'module', module: 'index.js' },
    }));
    writeFileSync(join(pdir, 'index.ts'), `export default { id: 'mod', name: '模块插件', version: '0.1.0',
      onLoad: (ctx) => { ctx.register({ kind: 'api', api: { mount: 'x', router: () => {} } }); } };`);
    writeFileSync(join(pdir, 'ui', 'index.js'), 'export function mount() {}');
    const kernel = new Kernel(rootDir, {}, { dataDir: join(rootDir, 'data'), userPluginsDir });
    t.after(() => { rmSync(rootDir, { recursive: true, force: true }); });
    await kernel.plugins.loadAll();

    const first = kernel.plugins.navContributions().find((c) => c.pluginId === 'mod');
    assert.ok(first, '声明 nav 的插件应进入清单');
    assert.match(String(first!.moduleUrl), /^\/api\/plugins\/mod\/ui\/index\.js\?v=[0-9a-f]{10}$/);

    // UI 内容变化 → 版本变化（浏览器据此重新加载模块，插件不必自己处理缓存失效）
    writeFileSync(join(pdir, 'ui', 'index.js'), 'export function mount() { /* v2 */ }');
    await kernel.plugins.reload('mod');
    const second = kernel.plugins.navContributions().find((c) => c.pluginId === 'mod');
    assert.notEqual(second!.moduleUrl, first!.moduleUrl);
    await kernel.stop();
  });

  test('module 模式：越界路径或入口缺失时不产出 URL（不给出坏链接）', async (t) => {
    const f = setup({
      bad: { nav: { label: 'B', mode: 'module', module: '../../kernel/types.ts' } },
      missing: { nav: { label: 'M', mode: 'module', module: 'absent.js' } },
    });
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const byId = new Map(f.kernel.plugins.navContributions().map((c) => [c.pluginId, c.moduleUrl]));
    assert.equal(byId.get('bad'), null, '路径越界应拒绝');
    assert.equal(byId.get('missing'), null, '入口不存在应拒绝');
  });
});
