/**
 * server/routes/shared.ts —— 路由层共享工具
 * 从原单文件 routes.ts 拆出：SSE 帧写入、chat 服务解析/热刷新、密钥掩码、
 * SSRF 边界校验、git/文件管理器执行等跨资源复用的帮助函数与公共类型。
 */
import type { Express } from 'express';
import type { Kernel } from '../../kernel';
import type { LLMMessage, ModelCapability, ProviderDef, ToolDef } from '../../kernel/types';
import { inferCapabilities } from '../../kernel/modelCatalog';
import type { AgentLoop } from '../../kernel/types';
import { makeRunner } from '../../kernel/types';
import type { ProviderConfig } from '../../core/chat/provider';
import type { CompactOptions, CompactResult } from '../../core/chat/compact';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Response } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

const execFileAsync = promisify(execFile);

/** 各资源路由文件的公共依赖（index.ts 装配时统一传入） */
export interface RouteDeps {
  kernel: Kernel;
  store: Store;
  tracker?: ClientTracker;
  sseLimiter?: SseConnectionLimiter;
  /** 活跃 chat run 计数（M3 自动停止机制的事实源；句柄审计对外暴露用） */
  activeRunCount?: () => number;
}

/** 进程级 SSE 句柄配额，供全局事件流与聊天流共享。 */
export class SseConnectionLimiter {
  private readonly active = new Set<unknown>();
  constructor(private readonly maxConnections = 8) {}
  tryAcquire(connection: unknown): boolean {
    if (this.active.has(connection)) return true;
    if (this.active.size >= this.maxConnections) return false;
    this.active.add(connection);
    return true;
  }
  release(connection: unknown): void { this.active.delete(connection); }
  get size(): number { return this.active.size; }
}

export interface ChatService {
  providers: ProviderDef[];
  setProviders: (cfgs: ProviderConfig[]) => void;
  setPersonas: (list: { name: string; content: string }[]) => void;
  getSystemPrompt: () => string;
  /** 挂起审批清单（可按会话过滤）：刷新页面后审批卡原位复原 */
  listApprovals: (sessionId?: string) => { id: string; name: string; summary: string; args?: unknown; sessionId?: string; createdAt: number; expiresAt: number }[];
  // 对话能力层共享方法（server 经服务接口访问，不直接 import core/chat 实现——
  // 接口与 core/chat/index.ts 导出的 service 对象保持一致）
  textualizeHistory: (history: LLMMessage[]) => LLMMessage[];
  compactHistory: (history: LLMMessage[], maxTokens: number, opts?: CompactOptions) => Promise<CompactResult>;
  annotateToolDef: (t: ToolDef) => ToolDef;
  routeForTask: (taskText: string, routing: Record<string, string>, providers: ProviderDef[]) =>
    { provider: ProviderDef; model: string; reason: string; candidates: { providerId: string; model: string; score?: number; accepted: boolean; reasons: string[] }[] } | undefined;
  MODE_PROMPTS: Record<string, string>;
  ROLE_READONLY_TOOLS: ReadonlySet<string>;
  validateCheckpointHistory: (history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]) => string | null;
}

export function getChatService(kernel: Kernel): ChatService | undefined {
  // 共效应解析（v2）：依赖注册表按 key 解析，只返回 ACTIVE 提供者的绑定——比扫描能力表更直接
  return kernel.plugins.resolveService('service:chat') as ChatService | undefined;
}

/**
 * 造一个执行循环（service:runner）：server 层不再从 chat 服务里掏 runner——
 * 循环是可被任意插件接管的独立服务，对话引擎只是它的【默认实现】提供者。
 * 返回 undefined 表示无插件提供循环（如对话引擎被停用）：调用方据此返回可读错误。
 */
export function getRunner(kernel: Kernel): AgentLoop | undefined {
  return makeRunner(kernel as unknown as Parameters<typeof makeRunner>[0]);
}

