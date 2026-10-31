/**
 * server/tests/providers.spec.ts —— Provider URL 安全边界回归测试
 * 覆盖：assertPublicHttpUrl 拒绝私网/环回/链路本地与非法协议（SSRF 防护的
 * 保存路径与 /test 共用同一校验；全部用 IP 字面量，无 DNS/网络依赖）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../routes/shared';
import { buildProviderDiagnostics } from '../routes/providers';

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

describe('Provider 配置诊断', () => {
  test('只返回可操作状态，不泄露 key，并区分缺失配置、模型探测和健康故障', () => {
    const result = buildProviderDiagnostics({
      id: 'p1', baseUrl: 'https://api.example', apiKey: 'sk-secret', model: 'missing', protocol: 'openai',
    }, [{ providerId: 'p1', modelId: 'available', modelKey: 'p1@available', pricingId: 'p1@available', contextWindow: 128000, maxOutput: 4096, vision: false, tools: true, reasoning: false, priceIn: 1, priceOut: 2, source: 'inferred' }], {
      failures: 2, authFailed: true, lastError: 'HTTP 401', lastErrorAt: 123,
    });
    assert.equal(result.configured.apiKey, true);
    assert.equal(result.models[0]?.modelId, 'available');
    assert.ok(result.issues.includes('默认模型未登记或未完成能力探测'));
    assert.ok(result.issues.some((x) => x.includes('认证失败')));
    assert.equal(JSON.stringify(result).includes('sk-secret'), false);
  });

  test('Ollama 无 key 可诊断为有效配置，空地址仍报错', () => {
    const result = buildProviderDiagnostics({ id: 'local', protocol: 'ollama', model: 'llama3' }, [], undefined);
    assert.deepEqual(result.issues, ['缺少 Provider 地址']);
    assert.equal(result.configured.apiKey, false);
  });
});
