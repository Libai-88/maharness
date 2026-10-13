/**
 * server/tests/ssrf.spec.ts —— 缺陷 A5：providers 的 SSRF 边界（重定向逐跳复检 + 豁免一致性）
 *
 * 覆盖：
 *  ① 地址判定与 core/search 完全一致（同一张网段表逐条交叉比对，防"两处规则漂移"）；
 *  ② fetchWithPublicRedirects：redirect:'manual' + 每一跳复检（302 跳内网必须被拒，
 *     且绝不向被拒目标发起请求）、跳数上限、跨源剥凭据头、301/302 POST→GET 改写；
 *  ③ AGENT_ALLOW_PRIVATE_URLS 豁免语义统一（保存/PATCH/models/test 四处同一条规则），
 *     且豁免只放宽"地址是否私网"，协议白名单照旧。
 * 全部用 IP 字面量 + 本地 node:http mock：不做外网请求。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  isPrivateAddress, ipv4ToNumber, ipv6ToGroups, embeddedIpv4, isReservedIpv4,
  assertPublicHttpUrl, assertProviderBaseUrl, allowsPrivateUrls, fetchWithPublicRedirects,
} from '../routes/shared';
import { isPrivateAddress as searchIsPrivateAddress } from '../../core/search/index';

const ENV_KEY = 'AGENT_ALLOW_PRIVATE_URLS';
let savedEnv: string | undefined;
before(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
after(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

// ---------------------------------------------------------------- ① 与 core/search 同口径

/** 与 core/search/tests/ssrf.spec.ts 同一张表（两处都拒绝/两处都放行的地址） */
const PRIVATE: readonly string[] = [
  '[::ffff:7f00:1]', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1', '::ffff:a9fe:a9fe',
  '::7f00:1', '2002:7f00:1::', '64:ff9b::7f00:1',
  '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1', '192.88.99.1',
  '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.0.0.0',
  'fe80::1', 'fe90::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::1', '::',
  '127.0.0.1', '10.0.0.8', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
];
const PUBLIC: readonly string[] = [
  '::ffff:808:808', '2002:0808:0808::', '64:ff9b::808:808', '2001:4860:4860::8888',
  '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
  '198.17.255.255', '198.20.0.1', '192.0.1.1', '192.88.98.1', '223.255.255.255',
];

