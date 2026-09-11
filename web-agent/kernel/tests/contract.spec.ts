/**
 * kernel/tests/contract.spec.ts —— 可逆性契约守卫
 *
 * 「卸载 = 完全恢复」由 EffectScope 结构性保证，前提是所有订阅都经 ctx.on 登记逆元。
 * 插件上下文仍会透出内核总线对象，本测试守住两条底线：
 *   1. 源码层：core/ 与 plugins/ 不得出现 ctx.bus 的订阅接口（on / once / onPhase）；
 *   2. 运行时：插件拿到的门面上确实不存在 on —— 类型层被绕过时也不留后门。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Kernel } from '../index';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FORBIDDEN = /ctx\.bus\.(?:on|once|onPhase)\s*\(/;
const SKIP_DIR = new Set(['node_modules', 'dist']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name) || /@[0-9a-f]{10}$/.test(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('契约：可逆性旁路', () => {
  test('core/ 与 plugins/ 源码不得直接使用 ctx.bus 的订阅接口', () => {
    const offenders: string[] = [];
    for (const root of ['core', 'plugins']) {
      for (const file of sourceFiles(join(ROOT, root))) {
        if (FORBIDDEN.test(readFileSync(file, 'utf-8'))) offenders.push(file.slice(ROOT.length));
      }
    }
    assert.deepEqual(offenders, [], `以下文件绕过 EffectScope 订阅事件，请改用 ctx.on：${offenders.join('、')}`);
  });

  test('插件上下文的总线门面不提供订阅能力（on 不可见）', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mh-contract-'));
    const pluginsDir = join(rootDir, 'plugins');
    const coreDir = join(rootDir, 'core-empty');
    const dir = join(pluginsDir, 'tmp-facade');
    mkdirSync(dir, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'tmp-facade', name: '门面探针', version: '0.1.0', entry: 'index.ts' }));
    writeFileSync(join(dir, 'index.ts'), `
export default {
  id: 'tmp-facade', name: '门面探针', version: '0.1.0',
  onLoad(ctx) {
    globalThis.__mhFacade = {
      hasOn: typeof ctx.bus.on === 'function',
      hasEmit: typeof ctx.bus.emit === 'function',
      hasOnCtx: typeof ctx.on === 'function',
      keys: Object.keys(ctx.bus).sort(),
    };
  },
};
`);
    const kernel = new Kernel(rootDir, {}, { dataDir: join(rootDir, 'data'), userPluginsDir: pluginsDir, corePluginsDir: coreDir });
    await kernel.plugins.loadAll();
    const facade = (globalThis as unknown as { __mhFacade?: { hasOn: boolean; hasEmit: boolean; hasOnCtx: boolean; keys: string[] } }).__mhFacade;
    assert.ok(facade, '插件应已加载并记录门面信息');
    assert.equal(facade.hasOn, false, '总线门面不得暴露 on');
    assert.equal(facade.hasEmit, true, '发射能力应保留');
    assert.equal(facade.hasOnCtx, true, 'ctx.on 仍是唯一订阅入口');
    assert.deepEqual(facade.keys, ['bail', 'emit', 'emitAsync', 'parallel', 'serial', 'waterfall']);
    await kernel.stop();
    rmSync(rootDir, { recursive: true, force: true });
  });
});
