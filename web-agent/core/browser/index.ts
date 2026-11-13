/**
 * core/browser/index.ts —— 浏览器自动化插件（Playwright）
 *
 * 默认关闭。config.json：
 *   "browser": { "enabled": true, "executablePath": "C:/path/to/chrome.exe", "allowPrivate": false }
 *
 * 安全边界：仅 http/https；默认拒绝私网目标（allowPrivate=true 才放行）；
 * 点击/输入/按键默认走审批；每个会话独立的 browser/page。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Plugin, ToolContext } from '../../kernel/types';
import { resolveInSandbox } from '../../kernel/sandbox';

const DEFAULT_MAX_CHARS = 8_000;
const MAX_CHARS = 40_000;
const MAX_NETWORK_ENTRIES = 200;

interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  at: number;
}

function privateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

export interface BrowserTarget {
  url: URL;
  addresses: { address: string; family: number }[];
}

/** 解析并校验目标；返回的 addresses 用于把实际连接钉死在这一次 DNS 结果上。 */
export async function resolveBrowserTarget(raw: string, allowPrivate: boolean): Promise<BrowserTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('URL 非法'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https');
  if (allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true }).catch(() => [] as { address: string; family: number }[]);
    return { url, addresses };
  }
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('拒绝访问本机地址（如需访问请设 browser.allowPrivate=true）');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => {
      throw new Error(`无法解析主机: ${host}`);
    });
  if (addresses.length === 0) throw new Error(`无法解析主机: ${host}`);
  if (addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error('拒绝访问私网地址（如需访问请设 browser.allowPrivate=true）');
  }
  return { url, addresses };
}

export async function assertBrowserUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  return (await resolveBrowserTarget(raw, allowPrivate)).url;
}

export interface BrowserProxy {
  port: number;
  close(): Promise<void>;
}

function splitHostPort(raw: string): { host: string; port: number } {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('代理目标为空');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) throw new Error('代理目标 IPv6 格式非法');
    const host = value.slice(1, end);
    const port = value.slice(end + 1).startsWith(':') ? Number(value.slice(end + 2)) : 80;
    return { host, port: Number.isFinite(port) ? port : 80 };
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
    return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
  }
  return { host: value, port: 80 };
}

/**
 * 浏览器出口代理：Chromium 的每个 http(s) 请求都先到这里，由代理做一次 DNS 校验
 * 并把 socket 连接到刚校验过的地址——浏览器自己不再获得第二次解析机会，从而关闭
 * DNS rebinding 的 TOCTOU 窗口。CONNECT（HTTPS）与普通 HTTP 都覆盖。
 */
export async function startBrowserProxy(
  resolve: (url: string) => Promise<BrowserTarget> = (url) => resolveBrowserTarget(url, false),
): Promise<BrowserProxy> {
  const sockets = new Set<Socket>();
  const server = createHttpServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const connectTo = async (host: string, port: number): Promise<{ socket: Socket; address: string; family: number }> => {
    const target = await resolve(`https://${host.includes(':') ? `[${host}]` : host}:${port}/`);
    const address = target.addresses[0];
    if (!address) throw new Error(`无法解析主机: ${host}`);
    return {
      socket: netConnect({ host: address.address, port, family: address.family }),
      address: address.address,
      family: address.family,
    };
  };

  server.on('connect', (req, clientSocket: Socket, head) => {
    void (async () => {
      try {
        const { host, port } = splitHostPort(req.url ?? '');
        const upstream = await connectTo(host, port);
        upstream.socket.once('connect', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.socket.write(head);
          upstream.socket.pipe(clientSocket);
          clientSocket.pipe(upstream.socket);
        });
        upstream.socket.once('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
        clientSocket.once('error', () => upstream.socket.destroy());
      } catch {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
    })();
  });

  server.on('request', (req, res) => {
    void (async () => {
      try {
        const target = await resolve(req.url ?? '');
        const address = target.addresses[0];
        if (!address) throw new Error('目标无法解析');
        const upstream = httpRequest({
          host: address.address,
          family: address.family,
          port: Number(target.url.port || 80),
          method: req.method,
          path: `${target.url.pathname}${target.url.search}`,
          headers: { ...req.headers, host: target.url.host },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        });
        upstream.once('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad Gateway');
        });
        req.pipe(upstream);
      } catch {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
      }
    })();
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectReady);
      resolveReady();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    },
  };
}

