import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFilesystemAllowed } from '../plugin-fs-guard';
import { validateRuntimePermissions } from '../plugin-loader';
import type { PluginManifest } from '../types';

describe('plugin filesystem guard', () => {
  it('storage 只允许插件存储目录写入', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-fsguard-'));
    try {
      const storage = join(root, 'storage');
      const outside = join(root, 'outside');
      mkdirSync(storage);
      mkdirSync(outside);
      const policy = { mode: 'storage' as const, storageDir: storage };
      assert.equal(isFilesystemAllowed(join(storage, 'a.json'), policy, 'write'), true);
      assert.equal(isFilesystemAllowed(join(outside, 'a.txt'), policy, 'write'), false);
      assert.equal(isFilesystemAllowed(join(outside, 'a.txt'), policy, 'read'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('sandbox 允许工作区读写，sandbox 之外仍拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-fsguard-'));
    try {
      const storage = join(root, 'storage');
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      for (const dir of [storage, workspace, outside]) mkdirSync(dir);
      const policy = { mode: 'sandbox' as const, storageDir: storage, sandboxRoot: workspace };
      assert.equal(isFilesystemAllowed(join(workspace, 'src', 'a.ts'), policy, 'write'), true);
      assert.equal(isFilesystemAllowed(join(workspace, 'src', 'a.ts'), policy, 'read'), true);
      assert.equal(isFilesystemAllowed(join(outside, 'a.ts'), policy, 'read'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('readOnlyRoots 只放行读取，不放行写入', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-fsguard-'));
    try {
      const storage = join(root, 'storage');
      const assets = join(root, 'assets');
      for (const dir of [storage, assets]) mkdirSync(dir);
      const policy = { mode: 'none' as const, storageDir: storage, readOnlyRoots: [assets] };
      assert.equal(isFilesystemAllowed(join(assets, 'template.md'), policy, 'read'), true);
      assert.equal(isFilesystemAllowed(join(assets, 'template.md'), policy, 'write'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('非 full 文件系统权限必须使用 process 执行模式', () => {
    const base = {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      entry: 'index.ts',
      permissions: { capabilities: {}, runtime: { filesystem: 'storage' } },
    } as unknown as PluginManifest;
    assert.throws(() => validateRuntimePermissions(base), /execution.mode=process/);
    assert.doesNotThrow(() => validateRuntimePermissions({
      ...base,
      execution: { mode: 'process' },
    } as PluginManifest));
    assert.doesNotThrow(() => validateRuntimePermissions({
      ...base,
      permissions: { capabilities: {}, runtime: { filesystem: 'full' } },
    } as PluginManifest));
  });
});
