/**
 * core/search/index.ts —— 联网搜索插件
 * 默认 DuckDuckGo HTML 搜索（零配置开箱可用）；配置 TAVILY_API_KEY 后走 Tavily（更稳定）。
 * SEARCH_PROXY 可指定 HTTP 代理（网络受限环境，经 undici ProxyAgent 实现）。
 * L2 缓存：按「查询词 + max_results」缓存 10 分钟，重复问题零成本。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Plugin, ToolContext } from '../../kernel/types';

const SEARCH_TTL = 10 * 60_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 可选代理：搜索请求走 HTTP 代理（如 http://127.0.0.1:7897），直连受限时使用 */
// 注意：必须用 undici 自带的 fetch + ProxyAgent（Node 全局 fetch 与其内嵌旧版 undici 不兼容）
const dispatcher: import('undici').Dispatcher | undefined = process.env.SEARCH_PROXY
  ? new ProxyAgent(process.env.SEARCH_PROXY)
  : undefined;

// ---------- Tavily ----------

async function searchTavily(query: string, max: number): Promise<SearchResult[]> {
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
  const res = await undiciFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': DDG_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while (out.length < max && (m = titleRe.exec(html))) {
    const title = decodeHtml(stripTags(m[2]));
    if (!title) continue;
    // DDG 结果按「标题 + 摘要」交替排布，顺序取摘要
    let snippet = '';
    const sm = snippetRe.exec(html);
    if (sm) snippet = decodeHtml(stripTags(sm[1]));
    out.push({ title, url: cleanDdgUrl(m[1]), snippet });
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
          '4. 关键词要准确简洁，必要时分多次搜索交叉验证。',
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

    ctx.logger.info(process.env.TAVILY_API_KEY
      ? '搜索就绪: web_search（Tavily）'
      : '搜索就绪: web_search（DuckDuckGo 降级，配置 TAVILY_API_KEY 可升级）');
  },
} satisfies Plugin;
