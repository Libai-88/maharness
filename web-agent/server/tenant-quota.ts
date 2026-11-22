/** 租户存储配额：按租户根统计用量并缓存 3 秒；写入前预检，避免每次写都全量递归。 */
import { join } from 'node:path';
import { assertStorageQuota, measureStorage, tenantSandboxPath, TenantStorageQuotaError } from './tenant-workspace';

const CACHE_TTL_MS = 3_000;
const cache = new Map<string, { bytes: number; at: number; root: string }>();

export function tenantStorageBytes(base: string, tenantId: string): number {
  const root = tenantSandboxPath(base, tenantId);
  const key = `${base}\0${tenantId}`;
  const hit = cache.get(key);
  if (hit && hit.root === root && Date.now() - hit.at < CACHE_TTL_MS) return hit.bytes;
  const usage = measureStorage(root, {
    maxFiles: 200_000,
    deadlineMs: 2_000,
    exclude: tenantId === 'default' ? [join(root, '.tenants')] : [],
  });
  cache.set(key, { bytes: usage.bytes, at: Date.now(), root });
  return usage.bytes;
}

export function invalidateTenantStorage(tenantId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.endsWith(`\0${tenantId}`)) cache.delete(key);
  }
}

export function assertTenantStorage(input: { base: string; tenantId: string; limitBytes: number; additionalBytes: number }): void {
  if (!input.limitBytes || input.limitBytes <= 0 || input.additionalBytes <= 0) return;
  const used = tenantStorageBytes(input.base, input.tenantId);
  assertStorageQuota({ usedBytes: used, limitBytes: input.limitBytes, additionalBytes: input.additionalBytes });
}

export { TenantStorageQuotaError };
