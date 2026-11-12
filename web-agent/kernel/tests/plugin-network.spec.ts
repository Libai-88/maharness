import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkAllowed } from '../plugin-network';

describe('插件网络出口策略', () => {
  test('full/none 是明确的全放行与全拒绝', () => {
    assert.equal(isNetworkAllowed('example.com', 443, { mode: 'full' }), true);
    assert.equal(isNetworkAllowed('example.com', 443, { mode: 'none' }), false);
  });

  test('allowlist 支持精确主机、通配子域与端口约束', () => {
    const policy = {
      mode: 'allowlist' as const,
      allowlist: ['api.example.com', '*.trusted.dev', '127.0.0.1:8080', '[::1]:9000'],
    };
    assert.equal(isNetworkAllowed('api.example.com', 443, policy), true);
    assert.equal(isNetworkAllowed('API.EXAMPLE.COM', 443, policy), true);
    assert.equal(isNetworkAllowed('a.trusted.dev', 443, policy), true);
    assert.equal(isNetworkAllowed('a.b.trusted.dev', 443, policy), true);
    assert.equal(isNetworkAllowed('trusted.dev', 443, policy), false, '通配不匹配裸域名');
    assert.equal(isNetworkAllowed('evil-trusted.dev', 443, policy), false);
    assert.equal(isNetworkAllowed('127.0.0.1', 8080, policy), true);
    assert.equal(isNetworkAllowed('127.0.0.1', 8081, policy), false);
    assert.equal(isNetworkAllowed('::1', 9000, policy), true);
    assert.equal(isNetworkAllowed('::1', 9001, policy), false);
  });

  test('空 allowlist 默认拒绝，不做隐式放行', () => {
    assert.equal(isNetworkAllowed('example.com', 443, { mode: 'allowlist', allowlist: [] }), false);
    assert.equal(isNetworkAllowed('example.com', 443, { mode: 'allowlist' }), false);
  });
});
