import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import type { PluginManifest } from '../kernel/types';
import {
  buildPluginLockEntry,
  pluginLockEntryOf,
  readPluginLock,
  validatePluginLock,
  verifyPluginLock,
  writePluginLock,
  type PluginLockEntry,
} from '../kernel/plugin-lock';
import { signLockFile } from '../kernel/lock-signature';

const root = process.cwd();
const pluginsDir = join(root, 'plugins');
const command = process.argv[2] ?? 'generate';

function manifests(): { dir: string; manifest: PluginManifest }[] {
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/@[0-9a-f]{10}$/.test(entry.name))
    .flatMap((entry) => {
      const dir = join(pluginsDir, entry.name);
      const file = join(dir, 'plugin.json');
      if (!existsSync(file)) return [];
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as PluginManifest;
        return manifest.id ? [{ dir, manifest }] : [];
      } catch {
        return [];
      }
    });
}

if (command === 'generate') {
  const entries: Record<string, PluginLockEntry> = {};
  for (const { dir, manifest } of manifests()) entries[manifest.id] = buildPluginLockEntry(dir, manifest);
  const file = writePluginLock(root, { version: 1, plugins: entries });
  console.log(`已写入 ${file}（${Object.keys(entries).length} 个插件）`);
} else if (command === 'verify') {
  const lock = readPluginLock(root);
  if (lock.error) {
    console.error(lock.error);
    process.exit(1);
  }
  if (!lock.data) {
    console.error('未找到 plugins-lock.json');
    process.exit(1);
  }
  const lockValidation = validatePluginLock(lock.data);
  if (!lockValidation.ok) {
    console.error(lockValidation.errors.join('；'));
    process.exit(1);
  }
  let failed = 0;
  for (const { dir, manifest } of manifests()) {
    const result = verifyPluginLock(pluginLockEntryOf(lock.data, manifest.id), dir, manifest);
    if (!result.ok) {
      failed++;
      console.error(`${manifest.id}: ${result.errors.join('；')}`);
    } else {
      console.log(`${manifest.id}: ok`);
    }
  }
  if (failed) process.exit(1);
} else if (command === 'sign') {
  const privateKey = process.env.MAHARNESS_LOCK_SIGNING_KEY;
  if (!privateKey) {
    console.error('缺少 MAHARNESS_LOCK_SIGNING_KEY（Ed25519 PKCS#8 PEM）');
    process.exit(2);
  }
  const lock = readPluginLock(root);
  if (lock.error) {
    console.error(lock.error);
    process.exit(1);
  }
  if (!lock.data) {
    console.error('未找到 plugins-lock.json');
    process.exit(1);
  }
  const signed = signLockFile(lock.data as unknown as Record<string, unknown>, privateKey, {
    keyId: process.env.MAHARNESS_LOCK_KEY_ID,
  }) as { version: 1; plugins: Record<string, PluginLockEntry>; signature: import('../kernel/lock-signature').LockSignature };
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const file = writePluginLock(root, signed, { publicKey });
  console.log(`已签名 ${file}（keyId=${process.env.MAHARNESS_LOCK_KEY_ID ?? '未命名'}）`);
} else {
  console.error('用法: tsx scripts/plugin-lock.ts generate|verify|sign');
  process.exit(2);
}
