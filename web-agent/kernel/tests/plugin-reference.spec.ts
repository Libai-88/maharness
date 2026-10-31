import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../index';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('reference plugin', () => {
  test('loads disabled, then exposes its declared tool when enabled', async () => {
    const pluginsDir = mkdtempSync(join(ROOT, '.plugin-reference-fixtures-'));
    cpSync(join(ROOT, 'plugins', 'reference-hello'), join(pluginsDir, 'reference-hello'), { recursive: true });
    const coreDir = mkdtempSync(join(tmpdir(), 'mh-plugin-reference-core-'));
    const kernel = new Kernel(ROOT, {}, { userPluginsDir: pluginsDir, corePluginsDir: coreDir });
    try {
      await kernel.plugins.loadAll();
      assert.equal(kernel.plugins.get('reference-hello')?.state, 'loaded');
      assert.equal(kernel.plugins.capabilities('tool').some(({ tool }) => tool.name === 'reference_hello'), false);
      await kernel.plugins.enable('reference-hello');
      assert.ok(kernel.plugins.capabilities('tool').some(({ tool }) => tool.name === 'reference_hello'));
      await kernel.plugins.disable('reference-hello');
      assert.equal(kernel.plugins.capabilities('tool').some(({ tool }) => tool.name === 'reference_hello'), false);
    } finally {
      await kernel.stop();
      rmSync(pluginsDir, { recursive: true, force: true });
      rmSync(coreDir, { recursive: true, force: true });
    }
  });
});
