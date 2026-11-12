/**
 * kernel/lock-signature.ts —— 锁文件 detached signature（Ed25519）
 *
 * 签名对象是去除 `signature` 字段后的规范化 JSON；键递归排序，避免格式差异改变摘要。
 * 公钥不由锁文件自带，而由部署侧 `MAHARNESS_*_PUBLIC_KEY` 提供——锁内公钥不可信。
 */
import { createPublicKey, sign, verify } from 'node:crypto';

export interface LockSignature {
  algorithm: 'ed25519';
  keyId?: string;
  signedAt: number;
  signature: string;
}

export interface LockSignatureResult {
  ok: boolean;
  reason?: string;
}

/** 稳定 JSON：对象键排序、忽略 undefined，保证跨平台/跨格式化签名一致。 */
export function canonicalJson(value: unknown): string {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return node;
  };
  return JSON.stringify(normalize(value));
}

function payloadOf(lock: Record<string, unknown>): string {
  const { signature: _signature, ...payload } = lock;
  return canonicalJson(payload);
}

export function signLockFile<T extends Record<string, unknown>>(
  lock: T,
  privateKeyPem: string,
  opts: { keyId?: string; now?: number } = {},
): T & { signature: LockSignature } {
  const signature = sign(null, Buffer.from(payloadOf(lock), 'utf8'), privateKeyPem).toString('base64');
  return {
    ...lock,
    signature: {
      algorithm: 'ed25519',
      ...(opts.keyId ? { keyId: opts.keyId } : {}),
      signedAt: opts.now ?? Date.now(),
      signature,
    },
  };
}

export function verifyLockFile(lock: Record<string, unknown>, publicKeyPem: string): LockSignatureResult {
  const signature = lock.signature as Partial<LockSignature> | undefined;
  if (!signature) return { ok: false, reason: '锁文件没有 signature 字段' };
  if (signature.algorithm !== 'ed25519') return { ok: false, reason: `不支持的签名算法: ${String(signature.algorithm)}` };
  if (!signature.signature) return { ok: false, reason: 'signature 为空' };
  try {
    const key = createPublicKey(publicKeyPem);
    const ok = verify(null, Buffer.from(payloadOf(lock), 'utf8'), key, Buffer.from(signature.signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: '签名校验失败（内容被修改或公钥不匹配）' };
  } catch (error) {
    return { ok: false, reason: `公钥或签名格式非法: ${error instanceof Error ? error.message : String(error)}` };
  }
}
