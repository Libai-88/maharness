/**
 * core/search/index.ts —— 联网搜索插件
 * 默认 DuckDuckGo HTML 搜索（零配置开箱可用）；配置 TAVILY_API_KEY 后走 Tavily（更稳定）。
 * SEARCH_PROXY 可代理固定的搜索服务请求；用户提供的抓取 URL 使用直连 DNS pinning。
 * L2 缓存：按「查询词 + max_results」缓存 10 分钟，重复问题零成本。
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Plugin, ToolContext } from '../../kernel/types';

const SEARCH_TTL = 10 * 60_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 可选代理：固定搜索服务请求走 HTTP 代理（如 http://127.0.0.1:7897），直连受限时使用
 *  注意：必须用 undici 自带的 fetch + ProxyAgent（Node 全局 fetch 与其内嵌旧版 undici 不兼容）
 *  v3.1 惰性化：不再做模块顶层常量——SEARCH_PROXY 变更后（.env 热更新）无需 reload 也取新值；
 *  按 proxy 值缓存实例（同值复用，避免每次创建）。 */
const dispatchers = new Map<string, import('undici').Dispatcher>();
let activeProxy: string | undefined;

/** SEARCH_PROXY 是部署信任边界：只接受明确的 HTTP(S) 代理端点，不允许
 * 把凭据、查询参数或片段混入连接配置，避免日志/错误链路意外携带秘密。 */
export function validateSearchProxy(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('SEARCH_PROXY 必须是合法的 http/https URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SEARCH_PROXY 仅支持 http/https 代理');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('SEARCH_PROXY 不得包含凭据、查询参数或片段');
  }
  return url;
}

export function getSearchDispatcher(): import('undici').Dispatcher | undefined {
  const proxy = process.env.SEARCH_PROXY;
  if (!proxy) {
    for (const dispatcher of dispatchers.values()) void dispatcher.close().catch(() => undefined);
    dispatchers.clear();
    activeProxy = undefined;
    return undefined;
  }
  validateSearchProxy(proxy);
  if (activeProxy !== proxy) {
    for (const [key, dispatcher] of dispatchers) {
      if (key !== proxy) {
        void dispatcher.close().catch(() => undefined);
        dispatchers.delete(key);
      }
    }
    activeProxy = proxy;
  }
  let d = dispatchers.get(proxy);
  if (!d) {
    d = new ProxyAgent(proxy);
    dispatchers.set(proxy, d);
  }
  return d;
}

// ---------- 网页抓取（web_fetch）：SSRF 防护 + HTML→文本/Markdown ----------

const FETCH_MAX_BYTES = 5_000_000;

/** 去标签但保留内部空白（pre/代码块用）；实体解码交给 decodeHtml */
function stripMarkup(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** HTML → 纯文本或轻量 Markdown（保留标题/链接/列表/换行结构） */
function htmlToText(html: string, mode: 'text' | 'markdown'): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(svg|canvas|noscript)[\s\S]*?<\/\1>/gi, ' ');
  if (mode === 'markdown') {
    s = s
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${decodeHtml(stripMarkup(t)).trim()}\n`)
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h: string, t: string) => `[${decodeHtml(stripMarkup(t)).trim()}](${h})`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `- ${decodeHtml(stripMarkup(t)).trim().replace(/\s*\n\s*/g, ' ')}\n`)
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t: string) => `\n\`\`\`\n${decodeHtml(stripMarkup(t)).replace(/\s+$/g, '')}\n\`\`\`\n`)
      .replace(/<\/(p|div|tr|section|article|header|footer)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n');
  }
  s = decodeHtml(stripMarkup(s));
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m ? decodeHtml(stripMarkup(m[1])).replace(/\s+/g, ' ').trim() : undefined;
}

