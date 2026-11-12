import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson, signLockFile, verifyLockFile } from '../lock-signature';

describe('lock signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('canonicalJson 与键顺序无关', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('签名后可验证，篡改内容失败', () => {
    const lock = { version: 1, plugins: { a: { version: '1.0.0' } } };
    const signed = signLockFile(lock, privatePem, { keyId: 'test-key', now: 100 });
    assert.equal(signed.signature.algorithm, 'ed25519');
    assert.equal(signed.signature.keyId, 'test-key');
    assert.equal(verifyLockFile(signed, publicPem).ok, true);
    const tampered = { ...signed, plugins: { a: { version: '2.0.0' } } };
    assert.equal(verifyLockFile(tampered, publicPem).ok, false);
  });

  it('错误公钥与缺失签名明确失败', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = signLockFile({ version: 1 }, privatePem);
    assert.equal(verifyLockFile(signed, other).ok, false);
    assert.match(String(verifyLockFile({ version: 1 }, publicPem).reason), /没有 signature/);
  });
});
