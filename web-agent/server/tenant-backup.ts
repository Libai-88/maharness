/** 租户工作区备份/恢复：用于迁移前快照与失败回滚；不依赖容器或多实例。 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tenantSandboxPath } from './tenant-workspace';

export interface TenantBackupManifest {
  version: 1;
  tenantId: string;
  base: string;
  source: string;
  createdAt: number;
  bytes: number;
  files: number;
}

function safeTenantId(id: string): string {
  return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
}

function usage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      files++;
      try { bytes += statSync(full).size; } catch { /* 文件在遍历中消失 */ }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { bytes, files };
}

export function backupTenantWorkspace(opts: {
  base: string;
  dataDir: string;
  tenantId: string;
  now?: number;
}): { dir: string; manifest: TenantBackupManifest } {
  const source = tenantSandboxPath(opts.base, opts.tenantId);
  if (!existsSync(source)) throw new Error(`租户工作区不存在: ${source}`);
  const createdAt = opts.now ?? Date.now();
  const dir = join(opts.dataDir, 'tenant-backups', `${safeTenantId(opts.tenantId)}-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}`);
  if (existsSync(dir)) throw new Error(`备份目录已存在: ${dir}`);
  mkdirSync(dir, { recursive: true });
  cpSync(source, join(dir, 'workspace'), { recursive: true, errorOnExist: false });
  const stats = usage(join(dir, 'workspace'));
  const manifest: TenantBackupManifest = {
    version: 1, tenantId: opts.tenantId, base: opts.base, source,
    createdAt, bytes: stats.bytes, files: stats.files,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifest };
}

export function listTenantBackups(dataDir: string): TenantBackupManifest[] {
  const root = join(dataDir, 'tenant-backups');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const manifest = JSON.parse(readFileSync(join(root, entry.name, 'manifest.json'), 'utf8')) as TenantBackupManifest;
        return manifest?.version === 1 ? [manifest] : [];
      } catch { return []; }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function restoreTenantWorkspace(opts: {
  base: string;
  dataDir: string;
  backupDir: string;
  tenantId?: string;
  now?: number;
}): { target: string; previous?: string } {
  const manifestPath = join(opts.backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`备份清单不存在: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TenantBackupManifest;
  const tenantId = opts.tenantId ?? manifest.tenantId;
  const source = join(opts.backupDir, 'workspace');
  if (!existsSync(source)) throw new Error(`备份工作区不存在: ${source}`);
  const target = tenantSandboxPath(opts.base, tenantId);
  const stamp = (opts.now ?? Date.now()).toString(36);
  const previous = existsSync(target) ? `${target}.pre-restore-${stamp}` : undefined;
  if (previous) renameSync(target, previous);
  try {
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true, errorOnExist: false });
    return { target, ...(previous ? { previous } : {}) };
  } catch (error) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* 清理失败保留现场 */ }
    if (previous) {
      try { renameSync(previous, target); } catch { /* 回滚失败保留 previous 供人工处理 */ }
    }
    throw error;
  }
}
