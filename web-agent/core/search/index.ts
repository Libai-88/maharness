/**
 * core/search/index.ts —— 联网搜索插件
 * 默认 DuckDuckGo HTML 搜索（零配置开箱可用）；配置 TAVILY_API_KEY 后走 Tavily（更稳定）。
 * SEARCH_PROXY 可指定 HTTP 代理（网络受限环境，经 undici ProxyAgent 实现）。
 * L2 缓存：按「查询词 + max_results」缓存 10 分钟，重复问题零成本。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Plugin, ToolContext } from '../../kernel/types';

const SEARCH_TTL = 10 * 60_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 可选代理：搜索请求走 HTTP 代理（如 http://127.0.0.1:7897），直连受限时使用
 *  注意：必须用 undici 自带的 fetch + ProxyAgent（Node 全局 fetch 与其内嵌旧版 undici 不兼容）
 *  v3.1 惰性化：不再做模块顶层常量——SEARCH_PROXY 变更后（.env 热更新）无需 reload 也取新值；
 *  按 proxy 值缓存实例（同值复用，避免每次创建）。 */
const dispatchers = new Map<string, import('undici').Dispatcher>();
function getDispatcher(): import('undici').Dispatcher | undefined {
  const proxy = process.env.SEARCH_PROXY;
  if (!proxy) return undefined;
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

const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/;
function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  if (isIP(v) === 4) return PRIVATE_V4.test(v);
  return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd');
}

/** 仅 http/https、拒绝解析到内网（AGENT_ALLOW_PRIVATE_URLS=1 放行本机 Ollama 等） */
async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('URL 不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`仅支持 http/https（当前 ${u.protocol}）`);
  if (process.env.AGENT_ALLOW_PRIVATE_URLS === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('URL 缺少主机名');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('拒绝访问内网/回环地址');
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('拒绝访问内网主机名');
  }
  const recs = await dnsLookup(host, { all: true });
  if (recs.some(r => isPrivateAddress(r.address))) throw new Error('域名解析到内网地址（SSRF 拦截）');
  return u;
}

interface FetchedDoc { finalUrl: string; contentType: string; body: string; bytes: number; redirected: number }

/** 手动跟随重定向：每一跳都重新做 SSRF 校验（防 302 跳内网） */
async function fetchDoc(url: string, signal?: AbortSignal): Promise<FetchedDoc> {
  let current = url;
  let hops = 0;
  for (;;) {
    const u = await assertPublicUrl(current);
    const dispatcher = getDispatcher();
    const res = await undiciFetch(u, {
      headers: { 'User-Agent': DDG_UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
      current = new URL(loc, u).toString();
      hops++;
      if (hops > 5) throw new Error('重定向次数过多（>5）');
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cl = Number(res.headers.get('content-length') ?? '0');
    if (cl > FETCH_MAX_BYTES) throw new Error(`响应过大（${cl} 字节 > ${FETCH_MAX_BYTES}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FETCH_MAX_BYTES) throw new Error(`响应过大（${buf.length} 字节）`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    return { finalUrl: current, contentType, body: buf.toString('utf8'), bytes: buf.length, redirected: hops };
  }
}

// ---------- Tavily ----------

async function searchTavily(query: string, max: number): Promise<SearchResult[]> {
  const dispatcher = getDispatcher();
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
  const dispatcher = getDispatcher();
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
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
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
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
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