/** 用 DB 中的启用 Provider 刷新对话服务（热生效，无需重启）；一并带上协议与模型能力 */
export function refreshChatProviders(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listProviders().filter((r) => r.enabled);
  const allModels = store.listModels();
  chat.setProviders(rows.map((r) => ({
    id: r.id, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model,
    protocol: r.protocol ?? 'openai',
    models: capabilitiesOf(r.id, r.model, allModels.filter(m => m.providerId === r.id)),
    inputPrice: r.priceIn ?? undefined, outputPrice: r.priceOut ?? undefined,
  })));
}

/** DB 模型行 → 运行时能力表；默认模型未登记时按目录推断补一条，保证路由永不缺数据 */
function capabilitiesOf(providerId: string, defaultModel: string, rows: ReturnType<Store['listModels']>): ModelCapability[] {
  const out: ModelCapability[] = rows.map((m) => {
    const inferred = inferCapabilities(m.modelId, providerId);
    return {
      modelId: m.modelId,
      contextWindow: m.contextWindow ?? inferred.contextWindow,
      maxOutput: m.maxOutput ?? inferred.maxOutput,
      vision: !!m.vision, tools: !!m.tools, reasoning: !!m.reasoning,
      priceIn: m.priceIn ?? inferred.priceIn, priceOut: m.priceOut ?? inferred.priceOut,
      enabled: !!m.enabled, source: m.source,
      latencyMs: m.latencyMs ?? undefined, privacyTier: m.privacyTier ?? undefined, riskLevel: m.riskLevel ?? undefined,
    };
  });
  if (defaultModel && !out.some(m => m.modelId === defaultModel)) {
    out.push({ modelId: defaultModel, ...inferCapabilities(defaultModel, providerId), enabled: true, source: 'inferred' });
  }
  return out;
}

/** 用 DB 中的启用人设刷新对话服务（L1 层，热生效） */
export function refreshChatPersonas(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listPersonas().filter((r) => r.enabled);
  chat.setPersonas(rows.map((r) => ({ name: r.name, content: r.content })));
}

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 写一帧 SSE 事件 */
export function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---- H5 SSRF 防护：/api/providers/* 的 baseUrl 边界与逐跳重定向校验 ----
//
// ⚠ **与 core/search/index.ts 的同名判定是两份等价实现**（A3/A5 分属不同写者，任务范围不允许
// 再抽公共模块）：网段表与 IPv4-mapped/6to4/NAT64 还原规则改一处必须同步改另一处，否则
// 「web_fetch 允许的地址」与「providers 允许的地址」会漂移，弱的那一处就是 SSRF 入口。
// 用例分别固化在 server/tests/ssrf.spec.ts 与 core/search/tests/ssrf.spec.ts。
// Provider 直连请求将已校验 DNS 结果用于 socket lookup，避免校验与连接间重解析。

/** 点分十进制 IPv4 → 32 位无符号数；非法返回 null（只认 4 段十进制，不接受 0x/八进制/单数形式） */
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
 *  逐组解析而不用字符串前缀判断，原因与 core/search 一致（A3）：
 *  `[::ffff:127.0.0.1]` 被 WHATWG 规范化成 `::ffff:7f00:1` 这类十六进制压缩形式后，
 *  前缀/`startsWith` 口径全部失效；`fe80::/10` 也远不止 `fe80` 一个前缀。 */
