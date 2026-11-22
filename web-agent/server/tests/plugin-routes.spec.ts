/**
 * server/tests/plugin-routes.spec.ts —— P1-3 定点补测：插件管理路由
 *
 * 质量审查指出 `server/routes/plugins.ts` 行覆盖仅 32.6%。这里不启真实内核，
 * 用最小假 kernel 挂载真实 express 路由，逐条走：能力发现、工具目录、导航、
 * 前端模块静态托管（含目录穿越拒绝）、插件列表（错误修复建议）、诊断、
 * 启停/重载/卸载、配置读取，以及 404/400 分支。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

import { registerPluginRoutes } from '../routes/plugins';
import type { RouteDeps } from '../routes/shared';

const dir = mkdtempSync(join(tmpdir(), 'plugin-routes-'));
mkdirSync(join(dir, 'ui'), { recursive: true });
writeFileSync(join(dir, 'ui', 'page.js'), 'export const ok = true;\n');

const states = { alpha: 'running' as string };

const instance = () => ({
  manifest: { id: 'alpha', name: 'Alpha', version: '1.0.0', config: { mode: 'string' }, essential: false, execution: 'in-process' },
  state: states.alpha,
  dir,
  caps: [{ kind: 'tool' }, { kind: 'api' }],
  circuitBreaker: undefined,
  watched: true,
});

const kernel = {
  plugins: {
    capabilities: (kind: string) =>
      kind === 'tool'
        ? [{ tool: { name: 'zeta', risk: 'high', description: 'z' } }, { tool: { name: 'alpha', description: 'a' } }]
        : kind === 'context'
          ? [{ context: { id: 'ctx', weight: 2, description: 'c' } }]
          : [{ persona: { id: 'p', name: 'P', priority: 1 } }],
    toolCatalog: () => [{ pluginId: 'alpha', tool: { name: 'zeta', risk: 'high', approval: true, description: 'z' } }],
    navContributions: () => [
      { pluginId: 'alpha', name: 'Alpha', mount: 'ui', nav: { label: '面板', mode: 'panel' }, moduleUrl: 'm.js' },
      { pluginId: 'alpha', name: 'Alpha', mount: 'ui', nav: { label: '页', mode: 'iframe', page: '/page' }, moduleUrl: 'm.js' },
    ],
    get: (id: string) => (id === 'alpha' ? instance() : undefined),
    list: () => [
      {
        manifest: { id: 'alpha', name: 'Alpha', version: '1.0.0', essential: false, execution: 'in-process' },
        state: 'running',
        watched: true,
      },
      { manifest: { id: 'beta', name: 'Beta', version: '1.0.0' }, state: 'failed', error: '缺少依赖: gamma' },
    ],
    diagnostics: () => [{ pluginId: 'beta', level: 'error', message: 'boom' }],
    enable: async (id: string) => {
      if (id === 'boom') throw new Error('启用失败');
      states.alpha = 'running';
    },
    disable: async () => {
      states.alpha = 'disabled';
    },
    reload: async () => {
      states.alpha = 'running';
    },
    uninstall: async () => {
      states.alpha = 'uninstalled';
    },
  },
  config: { section: (id: string) => ({ mode: id === 'alpha' ? 'fast' : undefined }) },
};

let server: Server;
let base = '';

before(async () => {
  const app = express();
  app.use(express.json());
  registerPluginRoutes(app, { kernel } as unknown as RouteDeps);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
};

test('能力发现按风险分组且工具名有序', async () => {
  const res = await get('/api/capabilities');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(
    data.tools.map((tool: { name: string }) => tool.name),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(data.byRisk.high, ['zeta']);
  assert.equal(data.contexts[0].id, 'ctx');
  assert.equal(data.personas[0].priority, 1);
});

test('工具目录带出域与默认值', async () => {
  const res = await get('/api/tools');
  const data = JSON.parse(res.body);
  assert.equal(data[0].pluginId, 'alpha');
  assert.equal(data[0].contentTrust, 'trusted');
  assert.equal(typeof data[0].domain, 'string');
});

test('导航贡献分 panel / iframe 两种 URL', async () => {
  const res = await get('/api/nav');
  const items = JSON.parse(res.body).items;
  assert.equal(items.length, 2);
  assert.ok(items[0].url.endsWith('/panel'));
  assert.ok(items[1].url.endsWith('/page'));
  assert.equal(items[0].statusUrl, null);
});

test('前端模块静态托管：正常返回、穿越与非法扩展名一律 404', async () => {
  const ok = await get('/api/plugins/alpha/ui/page.js');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /ok = true/);
  assert.equal((await get('/api/plugins/alpha/ui/../secret.js')).status, 404);
  assert.equal((await get('/api/plugins/alpha/ui/page.exe')).status, 404);
  assert.equal((await get('/api/plugins/nope/ui/page.js')).status, 404);
});

test('插件列表把错误映射成修复建议', async () => {
  const res = await get('/api/plugins');
  const data = JSON.parse(res.body);
  assert.equal(data.length, 2);
  assert.equal(data[0].state, 'running');
  assert.deepEqual(data[0].caps, ['tool', 'api']);
  assert.match(data[1].fixSuggestion, /请先安装并启用依赖插件「gamma」/);
});

test('诊断直接透出内核诊断列表', async () => {
  const data = JSON.parse((await get('/api/plugins/diagnostics')).body);
  assert.equal(data[0].message, 'boom');
});

test('启停/重载/卸载与未知动作、异常分支', async () => {
  assert.equal((await post('/api/plugins/alpha/actions', { action: 'disable' })).status, 200);
  assert.equal(JSON.parse((await post('/api/plugins/alpha/actions', { action: 'reload' })).body).state, 'running');
  assert.equal(JSON.parse((await post('/api/plugins/alpha/actions', { action: 'uninstall' })).body).state, 'uninstalled');
  const unknown = await post('/api/plugins/alpha/actions', { action: 'explode' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body, /未知操作/);
  assert.equal((await post('/api/plugins/boom/actions', { action: 'enable' })).status, 400);
});

test('配置读取：存在与不存在两条路径', async () => {
  const found = JSON.parse((await get('/api/plugins/alpha/config')).body);
  assert.deepEqual(found.config, { mode: 'fast' });
  assert.equal((await get('/api/plugins/nope/config')).status, 404);
});

test('打开源码目录：插件不存在时 404', async () => {
  const res = await post('/api/plugins/nope/open');
  assert.equal(res.status, 404);
});
