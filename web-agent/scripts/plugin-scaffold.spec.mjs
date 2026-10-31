import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlugin, validatePlugin } from './plugin-scaffold.mjs';
import { Kernel } from '../kernel/index.ts';

const WEB_AGENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('plugin scaffold manifest validator', () => {
  test('accepts the generated plugin shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plugin-scaffold-'));
    try {
      mkdirSync(join(root, 'demo'), { recursive: true });
      writeFileSync(join(root, 'demo', 'plugin.json'), JSON.stringify({
        id: 'demo', name: 'demo', version: '0.1.0', entry: 'index.ts',
        compatibility: { api: { min: '1.0.0', max: '1.0.0' } },
        permissions: { capabilities: { tool: ['demo_hello'] } },
      }));
      writeFileSync(join(root, 'demo', 'index.ts'), 'export default {};');
      assert.deepEqual(validatePlugin(join(root, 'demo')), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects incompatible API and path traversal entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plugin-scaffold-'));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', entry: '../index.ts', compatibility: { api: { min: '2.0.0' } } }));
      assert.deepEqual(validatePlugin(root), ['entry 必须是插件目录内的相对路径', '不兼容宿主插件 API 1.0.0']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('generated plugin loads through the real Kernel plugin loader', async () => {
    const id = `scaffold-${process.pid}-${Date.now().toString(36)}`;
    const pluginsDir = join(WEB_AGENT_ROOT, `.plugin-scaffold-fixtures-${process.pid}-${Date.now().toString(36)}`);
    const pluginDir = join(pluginsDir, id);
    const coreDir = mkdtempSync(join(tmpdir(), 'mh-plugin-scaffold-core-'));
    const kernel = new Kernel(WEB_AGENT_ROOT, {}, { userPluginsDir: pluginsDir, corePluginsDir: coreDir });
    try {
      assert.equal(validatePlugin(createPlugin(id, pluginsDir)).length, 0);
      await kernel.plugins.loadAll();
      assert.equal(kernel.plugins.get(id)?.state, 'started');
      assert.ok(kernel.plugins.capabilities('tool').some(({ tool }) => tool.name === `${id}_hello`));
      await kernel.plugins.uninstall(id);
      assert.equal(kernel.plugins.get(id), undefined);
      assert.equal(existsSync(pluginDir), false);
    } finally {
      await kernel.stop();
      for (const name of readdirSync(pluginsDir)) {
        if (name === id || name.startsWith(`${id}@`)) rmSync(join(pluginsDir, name), { recursive: true, force: true });
      }
      rmSync(pluginsDir, { recursive: true, force: true });
      rmSync(coreDir, { recursive: true, force: true });
    }
  });
});
