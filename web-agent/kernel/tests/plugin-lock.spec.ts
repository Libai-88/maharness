import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPluginLockEntry, pluginLockEntryOf, readPluginLock, validatePluginLock, verifyPluginLock, writePluginLock,
} from '../plugin-lock';
import type { PluginManifest } from '../types';

const manifest: PluginManifest = { apiVersion: 2,
  id: 'demo', name: 'Demo', version: '1.0.0', entry: 'index.ts',
  compatibility: { api: { min: '1.0.0', max: '1.0.0' } },
  permissions: { capabilities: { tool: ['demo'] } },
};

describe('插件锁文件', () => {
  test('生成、原子写入、读取并通过完整性校验', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plugin-lock-'));
    const dir = join(root, 'plugins', 'demo');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.ts'), 'export default { id: "demo" };\n');
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
      const entry = buildPluginLockEntry(dir, manifest, 'local');
      const file = writePluginLock(root, { version: 1, plugins: { demo: entry } });
      assert.match(file, /plugins-lock\.json$/);
      const read = readPluginLock(root);
      assert.equal(read.error, undefined);
      assert.deepEqual(pluginLockEntryOf(read.data!, 'demo')?.version, '1.0.0');
      assert.equal(verifyPluginLock(entry, dir, manifest).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('源码、版本、权限或兼容范围变化会拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plugin-lock-'));
    const dir = join(root, 'demo');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.ts'), 'export default 1;\n');
      const entry = buildPluginLockEntry(dir, manifest);
      writeFileSync(join(dir, 'index.ts'), 'export default 2;\n');
      assert.match(verifyPluginLock(entry, dir, manifest).errors.join('; '), /完整性不一致/);
      assert.match(verifyPluginLock(entry, dir, { ...manifest, version: '1.1.0' }).errors.join('; '), /版本不一致/);
      assert.match(verifyPluginLock(entry, dir, { ...manifest, permissions: { capabilities: { tool: ['other'] } } }).errors.join('; '), /permissions/);

      const isolated = { ...manifest, execution: { mode: 'process' as const, memoryMb: 128 } };
      const isolatedEntry = buildPluginLockEntry(dir, isolated);
      assert.equal(verifyPluginLock(isolatedEntry, dir, isolated).ok, true);
      assert.match(verifyPluginLock(isolatedEntry, dir, manifest).errors.join('; '), /execution/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('非法锁文件形状被拒绝', () => {
    const result = validatePluginLock({
      version: 1,
      plugins: { Bad: { version: 'x', integrity: 'nope' } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('id 非法')));
    assert.ok(result.errors.some((error) => error.includes('version 非法')));
    assert.ok(result.errors.some((error) => error.includes('integrity')));
  });
});
