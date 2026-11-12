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

export async function assertBrowserUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('URL 非法'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https');
  if (allowPrivate) return url;
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('拒绝访问本机地址（如需访问请设 browser.allowPrivate=true）');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
      throw new Error(`无法解析主机: ${host}`);
    });
  if (addresses.length === 0) throw new Error(`无法解析主机: ${host}`);
  if (addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error('拒绝访问私网地址（如需访问请设 browser.allowPrivate=true）');
  }
  return url;
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

    const sessionKey = (tctx: ToolContext) => tctx.sessionId ?? '_default';
    const getPage = async (tctx: ToolContext): Promise<Page> => {
      const key = sessionKey(tctx);
      const existing = sessions.get(key);
      if (existing) return existing.page;
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
        });
      } else {
        browser = await chromium.launch({ headless, executablePath });
        context = await browser.newContext({
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
        });
      }
      const page = context.pages()[0] ?? await context.newPage();
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
          '1. 需要登录/点击/填表/读取网页渲染结果时用 browser_open + browser_snapshot，不要用 web_fetch 假装交互；',
          '2. 点击/输入/按键会触发审批；执行前确认 selector 唯一，优先用可见文本或稳定的 data-testid；',
          '3. 每次动作后重新 snapshot 核对页面状态，不要凭猜测连续操作；',
          '4. 默认禁止私网地址；任务结束用 browser_close 释放会话。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'browser_open',
        risk: 'medium',
        costHint: 'medium',
        limits: '仅 http/https；默认拒绝私网；单会话独立 browser',
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
        name: 'browser_snapshot',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        limits: `返回正文 ≤ ${maxChars} 字符`,
        output: '{url, title, text, truncated}',
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
        name: 'browser_network',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        output: '{count, total, entries: [{url, method, status, resourceType, at}]}',
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
        name: 'browser_download',
        risk: 'medium',
        costHint: 'medium',
        approval: true,
        sideEffect: 'write',
        output: '{filename, path, bytes}',
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
        name: 'browser_click',
        risk: 'medium',
        costHint: 'low',
        approval: true,
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
        name: 'browser_type',
        risk: 'medium',
        costHint: 'low',
        approval: true,
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
        name: 'browser_press',
        risk: 'medium',
        costHint: 'low',
        approval: true,
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
        name: 'browser_close',
        risk: 'low',
        costHint: 'low',
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
        name: 'browser_screenshot',
        risk: 'low',
        costHint: 'low',
        output: '{path, bytes, fullPage}',
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