export function ipv6ToGroups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // zone id（fe80::1%eth0）不改变所属网段
  if (!s) return null;
  if (s.includes('.')) { // 尾部点分 IPv4 → 先换成两个十六进制分组
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
    if (head.length !== 8) return null;
  }
  const groups: number[] = [];
  for (const p of [...head, ...new Array<string>(fill).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups;
}

function inCidrV4(n: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return (n >>> shift) === (base >>> shift);
}

/** IPv4 私网/保留段表（与 core/search 同步维护；A3/A5 共同补齐的段：
 *  100.64/10 CGNAT、198.18/15 基准测试、192.0.0/24、192.88.99/24、224/4 组播、240/4 保留） */
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

/** 命中 IANA 保留/私网 IPv4 段（数值口径，避免正则漏段） */
export function isReservedIpv4(n: number): boolean {
  return V4_RESERVED.some(([base, bits]) => inCidrV4(n, base, bits));
}

/** IPv6 自身保留段（内嵌 v4 的先交给 embeddedIpv4 还原） */
function isReservedV6(groups: number[]): boolean {
  const g0 = groups[0];
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地（含 fe90…febf）
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  // fail-closed：只有 2000::/3 是全局单播（高 3 位 001），其余前缀一律拒绝。
  // 掩码必须是 0xe000：只比 0x2000 会把 fe80::/fec0:: 这类 111x 前缀误判成公网。
  return (g0 & 0xe000) !== 0x2000;
}

/** 还原 IPv6 里内嵌的 IPv4：`::/96`、`::ffff:0:0/96`（IPv4-mapped）、`2002::/16`（6to4）、
 *  `64:ff9b::/96`（NAT64）。外层前缀看着像公网、真正目的地却是内网，是这类地址的 SSRF 用法。 */
export function embeddedIpv4(groups: number[]): number | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const headZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (headZero && (g5 === 0 || g5 === 0xffff)) return ((g6 << 16) | g7) >>> 0;
  if (g0 === 0x2002) return ((g1 << 16) | g2) >>> 0;
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ((g6 << 16) | g7) >>> 0;
  }
  return null;
}

/** 统一判定：IP 字面量（带或不带 `[]`）是否属于私网/保留地址；true = 拒绝；解析不出即拒绝 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
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
  return true; // 不是 IP 字面量：调用方应走 DNS 分支
}

/** AGENT_ALLOW_PRIVATE_URLS 的统一读法（保存 / PATCH / /models / /test 四处共用，语义不再各写各的）。
 *  只认 '1'：与 core/search 的判定一致，避免 'true'/'0'/'yes' 之类歧义写法在各处表现不同。 */
export function allowsPrivateUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_ALLOW_PRIVATE_URLS === '1';
}

export interface PublicUrlCheckOptions {
  /** true = 放宽「地址是否私网」这一条（本机 Ollama 等）；协议白名单与格式校验照旧 */
  allowPrivate?: boolean;
}

type ResolvedAddress = { address: string; family: number };

async function resolveHttpTarget(
  raw: string,
  opts: PublicUrlCheckOptions = {},
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = resolveHost,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('地址格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https 协议');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址缺少主机名');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host);
  if (!addresses.length) throw new Error('域名无法解析');
  if (!opts.allowPrivate && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('不允许连接内网/环回/链路本地地址（连接本机模型或本地网关：在 web-agent/.env 中加入 AGENT_ALLOW_PRIVATE_URLS=1 并保存，热生效后重试）');
  }
  return { url, addresses };
}

/** 校验 baseUrl：协议仅 http/https；主机名是 IP 字面量就直接判定，域名则 DNS 解析后逐条判定。
 *  allowPrivate 只放宽地址判定——放行本地地址不该顺带把 file:// 也放进来（A5 一致性项）。 */
export async function assertPublicHttpUrl(raw: string, opts: PublicUrlCheckOptions = {}): Promise<void> {
  if (opts.allowPrivate) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('地址格式无效'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https 协议');
    if (!url.hostname) throw new Error('地址缺少主机名');
    return;
  }
  await resolveHttpTarget(raw, opts);
}

/** providers 各入口共用的校验：把「是否豁免」的决定收在这一个 helper 里（A5 一致性项） */
export async function assertProviderBaseUrl(raw: string): Promise<void> {
  await assertPublicHttpUrl(raw, { allowPrivate: allowsPrivateUrls() });
}

const REDIRECT_STATUS = [301, 302, 303, 307, 308];
/** 跨源跳转时要剥掉的凭据头（自己实现 follow，就得把 follow 内置的这条规则一并实现） */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key'];

function withoutCredentials(h: RequestInit['headers']): Headers {
  const out = new Headers(h);
  for (const k of CREDENTIAL_HEADERS) out.delete(k);
  return out;
}

export interface GuardedFetchDeps {
  /** 单跳校验器；默认 assertProviderBaseUrl（含 AGENT_ALLOW_PRIVATE_URLS 豁免）。测试可注入。 */
  assertUrl?: (raw: string) => Promise<void>;
  /** 可控解析器供确定性网络测试使用；生产默认使用同一解析结果完成校验和连接。 */
  resolveAddresses?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** 最多跟随几跳（与 core/search 的 fetchDoc 一致，默认 5），超限报错 */
  maxHops?: number;
}

