/**
 * kernel/secret-box.ts —— 用途隔离的凭据加密（v2 信封）
 *
 * v1 用同一把主密钥加密所有凭据；v2 以 HKDF 从主密钥派生 per-purpose 子密钥，
 * 密文携带用途标签。provider / MCP OAuth / 插件凭据因此互相不可解，
 * 单一用途泄露不会扩散到其他用途。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const PURPOSE_SECRET_PREFIX = 'v2:';
const HKDF_SALT = 'maharness-secret-purpose-v1';

export interface SecretBox {
  /** 本次运行是否有可用主密钥；false 时加密返回明文（兼容测试/无密钥环境） */
  available(): boolean;
  encrypt(plain: string, purpose: string): string;
  decrypt(blob: string, purpose: string): string;
}

export interface MutableSecretBox extends SecretBox {
  configure(key?: Buffer): void;
}

export function derivePurposeKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, purpose, 32));
}

export function isPurposeEncrypted(blob: string): boolean {
  return typeof blob === 'string' && blob.startsWith(PURPOSE_SECRET_PREFIX);
}

export function secretPurpose(blob: string): string | undefined {
  if (!isPurposeEncrypted(blob)) return undefined;
  const encoded = blob.slice(PURPOSE_SECRET_PREFIX.length).split(':')[0];
  try { return Buffer.from(encoded, 'base64').toString('utf8'); } catch { return undefined; }
}

/** 加密：`v2:<base64(purpose)>:<base64(iv)>:<base64(tag)>:<base64(ct)>` */
export function encryptPurposeSecret(plain: string, masterKey: Buffer, purpose: string): string {
  if (!purpose.trim()) throw new Error('凭据用途不能为空');
  const key = derivePurposeKey(masterKey, purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PURPOSE_SECRET_PREFIX}${Buffer.from(purpose, 'utf8').toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** 解密；用途不匹配或密钥不符（GCM auth 失败）时抛错。 */
export function decryptPurposeSecret(blob: string, masterKey: Buffer, purpose?: string): string {
  if (!isPurposeEncrypted(blob)) return blob;
  const parts = blob.slice(PURPOSE_SECRET_PREFIX.length).split(':');
  if (parts.length !== 4) throw new Error('凭据密文格式非法');
  const [purposeB64, ivB64, tagB64, ctB64] = parts;
  const storedPurpose = Buffer.from(purposeB64, 'base64').toString('utf8');
  if (purpose !== undefined && purpose !== storedPurpose) {
    throw new Error(`凭据用途不匹配（存储 ${storedPurpose}，请求 ${purpose}）`);
  }
  const key = derivePurposeKey(masterKey, storedPurpose);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 可配置的共享 box：主密钥在启动后注入，已经持有该引用的插件立即生效。 */
export function createSecretBox(): MutableSecretBox {
  let key: Buffer | undefined;
  return {
    available: () => !!key,
    configure(next?: Buffer): void { key = next; },
    encrypt(plain: string, purpose: string): string {
      if (!key || !plain) return plain;
      return encryptPurposeSecret(plain, key, purpose);
    },
    decrypt(blob: string, purpose: string): string {
      if (!key || !blob) return blob;
      return decryptPurposeSecret(blob, key, purpose);
    },
  };
}
