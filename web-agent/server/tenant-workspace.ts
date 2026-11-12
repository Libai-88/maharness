/** 租户工作区解析：default 保持全局沙箱，其他租户落在独立子目录。
 *  这是文件系统级逻辑分区，不是 OS 账户/容器边界；不可信租户仍不应共享进程。 */
import { existsSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

export function tenantSandboxPath(base: string, tenantId: string): string {
  const id = String(tenantId ?? '').trim();
  if (!id || id === 'default') return base;
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(base, '.tenants', safe);
}

export function tenantSandboxRoot(base: string, tenantId: string): string {
  const root = tenantSandboxPath(base, tenantId);
  if (root === base) return root;
  mkdirSync(root, { recursive: true });
  return root;
}

export interface StorageUsage {
  bytes: number;
  files: number;
  complete: boolean;
}

/** 目录用量：不跟随符号链接；达到文件数/时间预算时标记 incomplete。 */
export function measureStorage(root: string, opts: { maxFiles?: number; deadlineMs?: number; exclude?: string[] } = {}): StorageUsage {
  const maxFiles = opts.maxFiles ?? 200_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 2_000);
  const exclude = new Set((opts.exclude ?? []).map((path) => process.platform === 'win32' ? path.toLowerCase() : path));
  let bytes = 0;
  let files = 0;
  let complete = true;
  const walk = (dir: string): void => {
    if (!complete) return;
    if (Date.now() > deadline || files > maxFiles) { complete = false; return; }
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!complete) return;
      if (files > maxFiles || Date.now() > deadline) { complete = false; return; }
      const full = join(dir, entry.name);
      if (exclude.has(process.platform === 'win32' ? full.toLowerCase() : full)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      files++;
      try { bytes += statSync(full).size; } catch { /* 文件在遍历中消失：跳过 */ }
    }
  };
  if (existsSync(root)) walk(root);
  return { bytes, files, complete };
}

export class TenantStorageQuotaError extends Error {
  readonly code = 'TENANT_STORAGE_QUOTA' as const;
  readonly status = 413;
  constructor(readonly used: number, readonly limit: number, readonly additional: number) {
    super(`租户存储配额超限：已用 ${used} 字节，本次需要 ${additional} 字节，上限 ${limit} 字节`);
    this.name = 'TenantStorageQuotaError';
  }
}

export function assertStorageQuota(input: {
  usedBytes: number; limitBytes: number; additionalBytes: number;
}): void {
  if (!input.limitBytes || input.limitBytes <= 0) return;
  if (input.additionalBytes <= 0) return;
  if (input.usedBytes + input.additionalBytes > input.limitBytes) {
    throw new TenantStorageQuotaError(input.usedBytes, input.limitBytes, input.additionalBytes);
  }
}
