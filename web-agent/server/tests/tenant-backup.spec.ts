import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupTenantWorkspace, listTenantBackups, restoreTenantWorkspace } from '../tenant-backup';
import { tenantSandboxPath } from '../tenant-workspace';

describe('租户工作区备份 / 恢复', () => {
  test('备份后可恢复，旧工作区保留为 previous', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-tenant-backup-'));
    const base = join(root, 'workspace');
    const dataDir = join(root, 'data');
    const tenantId = 'team-a';
    try {
      const target = tenantSandboxPath(base, tenantId);
      mkdirSync(join(target, 'src'), { recursive: true });
      writeFileSync(join(target, 'src', 'a.txt'), 'original');
      const backup = backupTenantWorkspace({ base, dataDir, tenantId, now: 1_700_000_000_000 });
      assert.equal(backup.manifest.tenantId, tenantId);
      assert.equal(backup.manifest.files, 1);
      assert.equal(backup.manifest.bytes, 8);
      assert.equal(listTenantBackups(dataDir).length, 1);

      writeFileSync(join(target, 'src', 'a.txt'), 'changed');
      const restored = restoreTenantWorkspace({
        base,
        dataDir,
        backupDir: backup.dir,
        tenantId,
        now: 1_700_000_001_000,
      });
      assert.equal(readFileSync(join(restored.target, 'src', 'a.txt'), 'utf8'), 'original');
      assert.ok(restored.previous && existsSync(restored.previous));
      assert.equal(readFileSync(join(restored.previous, 'src', 'a.txt'), 'utf8'), 'changed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('不存在的租户工作区拒绝备份', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-tenant-backup-'));
    try {
      assert.throws(
        () =>
          backupTenantWorkspace({
            base: join(root, 'workspace'),
            dataDir: join(root, 'data'),
            tenantId: 'missing',
          }),
        /不存在/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
