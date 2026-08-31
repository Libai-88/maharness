/**
 * server/tests/providers.spec.ts —— Provider URL 安全边界回归测试
 * 覆盖：assertPublicHttpUrl 拒绝私网/环回/链路本地与非法协议（SSRF 防护的
 * 保存路径与 /test 共用同一校验；全部用 IP 字面量，无 DNS/网络依赖）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../routes/shared';

describe('assertPublicHttpUrl SSRF 校验', () => {
  const reject = async (url: string, pattern: RegExp) => {
    await assert.rejects(() => assertPublicHttpUrl(url), pattern);
  };

  test('拒绝私网 IPv4 段', async () => {
    await reject('http://127.0.0.1', /不允许连接/);
    await reject('http://10.0.0.8', /不允许连接/);
    await reject('http://172.16.0.1', /不允许连接/);
    await reject('http://192.168.1.1', /不允许连接/);
  });

  test('拒绝链路本地与环回', async () => {
    await reject('http://169.254.169.254', /不允许连接/); // 云 metadata
    await reject('http://0.0.0.0', /不允许连接/);
  });

  test('拒绝 IPv6 环回 / ULA / 链路本地（含 IPv4-mapped）', async () => {
    await reject('http://[::1]', /不允许连接/);
    await reject('http://[::ffff:127.0.0.1]', /不允许连接/);
    await reject('http://[fc00::1]', /不允许连接/);
    await reject('http://[fe80::1]', /不允许连接/);
  });

  test('拒绝非 http/https 协议与非法地址格式', async () => {
    await reject('ftp://example.com', /仅支持/);
    await reject('file:///etc/passwd', /仅支持/);
    await reject('not-a-url', /地址格式无效/);
  });
});