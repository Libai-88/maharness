import { fetchDoc } from '../search';
import type { PluginContext, ToolContext } from '../../kernel/plugin-sdk';
export interface Citation {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  journal?: string;
}
export interface Reference extends Citation {
  source: string;
  retrievedAt: string;
  verification: 'metadata_retrieved' | 'not_checked';
  abstract?: string;
}
export type MetadataFetcher = (
  url: string,
  signal?: AbortSignal,
  maxBytes?: number,
  deps?: object,
  accept?: string,
) => Promise<{ body: string; finalUrl: string }>;
const fetchMetadata: MetadataFetcher = fetchDoc;
function first(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}
function normalizeRecord(raw: Record<string, unknown>, source: string): Reference {
  const issued = raw.issued as { 'date-parts'?: number[][] } | undefined;
  const published = raw.published as { 'date-parts'?: number[][] } | undefined;
  return {
    doi: String(raw.DOI ?? '').toLowerCase() || undefined,
    title: first(raw.title),
    journal: first(raw['container-title']),
    year: issued?.['date-parts']?.[0]?.[0] ?? published?.['date-parts']?.[0]?.[0],
    authors: Array.isArray(raw.author)
      ? raw.author.map(
          (author: { given?: string; family?: string; name?: string }) =>
            author.name ?? [author.given, author.family].filter(Boolean).join(' '),
        )
      : [],
    source,
    retrievedAt: new Date().toISOString(),
    verification: 'metadata_retrieved',
    abstract: typeof raw.abstract === 'string' ? raw.abstract.replace(/<[^>]*>/g, '') : undefined,
  };
}
export function normalizeDoi(input: string): string {
  const doi = input
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意拒绝 DOI 中的控制字符与空白
  if (!/^10\.\d{4,9}\/\S+$/.test(doi) || doi.length > 1000 || /[<>"\x00-\x20]/.test(doi)) throw new Error('DOI 格式无效');
  return doi;
}
const comparable = (value: unknown) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
export function compareCitation(input: Citation, actual: Reference) {
  const fields = (['doi', 'title', 'authors', 'year', 'journal'] as const)
    .filter((field) => input[field] !== undefined)
    .map((field) => {
      const expected = input[field],
        registered = actual[field];
      const missing = registered === undefined || registered === '' || (Array.isArray(registered) && registered.length === 0);
      return {
        field,
        supplied: expected,
        registered,
        status: missing
          ? 'unavailable'
          : comparable(Array.isArray(expected) ? expected.join('|') : expected) ===
              comparable(Array.isArray(registered) ? registered.join('|') : registered)
            ? 'match'
            : 'different',
      };
    });
  return {
    status: fields.some((field) => field.status === 'different')
      ? 'differences_found'
      : fields.some((field) => field.status === 'unavailable')
        ? 'incomplete'
        : 'matched',
    fields,
  };
}
export function bibtex(reference: Citation, index = 1): string {
  const escaped = (value: unknown) =>
    String(value ?? '')
      .replace(/[\\{}%&#_$]/g, (char) => `\\${char}`)
      .replace(/[\r\n]+/g, ' ');
  const key = reference.doi ? `ref_${reference.doi.replace(/[^a-zA-Z0-9_-]/g, '_')}` : `ref${index}`;
  return `@article{${key},\n${[
    ['title', reference.title],
    ['author', reference.authors?.join(' and ')],
    ['year', reference.year],
    ['journal', reference.journal],
    ['doi', reference.doi],
  ]
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `  ${name} = {${escaped(value)}}`)
    .join(',\n')}\n}`;
}
export async function searchPapers(query: string, limit = 5, signal?: AbortSignal, fetcher = fetchMetadata): Promise<Reference[]> {
  if (!query.trim() || query.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error('检索词应为 1–2000 字符，数量为 1–10');
  const source = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}`;
  const response = await fetcher(source, signal, 2_000_000);
  const data = JSON.parse(response.body) as { message?: { items?: Record<string, unknown>[] } };
  if (!Array.isArray(data.message?.items)) throw new Error('题录服务未返回可识别的结果');
  return data.message.items.slice(0, limit).map((item) => normalizeRecord(item, response.finalUrl));
}
export async function verifyCitation(input: Citation, signal?: AbortSignal, fetcher = fetchMetadata) {
  if (!input.doi) return { status: 'unverified', reason: '未提供 DOI；请检索候选并由用户选择，不能自动认定' };
  const doi = normalizeDoi(input.doi);
  const source = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`;
  try {
    const response = await fetcher(source, signal, 1_000_000, {}, 'application/vnd.citationstyles.csl+json');
    const record = normalizeRecord(JSON.parse(response.body), response.finalUrl);
    if (!record.doi || record.doi !== doi) return { status: 'unverified', reason: '服务返回的 DOI 与请求不一致' };
    return {
      ...compareCitation({ ...input, doi }, record),
      record,
      bibtex: bibtex(record),
      limitation: '仅核验注册题录，不代表论文结论或全文已经核验',
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      status: 'unverified',
      source,
      retrievedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export function registerReferenceTools(ctx: PluginContext) {
  ctx.register({
    kind: 'tool',
    tool: {
      name: 'search_papers',
      version: '1.0.0',
      permissions: ['network'],
      sideEffect: 'external',
      risk: 'low',
      contentTrust: 'untrusted',
      timeoutMs: 30_000,
      description: '用 Crossref 公开题录检索文献，返回来源、检索时间和摘要（如有）。不保证全文可得；多候选不能自动认定为指定参考文献。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
      },
      outputSchema: { type: 'object', required: ['results'], properties: { results: { type: 'array' }, limitation: { type: 'string' } } },
      async handler(args: { query: string; limit?: number }, tctx: ToolContext) {
        try {
          return {
            ok: true,
            data: { results: await searchPapers(args.query, args.limit, tctx.signal), limitation: '题录检索；只有摘要时仅能基于摘要判断' },
          };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
    },
  });
  ctx.register({
    kind: 'tool',
    tool: {
      name: 'verify_reference',
      version: '1.0.0',
      permissions: ['network'],
      sideEffect: 'external',
      risk: 'low',
      contentTrust: 'untrusted',
      timeoutMs: 30_000,
      description:
        '通过 DOI 内容协商获取注册题录，逐字段比较 DOI、标题、作者顺序、年份和期刊。无法取得元数据时标为未核验，不认定错误；返回可导出的 BibTeX。',
      parameters: {
        type: 'object',
        properties: {
          doi: { type: 'string' },
          title: { type: 'string' },
          authors: { type: 'array', items: { type: 'string' } },
          year: { type: 'integer' },
          journal: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
          fields: { type: 'array' },
          record: { type: 'object' },
          reason: { type: 'string' },
          bibtex: { type: 'string' },
        },
      },
      async handler(args: Citation, tctx: ToolContext) {
        try {
          return { ok: true, data: await verifyCitation(args, tctx.signal) };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
    },
  });
}
