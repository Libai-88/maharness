import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dirDigest } from './plugin-snapshot';
import { verifyLockFile, type LockSignature } from './lock-signature';
import type { PluginManifest } from './types';

export interface PluginLockEntry {
  version: string;
  integrity: string;
  compatibility?: PluginManifest['compatibility'];
  permissions?: PluginManifest['permissions'];
  execution?: PluginManifest['execution'];
  source?: string;
  updatedAt?: number;
}

export interface PluginLockFile {
  version: 1;
  plugins: Record<string, PluginLockEntry>;
  signature?: LockSignature;
}

export interface PluginLockValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function parseSemver(raw: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(String(raw ?? '').trim());
}

export function buildPluginLockEntry(pluginDir: string, manifest: PluginManifest, source?: string): PluginLockEntry {
  return {
    version: manifest.version,
    integrity: dirDigest(pluginDir),
    ...(manifest.compatibility ? { compatibility: manifest.compatibility } : {}),
    ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
    ...(manifest.execution ? { execution: manifest.execution } : {}),
    ...(source ? { source } : {}),
    updatedAt: Date.now(),
  };
}

export function verifyPluginLock(entry: PluginLockEntry | undefined, pluginDir: string, manifest: PluginManifest): PluginLockValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!entry) return { ok: false, errors: [`插件 ${manifest.id} 未登记在 plugins-lock.json`], warnings };
  if (entry.version !== manifest.version) errors.push(`版本不一致：锁 ${entry.version} / 当前 ${manifest.version}`);
  const actual = dirDigest(pluginDir);
  if (!entry.integrity || !/^[0-9a-f]{10}$/.test(entry.integrity)) {
    errors.push(`integrity 非法（须 10 位 sha256hex）: ${entry.integrity || '空'}`);
  } else if (entry.integrity !== actual) {
    errors.push(`源码完整性不一致：锁 ${entry.integrity.slice(0, 8)}… / 当前 ${actual.slice(0, 8)}…`);
  }
  if (JSON.stringify(entry.compatibility ?? null) !== JSON.stringify(manifest.compatibility ?? null)) {
    errors.push('compatibility 与锁文件不一致');
  }
  if (JSON.stringify(entry.permissions ?? null) !== JSON.stringify(manifest.permissions ?? null)) {
    errors.push('permissions 与锁文件不一致');
  }
  if (JSON.stringify(entry.execution ?? null) !== JSON.stringify(manifest.execution ?? null)) {
    errors.push('execution 与锁文件不一致');
  }
  if (!actual) warnings.push('插件没有可摘要的源码文件');
  return { ok: errors.length === 0, errors, warnings };
}

export function validatePluginLock(lock: PluginLockFile, opts: { publicKey?: string } = {}): PluginLockValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (lock.version !== 1) errors.push(`不支持的 plugins-lock version: ${String(lock.version)}`);
  for (const [id, entry] of Object.entries(lock.plugins ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) errors.push(`插件 id 非法: ${id}`);
    if (!parseSemver(entry.version)) errors.push(`${id}: version 非法: ${entry.version}`);
    if (!/^[0-9a-f]{10}$/.test(entry.integrity ?? '')) errors.push(`${id}: integrity 必须是 10 位 sha256hex`);
    if (entry.updatedAt !== undefined && (!Number.isSafeInteger(entry.updatedAt) || entry.updatedAt <= 0)) {
      errors.push(`${id}: updatedAt 非法`);
    }
  }
  if (!Object.keys(lock.plugins ?? {}).length) warnings.push('锁文件没有任何插件');
  if (lock.signature) {
    const publicKey = opts.publicKey ?? process.env.MAHARNESS_PLUGIN_LOCK_PUBLIC_KEY;
    if (!publicKey) errors.push('plugins-lock.json 已签名但未配置 MAHARNESS_PLUGIN_LOCK_PUBLIC_KEY');
    else {
      const result = verifyLockFile(lock as unknown as Record<string, unknown>, publicKey);
      if (!result.ok) errors.push(`插件锁签名校验失败: ${result.reason}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function readPluginLock(rootDir: string): { file: string | null; data: PluginLockFile | null; error?: string } {
  const candidates = [join(rootDir, 'plugins-lock.json'), join(dirname(rootDir), 'plugins-lock.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as PluginLockFile;
      if (!data || data.version !== 1 || !data.plugins || typeof data.plugins !== 'object') {
        return { file, data: null, error: '锁文件缺少 version:1 或 plugins 对象' };
      }
      return { file, data };
    } catch (err) {
      return { file, data: null, error: `锁文件解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { file: null, data: null };
}

export function writePluginLock(rootDir: string, lock: PluginLockFile, opts: { publicKey?: string } = {}): string {
  const validation = validatePluginLock(lock, opts);
  if (!validation.ok) throw new Error(validation.errors.join('；'));
  const file = join(rootDir, 'plugins-lock.json');
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

export function pluginLockEntryOf(lock: PluginLockFile, id: string): PluginLockEntry | undefined {
  return lock.plugins[id];
}
