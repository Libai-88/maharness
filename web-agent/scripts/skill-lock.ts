import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signLockFile, verifyLockFile } from '../kernel/lock-signature';
import { validateLockFile, type LockFile } from '../kernel/skillsSync';

const root = process.cwd();
const command = process.argv[2] ?? 'verify';

function lockPath(): string {
  for (const file of [join(root, 'skills-lock.json'), join(dirname(root), 'skills-lock.json')]) {
    if (existsSync(file)) return file;
  }
  throw new Error('未找到 skills-lock.json');
}

function writeLock(file: string, lock: LockFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8');
  renameSync(tmp, file);
}

if (command === 'sign') {
  const privateKey = process.env.MAHARNESS_LOCK_SIGNING_KEY;
  if (!privateKey) {
    console.error('缺少 MAHARNESS_LOCK_SIGNING_KEY（Ed25519 PKCS#8 PEM）');
    process.exit(2);
  }
  const file = lockPath();
  const lock = JSON.parse(readFileSync(file, 'utf8')) as LockFile;
  const signed = signLockFile(lock as unknown as Record<string, unknown>, privateKey, {
    keyId: process.env.MAHARNESS_LOCK_KEY_ID,
  }) as unknown as LockFile;
  writeLock(file, signed);
  console.log(`已签名 ${file}（keyId=${process.env.MAHARNESS_LOCK_KEY_ID ?? '未命名'}）`);
} else if (command === 'verify') {
  const file = lockPath();
  const lock = JSON.parse(readFileSync(file, 'utf8')) as LockFile;
  const publicKey = process.env.MAHARNESS_SKILL_LOCK_PUBLIC_KEY;
  if (lock.signature) {
    if (!publicKey) {
      console.error('锁文件已签名但未配置 MAHARNESS_SKILL_LOCK_PUBLIC_KEY');
      process.exit(1);
    }
    const result = verifyLockFile(lock as unknown as Record<string, unknown>, publicKey);
    if (!result.ok) {
      console.error(`签名校验失败: ${result.reason}`);
      process.exit(1);
    }
  } else {
    console.warn('skills-lock.json 未签名（仅哈希校验）');
  }
  const validation = validateLockFile(lock, publicKey ? { publicKey } : {});
  if (!validation.ok) {
    console.error(validation.errors.join('；'));
    process.exit(1);
  }
  console.log(`${file}: ok${lock.signature ? '（已签名）' : '（未签名）'}`);
} else {
  console.error('用法: tsx scripts/skill-lock.ts sign|verify');
  process.exit(2);
}
