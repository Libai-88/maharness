import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { tenantSandboxRoot } from '../tenant-workspace';

describe('租户工作区解析', () => {
  test('default 使用全局沙箱，其他租户落到独立子目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'mh-tenant-workspace-'));
    try {
      assert.equal(tenantSandboxRoot(base, 'default'), base);
      assert.equal(tenantSandboxRoot(base, ''), base);
      const a = tenantSandboxRoot(base, 'tenant-a');
      assert.equal(a, join(base, '.tenants', 'tenant-a'));
      assert.ok(existsSync(a));
      assert.equal(relative(base, a).startsWith('..'), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('非法字符被收敛，不能越出租户根', () => {
    const base = mkdtempSync(join(tmpdir(), 'mh-tenant-workspace-'));
    try {
      const root = tenantSandboxRoot(base, '../../evil');
      assert.equal(root, join(base, '.tenants', '______evil'));
      assert.equal(relative(base, root).startsWith('..'), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