describe('A5① providers 与 web_fetch 用同一套私网判定（交叉比对防漂移）', () => {
  for (const ip of [...PRIVATE, ...PUBLIC]) {
    it(`两处同判：${ip}`, () => {
      assert.equal(
        isPrivateAddress(ip), searchIsPrivateAddress(ip),
        'server/routes/shared 与 core/search 的判定必须逐条一致（两份等价实现）',
      );
    });
  }
  for (const ip of PRIVATE) {
    it(`拒绝 ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
  }
  for (const ip of PUBLIC) {
    it(`放行 ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  }

  it('IPv4-mapped 十六进制压缩形式还原出的数值正确', () => {
    assert.equal(embeddedIpv4(ipv6ToGroups('::ffff:7f00:1')!), ipv4ToNumber('127.0.0.1'));
    assert.equal(embeddedIpv4(ipv6ToGroups('::ffff:a9fe:a9fe')!), ipv4ToNumber('169.254.169.254'));
    assert.equal(embeddedIpv4(ipv6ToGroups('2002:7f00:1::')!), ipv4ToNumber('127.0.0.1'));
    assert.equal(embeddedIpv4(ipv6ToGroups('64:ff9b::7f00:1')!), ipv4ToNumber('127.0.0.1'));
    assert.equal(isReservedIpv4(ipv4ToNumber('100.64.0.1')!), true);
    assert.equal(isReservedIpv4(ipv4ToNumber('100.63.255.255')!), false);
  });

  it('解析不出来一律 fail-closed', () => {
    for (const junk of ['', 'not-an-ip', '7f00:1', '1.2.3.4:80']) {
      assert.equal(isPrivateAddress(junk), true);
    }
  });
});

describe('A5① assertPublicHttpUrl：协议白名单与私网拦截', () => {
  const reject = async (url: string, pattern: RegExp) => {
    await assert.rejects(() => assertPublicHttpUrl(url), pattern);
  };

  it('拒绝内网/保留段（含 A3 那批压缩形式）', async () => {
    await reject('http://[::ffff:7f00:1]:3000/x', /不允许连接/);
    await reject('http://[::ffff:a9fe:a9fe]/x', /不允许连接/);
    await reject('http://[2002:7f00:1::]/x', /不允许连接/);
    await reject('http://[fe90::1]/x', /不允许连接/);
    await reject('http://100.64.0.1/x', /不允许连接/);
    await reject('http://198.18.0.1/x', /不允许连接/);
    await reject('http://127.0.0.1:11434/x', /不允许连接/);   // 原语义不变
    await reject('http://[::1]/x', /不允许连接/);
  });

  it('放行公网字面量', async () => {
    await assertPublicHttpUrl('http://[::ffff:808:808]/x');
    await assertPublicHttpUrl('http://8.8.8.8/x');
  });

  it('协议白名单与格式（不受豁免影响）', async () => {
    await reject('ftp://example.com', /仅支持/);
    await reject('file:///etc/passwd', /仅支持/);
    await reject('not-a-url', /地址格式无效/);
  });

  it('主机名仍走 DNS（localhost 解析到回环 → 拒绝）', async () => {
    await reject('http://localhost:11434/v1', /不允许连接/);
  });
});

// ---------------------------------------------------------------- ③ 豁免语义统一

describe('A5③ AGENT_ALLOW_PRIVATE_URLS 豁免：四处入口同一条规则', () => {
  it('默认（未设变量）：本机 Ollama 地址被拒', async () => {
    assert.equal(allowsPrivateUrls(), false);
    await assert.rejects(() => assertProviderBaseUrl('http://127.0.0.1:11434'), /不允许连接/);
  });

  it('设 =1：本机地址放行（此前 /api/providers/test 无条件校验，"验证密钥"连不上本机 Ollama）', async () => {
    process.env[ENV_KEY] = '1';
    try {
      assert.equal(allowsPrivateUrls(), true);
      await assertProviderBaseUrl('http://127.0.0.1:11434');   // /test 用的就是这条
      await assertProviderBaseUrl('http://[::ffff:7f00:1]:11434');
      await assertProviderBaseUrl('http://localhost:11434');   // 豁免时不再做 DNS 解析
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it('豁免只放宽地址，不放宽协议（file:// 之类仍然拒）', async () => {
    process.env[ENV_KEY] = '1';
    try {
      await assert.rejects(() => assertProviderBaseUrl('file:///etc/passwd'), /仅支持/);
      await assert.rejects(() => assertProviderBaseUrl('gibberish'), /地址格式无效/);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it('只认 "1"（避免 true/0/yes 之类歧义写法在各处表现不同）', () => {
    assert.equal(allowsPrivateUrls({ AGENT_ALLOW_PRIVATE_URLS: '1' }), true);
    assert.equal(allowsPrivateUrls({ AGENT_ALLOW_PRIVATE_URLS: 'true' }), false);
    assert.equal(allowsPrivateUrls({}), false);
  });

  it('providers.ts 不再自己读 env、也不再裸调 fetch（A5 的一致性收口）', () => {
    const src = readFileSync(fileURLToPath(new URL('../routes/providers.ts', import.meta.url)), 'utf8');
    assert.match(src, /assertProviderBaseUrl\(/, '四处入口应统一走 assertProviderBaseUrl');
    assert.doesNotMatch(src, /process\.env\.AGENT_ALLOW_PRIVATE_URLS/,
      '豁免判定只能在 allowsPrivateUrls() 一处读 env，否则四处语义会再次分叉');
    assert.doesNotMatch(src, /(?<![\w.])fetch\s*\(/,
      '不得直接调 fetch()：必须走 fetchWithPublicRedirects（逐跳 SSRF 复检）');
  });
});

// ---------------------------------------------------------------- ② 逐跳重定向复检

interface Hit { url: string; method: string; headers: Record<string, string | string[] | undefined> }
interface Mock { base: string; port: number; hits: Hit[] }
const mocks: Mock[] = [];
const servers: Server[] = [];

after(() => { for (const s of servers) s.close(); servers.length = 0; mocks.length = 0; });

/** 本地 mock：/redirect-to?url=… 302 到任意目标；/redirect-to-private 302 到自身 /leak；
 *  /loop 302 到自身（无限跳）；/ok 200；/leak 200（内网敏感端点的替身） */
async function startMock(): Promise<Mock> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: String(req.url), method: String(req.method), headers: req.headers as Record<string, string | string[] | undefined> });
    const port = (server.address() as AddressInfo).port;
    const self = `http://127.0.0.1:${port}`;
    if (req.url?.startsWith('/redirect-to?')) {
      const to = decodeURIComponent(req.url.slice('/redirect-to?'.length).replace(/^url=/, ''));
      res.writeHead(302, { Location: to });
      res.end();
      return;
    }
    if (req.url === '/redirect-to-private') { res.writeHead(302, { Location: `${self}/leak` }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { Location: `${self}/loop` }); res.end(); return; }
    if (req.url === '/leak') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('TOP-SECRET-FROM-INTERNAL'); return; }
    if (req.url === '/no-location') { res.writeHead(302); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  const mock = { base: `http://127.0.0.1:${port}`, port, hits };
  mocks.push(mock);
  return mock;
}

/** 只放行首跳的校验器：模拟「baseUrl 是公网 provider，但会 302 到内网」这一形态。
 *  测试环境没法把本地 mock 伪装成公网域名（不注入的话首跳就被拒，验的是①而不是"逐跳复检"
 *  这条接线），所以这里让首跳直接过，其余跳一律走真实 assertPublicHttpUrl。 */
function firstHopFreeValidator(): { hops: string[]; assertUrl: (raw: string) => Promise<void> } {
  const hops: string[] = [];
  return {
    hops,
    assertUrl: async (raw: string) => {
      hops.push(raw);
      if (hops.length > 1) await assertPublicHttpUrl(raw);
    },
  };
}

describe('A5② 重定向逐跳复检（302 跳内网 = 可读型 SSRF 的收口）', () => {
  it('302 → http://127.0.0.1:xxx 被拒，且绝不向该目标发起请求', async () => {
    const m = await startMock();
    const v = firstHopFreeValidator();
    await assert.rejects(
      () => fetchWithPublicRedirects(`${m.base}/redirect-to-private`, {}, { assertUrl: v.assertUrl }),
      /不允许连接/,
    );
    assert.deepEqual(v.hops.map(h => new URL(h).pathname), ['/redirect-to-private', '/leak'],
      '每一跳都要过一次校验（旧实现只有首跳被校验过）');
    assert.equal(m.hits.some(h => h.url === '/leak'), false,
      '被拒的目标不能真的去连（/models 会把响应体解析后回吐 → 读了就泄露）');
    assert.equal(m.hits.filter(h => h.url === '/redirect-to-private').length, 1);
  });

  it('manual 跟随：由我们自己跳一跳并复检，最终拿到 200（而非 302 原样返回）', async () => {
    const m = await startMock();
    // 目标同为 127.0.0.1 但走注入校验器全放行：拿到的应是最终 200，而不是 302 本身
    const res = await fetchWithPublicRedirects(
      `${m.base}/redirect-to?url=${encodeURIComponent(`${m.base}/ok`)}`,
      {},
      { assertUrl: async () => {} },
    );
    assert.equal(res.status, 200);
    assert.equal(m.hits.filter(h => h.url === '/ok').length, 1);
  });

  it('跳数上限：超限报错，不再继续跟', async () => {
    const m = await startMock();
    await assert.rejects(
      () => fetchWithPublicRedirects(`${m.base}/loop`, {}, { assertUrl: async () => {} }),
      /重定向次数过多/,
    );
    assert.equal(m.hits.filter(h => h.url === '/loop').length, 6, '首跳 + 5 跳，不多不少');
  });

  it('302 无 Location 直接报错（不吞成空 URL）', async () => {
    const m = await startMock();
    await assert.rejects(
      () => fetchWithPublicRedirects(`${m.base}/no-location`, {}, { assertUrl: async () => {} }),
      /缺少 Location/,
    );
  });

  it('跨源跳转剥掉凭据头；同源保留（自己实现 follow 就得把这条规则也实现）', async () => {
    const a = await startMock();
    const b = await startMock();
    const headers = { authorization: 'Bearer sk-secret', 'x-api-key': 'sk-anthropic' };
    await fetchWithPublicRedirects(
      `${a.base}/redirect-to?url=${encodeURIComponent(`${b.base}/ok`)}`,
      { headers },
      { assertUrl: async () => {} },
    );
    const cross = b.hits.find(h => h.url === '/ok');
    assert.ok(cross, '应已请求到目标');
    assert.equal(cross.headers.authorization, undefined, '跨源不得带上 Authorization');
    assert.equal(cross.headers['x-api-key'], undefined, '跨源不得带上 x-api-key');

    await fetchWithPublicRedirects(
      `${a.base}/redirect-to?url=${encodeURIComponent(`${a.base}/ok`)}`,
      { headers },
      { assertUrl: async () => {} },
    );
    const same = a.hits.filter(h => h.url === '/ok').pop();
    assert.equal(same?.headers.authorization, 'Bearer sk-secret', '同源跳转仍照常携带 key');
  });

  it('301/302 的 POST 改写为 GET 且丢弃请求体（与 fetch 规范/undici follow 一致）', async () => {
    const m = await startMock();
    const res = await fetchWithPublicRedirects(
      `${m.base}/redirect-to?url=${encodeURIComponent(`${m.base}/ok`)}`,
      { method: 'POST', body: '{"model":"x"}', headers: { 'content-type': 'application/json' } },
      { assertUrl: async () => {} },
    );
    assert.equal(res.status, 200);
    assert.equal(m.hits[0].method, 'POST');
    assert.equal(m.hits.find(h => h.url === '/ok')?.method, 'GET', '跳转后不得再 POST 到新地址');
  });

  it('默认校验器就是真实校验（不注入时本机地址在首跳即被拒）', async () => {
    const m = await startMock();
    await assert.rejects(() => fetchWithPublicRedirects(`${m.base}/ok`), /不允许连接/);
    assert.equal(m.hits.length, 0, '被拒的请求根本不该发出去');
  });

  it('豁免打开时跟随本机重定向（本机 Ollama 反代到本机另一端口不被拦）', async () => {
    const m = await startMock();
    process.env[ENV_KEY] = '1';
    try {
      const res = await fetchWithPublicRedirects(
        `${m.base}/redirect-to?url=${encodeURIComponent(`${m.base}/ok`)}`, {},
      );
      assert.equal(res.status, 200);
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});
