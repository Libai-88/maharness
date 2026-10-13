/**
 * core/search/tests/ssrf.spec.ts —— 缺陷 A3：web_fetch 的 SSRF 判定与体积上限回归
 *
 * 三块覆盖：
 *  ① IPv4-mapped / IPv4-compatible / 6to4 / NAT64 的内嵌 IPv4 还原（A3 的绕过点：
 *     WHATWG URL 把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`，旧实现 `slice(7)` 得到
 *     `7f00:1`，isIP()===0 → 落到最后一行 → 判成公网）；
 *  ② 私网/保留段补全（100.64/10、198.18/15、192.0.0/24、192.88.99/24、224/4、240/4，
 *     以及 fe80::/10 里 `startsWith('fe80')` 漏掉的 fe90…febf）；
 *  ③ 响应体体积上限：流式累积、越界即断连（旧实现在 arrayBuffer() 之后才判，
 *     无 content-length 时先把内存吃满）。
 *
 * 全部用 IP 字面量：不做 DNS、不碰外网（与 server/tests/providers.spec.ts 同纪律）。
 * ⚠ 地址判定与 server/routes/shared.ts 是两份等价实现，改一处须同步另一处。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isPrivateAddress, ipv4ToNumber, ipv6ToGroups, embeddedIpv4, isReservedIpv4,
  assertPublicUrl, fetchDoc,
} from '../index';

const ENV_KEY = 'AGENT_ALLOW_PRIVATE_URLS';
let savedEnv: string | undefined;
before(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
after(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

/** 主机名 → 测试 URL（v6 字面量要加方括号） */
const urlOf = (ip: string): string =>
  (ip.includes(':') ? `http://[${ip}]:3000/api/health` : `http://${ip}:3000/api/health`);

// ---------------------------------------------------------------- ① 内嵌 IPv4 还原

