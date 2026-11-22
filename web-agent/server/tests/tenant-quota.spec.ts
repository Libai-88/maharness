import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStorageQuota, measureStorage, TenantStorageQuotaError } from '../tenant-workspace';

describe('租户存储用量与配额', () => {
  test('统计目录字节与文件数，并支持排除子树', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-storage-'));
    try {
      mkdirSync(join(root, 'sub'));
      mkdirSync(join(root, '.tenants'));
      writeFileSync(join(root, 'a.txt'), '12345');
      writeFileSync(join(root, 'sub', 'b.txt'), 'abc');
      writeFileSync(join(root, '.tenants', 'x.txt'), 'should-be-excluded');
      const usage = measureStorage(root);
      assert.equal(usage.files, 3);
      assert.equal(usage.bytes, 5 + 3 + 'should-be-excluded'.length);
      const excluded = measureStorage(root, { exclude: [join(root, '.tenants')] });
      assert.equal(excluded.files, 2);
      assert.equal(excluded.bytes, 8);
      assert.equal(excluded.complete, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('0 表示不限额；超限抛出 413 语义错误', () => {
    assert.doesNotThrow(() => assertStorageQuota({ usedBytes: 999, limitBytes: 0, additionalBytes: 100 }));
    assert.doesNotThrow(() => assertStorageQuota({ usedBytes: 10, limitBytes: 20, additionalBytes: 10 }));
    assert.throws(
      () => assertStorageQuota({ usedBytes: 10, limitBytes: 20, additionalBytes: 11 }),
      (error: unknown) => error instanceof TenantStorageQuotaError && error.status === 413 && error.code === 'TENANT_STORAGE_QUOTA',
    );
  });
});