/** 全局 fetch 的响应类型。本文件顶部 `import type { Response } from 'express'`（sse 用的那个）
 *  占用了 `Response` 这个名字，直接写 Response 会被解析成 Express 的响应对象。 */
export type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** fetch + redirect:'manual' + 逐跳复用同一 SSRF 校验（缺陷 A5 的主缺口）。
 *  默认 `redirect:'follow'` 时 undici 自己跟随 30x，**重定向目标一行校验都不过**：
 *  baseUrl 指向公网端点，让它 302 → http://127.0.0.1:9200/_search，
 *  /api/providers/models 会把响应体解析后回吐给前端（可读型 SSRF），/test 则是盲 SSRF。
 *  这里自己逐跳走：每一跳先过 assertUrl 再发请求，超过 maxHops 直接拒绝。
 *  默认路径将 DNS 解析结果同时用于地址校验和 socket lookup，避免校验/连接间重解析。 */
export async function fetchWithPublicRedirects(
  url: string,
  init: RequestInit = {},
  deps: GuardedFetchDeps = {},
): Promise<FetchResponse> {
  const assertUrl = deps.assertUrl ?? assertProviderBaseUrl;
  const maxHops = deps.maxHops ?? 5;
  const firstOrigin = new URL(url).origin;
  let current = url;
  let headers = init.headers;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let hops = 0;
  for (;;) {
    let target: { url: URL; addresses: ResolvedAddress[] };
    if (deps.assertUrl) {
      await assertUrl(current);
      target = await resolveHttpTarget(current, { allowPrivate: true }, deps.resolveAddresses ?? resolveHost);
    } else {
      target = await resolveHttpTarget(current, { allowPrivate: allowsPrivateUrls() }, deps.resolveAddresses ?? resolveHost);
    }
    const pinned = new Set(target.addresses.map(({ address }) => address));
    const dispatcher: Dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          if (hostname !== target.url.hostname || !pinned.size) {
            callback(new Error('连接主机与已校验主机不一致'), '', 0);
            return;
          }
          const addresses = target.addresses;
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      },
    });
    let res: FetchResponse;
    try {
      res = await undiciFetch(target.url.toString(), {
        ...init,
        headers: headers as import('undici').HeadersInit,
        method,
        body: body as import('undici').BodyInit | undefined,
        redirect: 'manual',
        dispatcher,
      } as import('undici').RequestInit) as unknown as FetchResponse;
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
    if (!REDIRECT_STATUS.includes(res.status)) {
      void dispatcher.close();
      return res;
    }
    const loc = res.headers.get('location');
    await res.body?.cancel().catch(() => { /* 跳转响应不消费，但要释放连接 */ });
    await dispatcher.close();
    if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
    let next: URL;
    try {
      next = new URL(loc, current);
    } catch {
      throw new Error(`重定向地址非法：${loc}`);
    }
    hops++;
    if (hops > maxHops) throw new Error(`重定向次数过多（>${maxHops}）`);
    if (next.origin !== firstOrigin) headers = withoutCredentials(headers); // 跨源：不携带 key
    // 与浏览器/fetch 规范一致的跳转改写：303、以及 301/302 的 POST → GET 且丢弃请求体
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    current = next.toString();
  }
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  return lookup(host, { all: true });
}

/** 在沙箱根目录执行 git 命令（无 repo 时返回 null） */
export async function gitIn(sandbox: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: sandbox, timeout: 15_000, windowsHide: true });
    return stdout;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 128 || code === 'ENOENT') return null; // 非 git 仓库 / git 未安装
    throw err;
  }
}

/** 用系统文件管理器打开目标（Windows: explorer） */
export function openInExplorer(target: string): void {
  const args = process.platform === 'win32' ? [`/select,${target}`] : [target];
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, args, { windowsHide: true }, (err) => {
    if (err) console.warn(`[open] ${target} 失败:`, err.message);
  });
}

/** 资源路由注册函数的统一签名 */
export type RegisterFn = (app: Express, deps: RouteDeps) => void;