describe('A3① 内嵌 IPv4 的还原（十六进制压缩形式不再是公网）', () => {
  const EQUIV: readonly [string, string][] = [
    ['::ffff:7f00:1', '127.0.0.1'],        // ← 清单里那条可直接免审批绕过 web_fetch 的 payload
    ['::ffff:a00:1', '10.0.0.1'],
    ['::ffff:c0a8:1', '192.168.0.1'],
    ['::ffff:a9fe:a9fe', '169.254.169.254'], // 云 metadata
    ['::ffff:6440:1', '100.64.0.1'],
    ['::ffff:c612:0', '198.18.0.0'],
    ['::7f00:1', '127.0.0.1'],               // IPv4-compatible（::/96，已废弃但协议栈仍在解）
    ['2002:7f00:1::', '127.0.0.1'],          // 6to4：第 2、3 组就是 v4
    ['64:ff9b::7f00:1', '127.0.0.1'],        // NAT64 Well-Known Prefix：低 32 位是 v4
    ['::ffff:8.8.8.8', '8.8.8.8'],           // 公网：点分写法
    ['::ffff:808:808', '8.8.8.8'],           // 公网：同一地址的十六进制压缩写法（修复不能过拟合到"mapped 一律拒"）
    ['2002:0808:0808::', '8.8.8.8'],         // 公网 6to4
    ['64:ff9b::808:808', '8.8.8.8'],         // 公网 NAT64
  ];
  for (const [v6, v4] of EQUIV) {
    it(`${v6} → ${v4}`, () => {
      const groups = ipv6ToGroups(v6);
      assert.ok(groups, '应能逐组解析');
      const n = embeddedIpv4(groups!);
      assert.notEqual(n, null, '应还原出内嵌 IPv4');
      assert.equal(n, ipv4ToNumber(v4), '还原出的数值应与点分形式一致');
      // 两种写法必须同判——A3 的绕过正来自"只认点分、不认压缩"
      assert.equal(isPrivateAddress(v6), isPrivateAddress(v4));
    });
  }

  it('点分形式与压缩形式解析出同一组分（::ffff:127.0.0.1 == ::ffff:7f00:1）', () => {
    assert.deepEqual(ipv6ToGroups('::ffff:127.0.0.1'), ipv6ToGroups('::ffff:7f00:1'));
    assert.deepEqual(ipv6ToGroups('::ffff:7f00:1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(ipv6ToGroups('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(ipv6ToGroups('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(ipv6ToGroups('fe80::1%eth0'), ipv6ToGroups('fe80::1'), 'zone id 不影响所属网段');
  });

  it('非法/歧义写法解析为 null（由上层 fail-closed 拒绝）', () => {
    for (const bad of ['::1::2', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'gg::1', '1:2:3:4:5:6:7:8::', '', '::ffff:300.0.0.1']) {
      assert.equal(ipv6ToGroups(bad), null, `${bad} 不该被解析成合法 IPv6`);
    }
    for (const bad of ['1.2.3', '1.2.3.4.5', '0x7f.0.0.1', '256.0.0.1', '', '1.2.3.']) {
      assert.equal(ipv4ToNumber(bad), null, `${bad} 不该被解析成合法 IPv4`);
    }
    assert.equal(ipv4ToNumber('127.0.0.1'), 2130706433);
  });
});

// ---------------------------------------------------------------- ② 网段表

/** 判为私网/保留（全部必须拒绝） */
const PRIVATE: readonly string[] = [
  // IPv4：旧实现已覆盖的段（回归保护）
  '127.0.0.1', '127.255.255.255', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
  '192.168.0.1', '169.254.1.1', '169.254.169.254', '0.0.0.0', '0.255.255.255',
  // IPv4：A3 补齐的段
  '100.64.0.1', '100.127.255.255',        // 100.64.0.0/10 CGNAT（Tailscale 等）
  '198.18.0.1', '198.19.255.255',         // 198.18.0.0/15 设备基准测试
  '192.0.0.1',                              // 192.0.0.0/24 IETF 协议分配
  '192.88.99.1',                            // 192.88.99.0/24 6to4 中继任播
  '224.0.0.1', '239.255.255.255',           // 224.0.0.0/4 组播
  '240.0.0.1', '255.255.255.255',           // 240.0.0.0/4 保留（含有限广播）
  // IPv6：环回 / ULA / 链路本地
  '::1', '::', '[::1]',
  'fc00::1', 'fd12:3456::1',                // fc00::/7
  'fe80::1', 'fe90::1', 'febf::1',          // fe80::/10 —— 旧实现 startsWith('fe80') 只覆盖 fe80–fe8f
  'ff02::1',                                // ff00::/8 组播
  '100::1',                                 // 100::/64 discard-only（不在 2000::/3 → fail-closed）
  'fec0::1',                                // 旧 site-local（同上）
  // IPv4-mapped / 6to4 / NAT64 的内网形式（①里的等价表已验数值，这里验最终判定）
  '[::ffff:7f00:1]', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1', '::ffff:a9fe:a9fe',
  '::7f00:1', '2002:7f00:1::', '64:ff9b::7f00:1',
];

/** 判为公网（必须放行——修复不能把正常地址一起拦掉） */
const PUBLIC: readonly string[] = [
  '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1',   // CGNAT 段两侧边界
  '172.15.255.255', '172.32.0.1',                          // 172.16/12 两侧边界
  '198.17.255.255', '198.20.0.1',                          // 198.18/15 两侧边界
  '192.0.1.1', '192.88.98.1', '192.88.100.1',              // 192.0.0/24 与 192.88.99/24 邻接
  '223.255.255.255', '1.0.0.1',                            // 224/4 与 0/8 的下边界之外
  '::ffff:808:808', '2002:0808:0808::', '64:ff9b::808:808',
  '2001:4860:4860::8888', '2606:4700:4700::1111',          // 真实公网 v6（Google DNS / Cloudflare DNS）
];

describe('A3② 私网/保留段判定', () => {
  for (const ip of PRIVATE) {
    it(`拒绝 ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), true, `${ip} 必须判为私网/保留`);
    });
  }
  for (const ip of PUBLIC) {
    it(`放行 ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), false, `${ip} 是公网，不该被拦`);
    });
  }

  it('isReservedIpv4 按 CIDR 数值判定（不依赖字符串前缀）', () => {
    assert.equal(isReservedIpv4(ipv4ToNumber('100.64.0.1')!), true);
    assert.equal(isReservedIpv4(ipv4ToNumber('100.63.255.255')!), false);
    assert.equal(isReservedIpv4(ipv4ToNumber('198.19.255.255')!), true);
    assert.equal(isReservedIpv4(ipv4ToNumber('198.20.0.0')!), false);
    assert.equal(isReservedIpv4(ipv4ToNumber('255.255.255.255')!), true);
  });

  it('非 IP 字面量与空串 fail-closed', () => {
    for (const junk of ['', 'not-an-ip', '7f00:1', 'garbage', '1.2.3.4:80']) {
      assert.equal(isPrivateAddress(junk), true, `${junk} 解析不出即拒绝`);
    }
  });
});

describe('A3 URL 级拦截（web_fetch 真正走的入口 assertPublicUrl）', () => {
  for (const ip of PRIVATE) {
    const bare = ip.replace(/^\[|\]$/g, '');
    it(`抛错：${urlOf(bare)}`, async () => {
      await assert.rejects(() => assertPublicUrl(urlOf(bare)), /内网|保留/);
    });
  }
  for (const ip of PUBLIC) {
    const bare = ip.replace(/^\[|\]$/g, '');
    it(`放行：${urlOf(bare)}`, async () => {
      const u = await assertPublicUrl(urlOf(bare));
      assert.ok(u instanceof URL);
    });
  }

  it('原语义不变：协议白名单与内网主机名', async () => {
    await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /仅支持 http\/https/);
    await assert.rejects(() => assertPublicUrl('ftp://example.com'), /仅支持 http\/https/);
    await assert.rejects(() => assertPublicUrl('not-a-url'), /URL 不合法/);
    await assert.rejects(() => assertPublicUrl('http://localhost:11434'), /内网主机名/);
    await assert.rejects(() => assertPublicUrl('http://db.internal:5432/'), /内网主机名/);
    await assert.rejects(() => assertPublicUrl('http://'), /缺少主机名|URL 不合法/);
  });

  it('AGENT_ALLOW_PRIVATE_URLS=1 时本机地址照旧放行（本地 Ollama 场景）', async () => {
    process.env[ENV_KEY] = '1';
    try {
      const u = await assertPublicUrl('http://127.0.0.1:11434/api/tags');
      assert.equal(u.port, '11434');
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});

// ---------------------------------------------------------------- ③ 体积上限（流式）

describe('A3③ 体积上限：流式累积 + 越界即断连', () => {
  const CHUNK = 1024;
  const MAX_CHUNKS = 2000;     // 服务端最多吐 ~2MB
  const LIMIT = 20_000;        // 客户端上限 20KB

  let server: Server | null = null;
  /** 服务端实际写出的块数（每次请求重置）——用来证明"越界就断连"而不是"先全读进内存" */
  let written = 0;
  let finished = false;

  after(() => { server?.close(); server = null; });

  async function start(): Promise<string> {
    if (server) return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server = createServer((req, res) => {
      if (req.url === '/small') {
        const body = Buffer.alloc(2048, 0x42);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
        res.end(body);
        return;
      }
      if (req.url === '/big-header') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(MAX_CHUNKS * CHUNK) });
        res.end(Buffer.alloc(16, 0x41)); // 自称很大：应在 content-length 预检就被拒，不必读体
        return;
      }
      // /stream：故意不给 content-length（chunked），每 2ms 一块，共 ~4s
      written = 0;
      finished = false;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
        written++;
        res.write(Buffer.alloc(CHUNK, 0x41));
        if (written >= MAX_CHUNKS) { clearInterval(timer); finished = true; res.end(); }
      }, 2);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    server.unref();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function withLocalAllowed<T>(fn: () => Promise<T>): Promise<T> {
    // 本机 mock 端点当然在私网：这一节验的是体积上限，判定逻辑由上面两节独立覆盖
    process.env[ENV_KEY] = '1';
    try { return await fn(); } finally { delete process.env[ENV_KEY]; }
  }

  it('无 content-length 的长流：越界即拒，且服务端远未写完（证明未整包驻内存）', async () => {
    const base = await start();
    await assert.rejects(() => withLocalAllowed(() => fetchDoc(`${base}/stream`, undefined, LIMIT)), /响应过大/);
    assert.equal(finished, false, '不应等到服务端写完');
    assert.ok(written < 200, `越界后应立刻断连，实际服务端只被拉走 ${written}/${MAX_CHUNKS} 块`);
  });

  it('有 content-length 的超大响应：预检直接拒，不读正文', async () => {
    const base = await start();
    await assert.rejects(() => withLocalAllowed(() => fetchDoc(`${base}/big-header`, undefined, LIMIT)), /响应过大/);
  });

  it('上限之内的正常响应仍照常返回（回归保护）', async () => {
    const base = await start();
    const doc = await withLocalAllowed(() => fetchDoc(`${base}/small`, undefined, LIMIT));
    assert.equal(doc.bytes, 2048);
    assert.equal(doc.body, 'B'.repeat(2048));
    assert.equal(doc.redirected, 0);
  });
});