export default {
  id: 'browser',
  name: '浏览器',
  version: '0.1.0',
  onLoad(ctx) {
    const enabled = ctx.config.get<boolean>('browser.enabled', false);
    if (!enabled) {
      ctx.logger.info('浏览器插件未启用（config.json 设 browser.enabled=true 后重载）');
      return;
    }
    const executablePath = ctx.config.get<string>('browser.executablePath', process.env.MAHARNESS_BROWSER_PATH ?? '') || undefined;
    const headless = ctx.config.get<boolean>('browser.headless', true);
    const allowPrivate = ctx.config.get<boolean>('browser.allowPrivate', false);
    const persistent = ctx.config.get<boolean>('browser.persistent', true);
    const maxChars = Math.min(MAX_CHARS, Math.max(500, ctx.config.get<number>('browser.maxChars', DEFAULT_MAX_CHARS)));
    const sessions = new Map<string, { context: BrowserContext; browser?: Browser; page: Page; network: NetworkEntry[] }>();
    let proxyPromise: Promise<BrowserProxy> | undefined;
    const ensureProxy = (): Promise<BrowserProxy> => (proxyPromise ??= startBrowserProxy());

    const sessionKey = (tctx: ToolContext) =>
      `${tctx.tenantId ?? 'default'}\u0000${tctx.sessionId ?? '_default'}`;
    const getPage = async (tctx: ToolContext): Promise<Page> => {
      const key = sessionKey(tctx);
      const existing = sessions.get(key);
      if (existing) return existing.page;
      const proxy = !allowPrivate ? await ensureProxy() : undefined;
      const proxyOptions = proxy
        ? { proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' }, args: ['--proxy-bypass-list=<-loopback>'] }
        : {};
      const { chromium } = await import('playwright-core');
      const profileDir = join(ctx.paths.data, 'browser-profiles', key.replace(/[^a-zA-Z0-9_-]/g, '_'));
      mkdirSync(profileDir, { recursive: true });
      let browser: Browser | undefined;
      let context: BrowserContext;
      if (persistent) {
        context = await chromium.launchPersistentContext(profileDir, {
          headless,
          executablePath,
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
          ...proxyOptions,
        });
      } else {
        browser = await chromium.launch({ headless, executablePath, ...proxyOptions });
        context = await browser.newContext({
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
        });
      }
      const page = context.pages()[0] ?? await context.newPage();
      if (!allowPrivate) {
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (!/^https?:/i.test(url)) return route.continue();
          try {
            await assertBrowserUrl(url, false);
            await route.continue();
          } catch {
            await route.abort('blockedbyclient');
          }
        });
      }
      const network: NetworkEntry[] = [];
      page.on('response', (response) => {
        network.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          resourceType: response.request().resourceType(),
          at: Date.now(),
        });
        if (network.length > MAX_NETWORK_ENTRIES) network.splice(0, network.length - MAX_NETWORK_ENTRIES);
      });
      sessions.set(key, { context, browser, page, network });
      return page;
    };

    ctx.effect<void>(() => undefined, () => () => {
      for (const session of sessions.values()) {
        void session.context.close().catch(() => undefined);
        void session.browser?.close().catch(() => undefined);
      }
      sessions.clear();
      void proxyPromise?.then((p) => p.close()).catch(() => undefined);
    });

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'browser-rules',
        name: '浏览器使用规则',
        description: '约束 LLM 正确使用浏览器',
        priority: 6,
        content: [
          '浏览器使用规则：',
          '需要交互或读取渲染结果时用 browser_open + browser_snapshot；交互动作由审批边界拦截。',
          '默认禁止私网地址；任务结束用 browser_close 释放会话。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["network"],
        name: 'browser_open',
        risk: 'medium',
        costHint: 'medium',
        timeoutMs: 60_000,
        sideEffect: 'external',
        limits: '仅 http/https；默认拒绝私网；单会话独立 browser',
        outputSchema: {
          type: 'object', required: ['url', 'title'],
          properties: { url: { type: 'string' }, title: { type: 'string' }, status: { type: ['integer', 'null'] } },
        },
        description: '在浏览器中打开 URL（启动会话）。用于需要渲染/交互的网页任务。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'http/https URL' } },
          required: ['url'],
        },
        async handler(args: { url?: string }, tctx: ToolContext) {
          const raw = String(args.url ?? '').trim();
          if (!raw) return { ok: false, error: '缺少 url' };
          try {
            const url = await assertBrowserUrl(raw, allowPrivate);
            const page = await getPage(tctx);
            const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
            return { ok: true, data: { url: page.url(), title: await page.title(), status: response?.status() ?? null } };
          } catch (err) {
            return { ok: false, error: `打开页面失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'browser_snapshot',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        limits: `返回正文 ≤ ${maxChars} 字符`,
        output: '{url, title, text, truncated}',
        outputSchema: {
          type: 'object', required: ['url', 'title', 'text', 'truncated'],
          properties: { url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } },
        },
        description: '读取当前页面 URL、标题和可见正文（innerText），用于观察渲染结果与页面状态。',
        parameters: {
          type: 'object',
          properties: { maxChars: { type: 'integer', minimum: 500, maximum: MAX_CHARS } },
        },
        async handler(args: { maxChars?: number }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const limit = Math.min(MAX_CHARS, Math.max(500, Math.floor(Number(args.maxChars) || maxChars)));
          try {
            const text = (await page.locator('body').innerText({ timeout: 10_000 })).trim();
            const truncated = text.length > limit;
            const url = page.url();
            const title = await page.title();
            return {
              ok: true,
              data: { url, title, text: truncated ? text.slice(0, limit) : text, truncated },
              evidence: [{ kind: 'url', label: title || url, ref: url }],
            };
          } catch (err) {
            return { ok: false, error: `读取页面失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'browser_network',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        output: '{count, total, entries: [{url, method, status, resourceType, at}]}',
        outputSchema: {
          type: 'object', required: ['count', 'total', 'entries'],
          properties: { count: { type: 'integer' }, total: { type: 'integer' }, entries: { type: 'array' } },
        },
        description: '查看当前浏览器会话最近捕获的网络响应（最多 200 条），用于核对页面实际调用的 API 和资源状态。',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: '可选：URL 子串过滤' },
            max: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        async handler(args: { filter?: string; max?: number }, tctx: ToolContext) {
          const session = sessions.get(sessionKey(tctx));
          if (!session) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const filter = String(args.filter ?? '').trim().toLowerCase();
          const max = Math.max(1, Math.min(MAX_NETWORK_ENTRIES, Math.floor(Number(args.max) || 50)));
          const matched = session.network.filter((entry) => !filter || entry.url.toLowerCase().includes(filter));
          const entries = matched.slice(-max);
          return {
            ok: true,
            data: { count: entries.length, total: matched.length, entries },
            evidence: entries.slice(-5).map((entry) => ({ kind: 'url', label: `${entry.status} ${entry.method} ${entry.url}`, ref: entry.url })),
          };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'browser_download',
        risk: 'medium',
        costHint: 'medium',
        timeoutMs: 120_000,
        approval: true,
        sideEffect: 'write',
        output: '{filename, path, bytes}',
        outputSchema: {
          type: 'object', required: ['filename', 'path', 'bytes'],
          properties: { filename: { type: 'string' }, path: { type: 'string' }, bytes: { type: 'integer' } },
        },
        limits: '下载文件落 data/browser-downloads/<session>；单次只处理一个下载事件',
        description: '点击会触发下载的元素并保存文件到会话下载目录。用于导出报表、附件和文件下载任务。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '触发下载的元素 selector' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
          },
          required: ['selector'],
        },
        async handler(args: { selector?: string; timeoutMs?: number }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const selector = String(args.selector ?? '').trim();
          if (!selector) return { ok: false, error: '缺少 selector' };
          const timeout = Math.max(1000, Math.min(60_000, Math.floor(Number(args.timeoutMs) || 20_000)));
          try {
            const downloadPromise = page.waitForEvent('download', { timeout });
            await page.locator(selector).first().click({ timeout: 10_000 });
            const download = await downloadPromise;
            const dir = join(ctx.paths.data, 'browser-downloads', sessionKey(tctx).replace(/[^a-zA-Z0-9_-]/g, '_'));
            mkdirSync(dir, { recursive: true });
            const safe = basename(download.suggestedFilename() || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'download';
            const file = join(dir, `${Date.now()}-${safe}`);
            await download.saveAs(file);
            const bytes = statSync(file).size;
            return {
              ok: true,
              data: { filename: safe, path: file, bytes },
              evidence: [{ kind: 'file', label: `已下载 ${safe}`, ref: file }],
            };
          } catch (err) {
            return { ok: false, error: `下载失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["network"],
        name: 'browser_click',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'external',
        approval: true,
        outputSchema: {
          type: 'object', required: ['selector', 'url', 'title'],
          properties: { selector: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' } },
        },
        description: '点击当前页面的元素（CSS/文本 selector）。点击后建议 browser_snapshot 核对状态。',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string', description: 'Playwright selector，如 button[type=submit] 或 text=登录' } },
          required: ['selector'],
        },
        async handler(args: { selector?: string }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const selector = String(args.selector ?? '').trim();
          if (!selector) return { ok: false, error: '缺少 selector' };
          try {
            await page.locator(selector).first().click({ timeout: 10_000 });
            return { ok: true, data: { selector, url: page.url(), title: await page.title() } };
          } catch (err) {
            return { ok: false, error: `点击失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["network"],
        name: 'browser_type',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'external',
        approval: true,
        outputSchema: {
          type: 'object', required: ['selector', 'length'],
          properties: { selector: { type: 'string' }, length: { type: 'integer' } },
        },
        description: '在当前页面输入文本（fill）。用于表单/搜索框。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['selector', 'text'],
        },
        async handler(args: { selector?: string; text?: string }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const selector = String(args.selector ?? '').trim();
          if (!selector) return { ok: false, error: '缺少 selector' };
          try {
            await page.locator(selector).first().fill(String(args.text ?? ''), { timeout: 10_000 });
            return { ok: true, data: { selector, length: String(args.text ?? '').length } };
          } catch (err) {
            return { ok: false, error: `输入失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["network"],
        name: 'browser_press',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'external',
        approval: true,
        outputSchema: {
          type: 'object', required: ['key', 'url'],
          properties: { key: { type: 'string' }, url: { type: 'string' } },
        },
        description: '在当前页面按键（如 Enter / Tab / Escape）。',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string', description: 'Playwright key，如 Enter' } },
          required: ['key'],
        },
        async handler(args: { key?: string }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const key = String(args.key ?? '').trim();
          if (!key) return { ok: false, error: '缺少 key' };
          try {
            await page.keyboard.press(key);
            return { ok: true, data: { key, url: page.url() } };
          } catch (err) {
            return { ok: false, error: `按键失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: [],
        name: 'browser_close',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'none',
        outputSchema: {
          type: 'object', required: ['closed'],
          properties: { closed: { type: 'boolean' }, note: { type: 'string' } },
        },
        description: '关闭当前会话的浏览器，释放资源。',
        parameters: { type: 'object', properties: {} },
        async handler(_args: unknown, tctx: ToolContext) {
          const key = sessionKey(tctx);
          const session = sessions.get(key);
          if (!session) return { ok: true, data: { closed: false, note: '当前会话没有打开的浏览器' } };
          sessions.delete(key);
          await session.context.close().catch(() => undefined);
          return { ok: true, data: { closed: true } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'browser_screenshot',
        risk: 'low',
        costHint: 'low',
        timeoutMs: 60_000,
        sideEffect: 'read',
        output: '{path, bytes, fullPage}',
        outputSchema: {
          type: 'object', required: ['path', 'bytes', 'fullPage'],
          properties: { path: { type: 'string' }, bytes: { type: 'integer' }, fullPage: { type: 'boolean' } },
        },
        description: '把当前页面截图保存为 PNG（路径相对沙箱根）。用于视觉检查、留证或后续 analyze_image。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'PNG 保存路径（相对沙箱根），如 screenshots/page.png' },
            fullPage: { type: 'boolean', description: '是否整页截图（默认仅视口）' },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; fullPage?: boolean }, tctx: ToolContext) {
          const page = sessions.get(sessionKey(tctx))?.page;
          if (!page) return { ok: false, error: '浏览器未打开，请先 browser_open' };
          const raw = String(args.path ?? '').trim();
          if (!raw) return { ok: false, error: '缺少 path' };
          if (!/\.png$/i.test(raw)) return { ok: false, error: '截图路径必须以 .png 结尾' };
          const file = resolveInSandbox(tctx.sandboxRoot, raw);
          mkdirSync(join(file, '..'), { recursive: true });
          try {
            await page.screenshot({ path: file, fullPage: args.fullPage === true });
            return { ok: true, data: { path: raw, bytes: statSync(file).size, fullPage: args.fullPage === true } };
          } catch (err) {
            return { ok: false, error: `截图失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.logger.info(`浏览器就绪：browser_open / snapshot / click / type / press / screenshot / close（headless=${headless}）`);
  },
} satisfies Plugin;