// ---------- SSRF 地址判定（纯函数，导出便于表驱动测试）----------
//
// ⚠ **与 server/routes/shared.ts 的同名判定是两份等价实现**（A3/A5 分属不同写者，任务范围
// 不允许再抽公共模块）：网段表与还原规则改一处必须同步改另一处，否则「web_fetch 允许的地址」
// 与「providers 允许的地址」会漂移——漂移的结果是弱的那一处成为 SSRF 入口。
// 用例分别固化在 core/search/tests/ssrf.spec.ts 与 server/tests/ssrf.spec.ts。

/** 点分十进制 IPv4 → 32 位无符号数；非法返回 null。
 *  只认 4 段十进制：不接受 0x7f.1、八进制、`2130706433` 这类"同一串多种解释"的写法
 *  （WHATWG URL 会把它们规范化，但规范化前不能靠它兜底）。 */
export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** IPv6 字面量 → 8 个 16 位分组（高位在前）；非法返回 null。
 *  自己逐组解析（而不是只看字符串前缀）是修复 A3 的关键：
 *   - `::ffff:7f00:1`（WHATWG 把 `[::ffff:127.0.0.1]` 规范化成这个十六进制压缩形式）
 *     用 `slice(7)` 得到 `7f00:1`，既不是 IPv4 也不是完整 IPv6 → 旧实现落到最后一行判成公网；
 *   - `fe80::/10` 用 `startsWith('fe80')` 只覆盖 fe80–fe8f，漏掉 fe90…febf；
 *   - 6to4 / NAT64 的内嵌 IPv4 藏在**特定分组**里，必须拿到分组数值才能还原。 */
export function ipv6ToGroups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // 去掉 zone id（fe80::1%eth0）：它不改变所属网段
  if (!s) return null;
  // 尾部点分 IPv4（::ffff:127.0.0.1）先换成两个十六进制分组，之后按纯 IPv6 统一处理
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    if (cut < 0) return null;
    const v4 = ipv4ToNumber(s.slice(cut + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, cut)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const dd = s.indexOf('::');
  let head: string[], tail: string[], fill: number;
  if (dd >= 0) {
    if (s.indexOf('::', dd + 2) >= 0) return null; // 压缩符最多一个
    head = dd === 0 ? [] : s.slice(0, dd).split(':');
    tail = dd + 2 >= s.length ? [] : s.slice(dd + 2).split(':');
    fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // `::` 至少代表一组零
  } else {
    head = s.split(':');
    tail = [];
    fill = 0;
    if (head.length !== 8) return null; // 非压缩形式必须写满 8 组
  }
  const groups: number[] = [];
  for (const p of [...head, ...new Array<string>(fill).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups;
}

/** 命中 IANA 保留/私网 IPv4 段（32 位数值口径，避免正则漏段） */
export function isReservedIpv4(n: number): boolean {
  return V4_RESERVED.some(([base, bits]) => inCidrV4(n, base, bits));
}

/** IPv6 自身的保留段（内嵌 IPv4 的那几类先由 embeddedIpv4 还原，不在这里判） */
function isReservedV6(groups: number[]): boolean {
  const g0 = groups[0];
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地（含 fe90…febf，修掉旧实现的漏判）
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  // fail-closed：IANA 只把 2000::/3 分给全局单播，其余前缀（100::/64 discard-only、
  // 2001:2::/48 benchmarking、fec0::/16 site-local 等）都不该由外呼访问——与其逐段列举漏一段，
  // 不如"高 3 位不是 001 即拒绝"。（掩码必须是 0xe000 而非 0x2000：只比第 13 位会把 fe80/fec0
  // 这类 111x xxxx 前缀误判成公网。）
  return (g0 & 0xe000) !== 0x2000;
}

/** 从 IPv6 分组里还原本地内嵌的 IPv4（无内嵌返回 null）。
 *  这四类都是"把 v4 塞进 v6 地址"的转换机制，SSRF 判定的要害是：
 *  **外层 v6 前缀看着像公网，真正的目的地却是内网**，只看外层前缀必然被绕过。
 *   - `::/96` IPv4-compatible（已废弃但协议栈仍在解，`::7f00:1` == 127.0.0.1）
 *   - `::ffff:0:0/96` IPv4-mapped（A3 的绕过点：`::ffff:7f00:1` == 127.0.0.1）
 *   - `2002::/16` 6to4：第 2、3 组就是 v4（`2002:7f00:1::` == 127.0.0.1）
 *   - `64:ff9b::/96` NAT64 Well-Known Prefix：低 32 位是 v4
 *  未覆盖：Teredo（`2001::/32`，客户端 v4 异或藏在末两组）与 6rd——需要知道中继前缀长度，
 *  留作后续项（见 A3 修复说明）。 */
export function embeddedIpv4(groups: number[]): number | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const headZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (headZero && (g5 === 0 || g5 === 0xffff)) return ((g6 << 16) | g7) >>> 0; // ::/96 与 ::ffff:0:0/96
  if (g0 === 0x2002) return ((g1 << 16) | g2) >>> 0;                            // 6to4
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ((g6 << 16) | g7) >>> 0;                                             // NAT64 64:ff9b::/96
  }
  return null;
}

