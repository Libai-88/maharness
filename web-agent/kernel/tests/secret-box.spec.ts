import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createSecretBox,
  decryptPurposeSecret,
  derivePurposeKey,
  encryptPurposeSecret,
  isPurposeEncrypted,
  secretPurpose,
} from '../secret-box';

describe('purpose secret box', () => {
  it('无主密钥时明文透传', () => {
    const box = createSecretBox();
    assert.equal(box.available(), false);
    assert.equal(box.encrypt('token', 'provider:p1'), 'token');
    assert.equal(box.decrypt('token', 'provider:p1'), 'token');
  });

  it('同一用途可往返，不同用途不可解', () => {
    const box = createSecretBox();
    box.configure(randomBytes(32));
    const encrypted = box.encrypt('sensitive-value', 'provider:p1');
    assert.equal(isPurposeEncrypted(encrypted), true);
    assert.equal(secretPurpose(encrypted), 'provider:p1');
    assert.equal(box.decrypt(encrypted, 'provider:p1'), 'sensitive-value');
    assert.throws(() => box.decrypt(encrypted, 'provider:p2'), /用途不匹配/);
  });

  it('不同用途派生不同子密钥', () => {
    const master = randomBytes(32);
    assert.notDeepEqual(derivePurposeKey(master, 'provider:p1'), derivePurposeKey(master, 'provider:p2'));
  });

  it('错误主密钥无法解密', () => {
    const key = randomBytes(32);
    const blob = encryptPurposeSecret('x', key, 'mcp-oauth:demo');
    assert.throws(() => decryptPurposeSecret(blob, randomBytes(32), 'mcp-oauth:demo'));
  });

  it('v1 密文不会被误认为 v2', () => {
    assert.equal(isPurposeEncrypted('v1:a:b:c'), false);
    assert.equal(secretPurpose('v1:a:b:c'), undefined);
  });
});
