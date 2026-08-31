/**
 * server/secrets.ts —— API key 加密存储（AES-256-GCM）
 * 现状问题：providers.api_key 明文落 SQLite，备份/文件读取即泄露凭据。
 * 方案：数据目录下 secret.key（首启生成 32 字节随机，尽力 0600）作主密钥；
 * 存储格式 `v1:<iv>:<tag>:<ct>`（Base64），密文外置 IV/TAG，非对称不可推导。
 * 密钥文件丢失 = 已存 key 不可解密（本机个人服务可接受的取舍）。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_PREFIX = 'v1:';
const KEY_FILE = 'secret.key';

/** 读取或创建主密钥（32 字节）。文件权限尽力收紧（Windows 上 chmod 语义有限）。 */
export function loadOrCreateSecretKey(dataDir: string): Buffer {
  const path = join(dataDir, KEY_FILE);
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8').trim();
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === 32) return buf;
      console.warn('[secret] secret.key 长度异常（期望 32 字节 hex），重新生成——旧密钥将无法解密');
    }
  } catch (err) {
    console.warn('[secret] 读取 secret.key 失败，重新生成:', err instanceof Error ? err.message : String(err));
  }
  const key = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, key.toString('hex'), { encoding: 'utf-8', flag: 'w' });
    try { chmodSync(path, 0o600); } catch { /* Windows 权限位不生效时忽略 */ }
  } catch (err) {
    console.warn('[secret] 写入 secret.key 失败（凭据将明文兜底）:', err instanceof Error ? err.message : String(err));
  }
  return key;
}

/** 加密：`v1:base64(iv):base64(tag):base64(ct)` */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** 解密；格式非法/密钥不符（GCM auth 失败）时抛错 */
export function decryptSecret(blob: string, key: Buffer): string {
  if (!blob.startsWith(SECRET_PREFIX)) return blob;
  const parts = blob.slice(SECRET_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('凭据密文格式非法');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 从任意来源（env 变量等）生成确定密钥：仅用于无 secret.key 场景的兜底散列 */
export function deriveKeyFrom(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

export function isEncrypted(blob: string): boolean {
  return blob.startsWith(SECRET_PREFIX);
}