/** 统一判定：IP 字面量（带或不带 `[]`）是否属于私网/保留地址；true = 拒绝。
 *  解析不出来一律 true（fail-closed）——判定层拿不到确定结论时，宁可拒掉一次正常抓取，
 *  也不能放行一次内网探测。 */
export function isPrivateAddress(ip: string): boolean {
  const v = stripBrackets(ip).toLowerCase();
  const fam = isIP(v);
  if (fam === 4) {
    const n = ipv4ToNumber(v);
    return n === null ? true : isReservedIpv4(n);
  }
  if (fam === 6) {
    const groups = ipv6ToGroups(v);
    if (!groups) return true;
    const embedded = embeddedIpv4(groups);
    if (embedded !== null) return isReservedIpv4(embedded);
    return isReservedV6(groups);
  }
  return true; // 不是 IP 字面量：调用方应走 DNS 分支，这里不兜底
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

function inCidrV4(n: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return (n >>> shift) === (base >>> shift);
}

/** IPv4 私网/保留段表（A3 补齐：100.64/10 CGNAT、198.18/15 基准测试、192.0.0/24、
 *  192.88.99/24 6to4 中继任播、224/4 组播、240/4 保留含有限广播） */
const V4_RESERVED: readonly (readonly [number, number])[] = [
  [0x0000_0000, 8],  // 0.0.0.0/8     「本机」
  [0x0a00_0000, 8],  // 10.0.0.0/8    私网
  [0x6440_0000, 10], // 100.64.0.0/10 CGNAT / Tailscale 等运营商级 NAT
  [0x7f00_0000, 8],  // 127.0.0.0/8   环回
  [0xa9fe_0000, 16], // 169.254.0.0/16 链路本地（云 metadata 169.254.169.254）
  [0xac10_0000, 12], // 172.16.0.0/12 私网
  [0xc000_0000, 24], // 192.0.0.0/24  IETF 协议分配
  [0xc058_6300, 24], // 192.88.99.0/24 6to4 中继任播（已废弃，不可达）
  [0xc0a8_0000, 16], // 192.168.0.0/16 私网
  [0xc612_0000, 15], // 198.18.0.0/15 设备基准测试
  [0xe000_0000, 4],  // 224.0.0.0/4   组播
  [0xf000_0000, 4],  // 240.0.0.0/4   保留（含 255.255.255.255）
];

/** 校验 URL 并返回同一次 DNS 查询结果；fetchDoc 将该地址集合传给 socket lookup。 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return (await resolvePublicTarget(raw)).url;
}

type ResolvedAddress = { address: string; family: number };

async function resolvePublicTarget(
  raw: string,
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = (hostname) => dnsLookup(hostname, { all: true }),
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('URL 不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`仅支持 http/https（当前 ${u.protocol}）`);
  if (process.env.AGENT_ALLOW_PRIVATE_URLS === '1') {
    const host = stripBrackets(u.hostname);
    if (!host) throw new Error('URL 缺少主机名');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
    if (!addresses.length) throw new Error('域名无法解析');
    return { url: u, addresses };
  }
  const host = stripBrackets(u.hostname);
  if (!host) throw new Error('URL 缺少主机名');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('拒绝访问内网/保留地址（连接本地模型或本地网关：在 web-agent/.env 中加入 AGENT_ALLOW_PRIVATE_URLS=1 并保存，热生效后重试）');
    return { url: u, addresses: [{ address: host, family: isIP(host) }] };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('拒绝访问内网主机名（连接本地模型或本地网关：在 web-agent/.env 中加入 AGENT_ALLOW_PRIVATE_URLS=1 并保存，热生效后重试）');
  }
  const recs = await resolver(host);
  if (recs.length === 0) throw new Error('域名无法解析');
  if (recs.some(r => isPrivateAddress(r.address))) throw new Error('域名解析到内网地址（SSRF 拦截）');
  return { url: u, addresses: recs };
}

interface FetchedDoc { finalUrl: string; contentType: string; body: string; bytes: number; redirected: number }

/** 流式累积响应体：一旦累计字节越界就立刻 abort 掐断连接。
 *  旧实现是 `await res.arrayBuffer()` 之后再判长度——对**没有 content-length** 的响应
 *  （chunked / gzip 解码后膨胀）等于先把整包读进内存再拒绝，上限形同虚设；
 *  一个"无限流"端点就能把进程内存吃满（A3 附带项）。 */
async function readBodyCapped(res: UndiciResponse, limit: number, onOverLimit: () => void): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > limit) {
      onOverLimit();                                        // 触发 signal.abort()：底层连接立即销毁
      await reader.cancel().catch(() => { /* 已中止，取消失败不影响结论 */ });
      throw new Error(`响应过大（已读 ${total} 字节 > 上限 ${limit}，连接已中断）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** 手动跟随重定向：每一跳都重新做 SSRF 校验和 DNS pinning（防 302 跳内网）
 *  maxBytes 默认取 FETCH_MAX_BYTES，留出可注入余量便于测试体积上限。 */
export async function fetchDoc(
  url: string,
  signal?: AbortSignal,
  maxBytes = FETCH_MAX_BYTES,
  deps: { resolveAddresses?: (hostname: string) => Promise<ResolvedAddress[]> } = {},
): Promise<FetchedDoc> {
  let current = url;
  let hops = 0;
  for (;;) {
    const target = await resolvePublicTarget(current, deps.resolveAddresses);
    const u = target.url;
    const addressSet = new Set(target.addresses.map(({ address }) => address));
    // Arbitrary destinations stay direct so the validated IP is the socket peer;
    // SEARCH_PROXY is reserved for the fixed search-provider endpoints below.
    const dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          if (hostname !== u.hostname || !addressSet.size) {
            callback(new Error('连接主机与已校验主机不一致'), '', 0);
            return;
          }
          if (options.all) callback(null, target.addresses);
          else callback(null, target.addresses[0]!.address, target.addresses[0]!.family);
        },
      },
    });
    // 本跳专属的中止控制器：体积超限时用它主动断连（readBodyCapped 的 onOverLimit）
    const limitCtrl = new AbortController();
    const signals: AbortSignal[] = [AbortSignal.timeout(20000), limitCtrl.signal];
    if (signal) signals.push(signal);
    try {
      const res = await undiciFetch(u, {
        headers: { 'User-Agent': DDG_UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8' },
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => { /* 忽略 */ });
        if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
        current = new URL(loc, u).toString();
        hops++;
        if (hops > 5) throw new Error('重定向次数过多（>5）');
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => { /* 忽略 */ });
        throw new Error(`HTTP ${res.status}`);
      }
      const cl = Number(res.headers.get('content-length') ?? '0');
      if (cl > maxBytes) {
        await res.body?.cancel().catch(() => { /* 忽略 */ });
        throw new Error(`响应过大（${cl} 字节 > ${maxBytes}）`);
      }
      const buf = await readBodyCapped(res, maxBytes, () => limitCtrl.abort(new Error('响应超过体积上限')));
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      return { finalUrl: current, contentType, body: buf.toString('utf8'), bytes: buf.length, redirected: hops };
    } finally {
      await dispatcher.close();
    }
  }
}

// ---------- Tavily ----------

async function searchTavily(query: string, max: number): Promise<SearchResult[]> {
  const dispatcher = getSearchDispatcher();
  const res = await undiciFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: max,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(15000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? []).slice(0, max).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 500),
  }));
}

// ---------- DuckDuckGo（HTML 解析，零依赖） ----------

const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function searchDdg(query: string, max: number): Promise<SearchResult[]> {
  const dispatcher = getSearchDispatcher();
  const res = await undiciFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': DDG_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // M6 按结果块切分：以 result__a 锚点分段（锚点 → 下一锚点 = 一个结果块），
  // 块内分别提取 title/href/snippet——不共享正则游标，任一要素缺失只跳过该块，不再连锁错位
  const out: SearchResult[] = [];
  const anchorRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors = [...html.matchAll(anchorRe)];
  for (let i = 0; i < anchors.length && out.length < max; i++) {
    const a = anchors[i]!;
    const blockStart = a.index ?? 0;
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1]!.index : html.length;
    const block = html.slice(blockStart, blockEnd);
    const title = decodeHtml(stripTags(a[2] ?? ''));
    const href = a[1] ?? '';
    if (!title || !href) continue; // 块内要素缺失：跳过该块（不再污染后续配对）
    const sm = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = sm ? decodeHtml(stripTags(sm[1] ?? '')) : '';
    out.push({ title, url: cleanDdgUrl(href), snippet });
  }
  return out;
}

/** DDG 链接多为跳转地址（//duckduckgo.com/l/?uddg=...），还原真实 URL */
function cleanDdgUrl(raw: string): string {
  let u = raw;
  const uddg = u.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1]) {
    try { u = decodeURIComponent(uddg[1]); } catch { /* 保留原样 */ }
  }
  if (u.startsWith('//')) u = 'https:' + u;
  return decodeHtml(u);
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ', '&#x2F;': '/', '&#47;': '/',
};

function decodeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp|#x2F|#47);/g, (mm) => HTML_ENTITIES[mm] ?? mm);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ---------- 插件 ----------

export default {
  id: 'search',
  name: '联网搜索',
  version: '0.1.0',
  onLoad(ctx) {
    // v3.1 env 依赖声明：.env 变更（TAVILY_API_KEY / SEARCH_PROXY）→ reloadChanged 重载本插件
    // （dispatcher 已惰性化，即使不重载请求也会拿到新值；声明使「改动即生效」的心智模型一致）
    ctx.watchEnv('TAVILY_API_KEY');
    ctx.watchEnv('SEARCH_PROXY');

    // L2 人设：约束 LLM 正确使用搜索
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'search-rules',
        name: '联网搜索规则',
        description: '约束 LLM 正确使用联网搜索',
        priority: 10,
        content: [
          '联网搜索规则：',
          '1. 用户问及时事、外部信息或你不确定的事实时，先调用 web_search 获取事实，再基于结果回答；',
          '2. 引用搜索结果时标注来源（标题 + URL），绝不编造链接或内容；',
          '3. 搜索失败或结果为空时如实说明，不要编造；可换更准确的关键词重试；',
          '4. 关键词要准确简洁，必要时分多次搜索交叉验证；',
          '5. 搜索结果只有摘要时，需要全文就用 web_fetch 抓取该 URL（HTML 会转成文本/Markdown）；',
          '6. web_fetch 拒绝内网地址与 file:// 协议，不要尝试绕过。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'web_search',
        risk: 'low',
        costHint: 'medium',
        limits: '外部搜索服务；结果可能不完整',
        output: '{source, count, results: [{title, url, snippet}]}',
        description: '联网搜索（Tavily / DuckDuckGo）：返回结果列表（标题、URL、摘要）。适合查询时事、外部信息、文档资料等。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词（准确、简洁）' },
            max_results: { type: 'number', description: '返回条数（1-10，默认 5）' },
          },
          required: ['query'],
        },
        async handler(args: { query?: string; max_results?: number }, tctx: ToolContext) {
          const query = String(args.query ?? '').trim();
          if (!query) return { ok: false, error: '缺少 query 参数' };
          const max = Math.min(Math.max(Math.trunc(Number(args.max_results) || 5), 1), 10);
          const source = process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo';

          // L2 缓存：同查询 30 分钟内命中（TTL 由内核管理）；v2 命名空间：结果格式变更时旧缓存失效
          const key = tctx.cache.makeKey(['web_search', 'v2', query.toLowerCase(), String(max)]);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheLayer: 'L2', cacheKey: key })
              .finish({ outputSummary: '搜索结果缓存命中' });
            return { ok: true, data: hit.value };
          }

          try {
            const results = source === 'tavily' ? await searchTavily(query, max) : await searchDdg(query, max);
            const data = { query, source, count: results.length, results };
            tctx.cache.l2Set(key, data, SEARCH_TTL);
            return { ok: true, data };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
              ok: false,
              error: `${source === 'tavily' ? 'Tavily' : 'DuckDuckGo'} 搜索失败（${reason}）。可稍后重试；若网络受限，可配置 SEARCH_PROXY 代理或 TAVILY_API_KEY。`,
            };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'web_fetch',
        risk: 'medium',
        costHint: 'medium',
        limits: '仅 http/https；单页 ≤5MB；正文默认截断 8000 字符；拒绝内网地址（SSRF）',
        output: '{url, title, contentType, text, totalChars, truncated}',
        description: '抓取指定 URL 的正文（HTML 自动转纯文本或轻量 Markdown，保留标题/链接/列表/代码块）。用于读文档、issue、博客正文——web_search 只给摘要，需要全文时用本工具。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整 URL（http/https）' },
            format: { type: 'string', description: 'text（默认）| markdown | html（原样，谨慎）' },
            maxChars: { type: 'number', description: '返回正文上限（默认 8000，最大 40000）' },
          },
          required: ['url'],
        },
        async handler(args: { url?: string; format?: string; maxChars?: number }, tctx: ToolContext) {
          const raw = String(args.url ?? '').trim();
          if (!raw) return { ok: false, error: '缺少 url 参数' };
          const mode = (args.format === 'markdown' ? 'markdown' : args.format === 'html' ? 'html' : 'text') as 'text' | 'markdown' | 'html';
          const maxChars = Math.min(40_000, Math.max(500, Math.floor(Number(args.maxChars) || 8000)));
          const key = tctx.cache.makeKey(['web_fetch', 'v1', raw.toLowerCase(), mode, String(maxChars)]);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheLayer: 'L2', cacheKey: key })
              .finish({ outputSummary: '网页抓取缓存命中' });
            return { ok: true, data: hit.value };
          }
          try {
            const doc = await fetchDoc(raw, tctx.signal);
            const isHtml = doc.contentType.includes('html') || (mode !== 'html' && /^\s*</.test(doc.body));
            const text = mode === 'html' ? doc.body : isHtml ? htmlToText(doc.body, mode as 'text' | 'markdown') : doc.body;
            const title = isHtml && mode !== 'html' ? extractTitle(doc.body) : undefined;
            const data = {
              url: raw, finalUrl: doc.finalUrl, contentType: doc.contentType, title,
              text: text.slice(0, maxChars), totalChars: text.length, truncated: text.length > maxChars,
              redirected: doc.redirected || undefined,
            };
            tctx.cache.l2Set(key, data, SEARCH_TTL);
            return { ok: true, data };
          } catch (err) {
            return { ok: false, error: `抓取失败：${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.logger.info(process.env.TAVILY_API_KEY
      ? '工具就绪: web_search（Tavily）+ web_fetch'
      : '工具就绪: web_search（DuckDuckGo 降级，配置 TAVILY_API_KEY 可升级）+ web_fetch');
  },
} satisfies Plugin;
