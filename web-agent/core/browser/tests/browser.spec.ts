import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import browserPlugin, { assertBrowserUrl } from '../index';

const FULL_CHROME = 'D:\\DEEPSEEK\\pw-browsers\\chromium-1248\\chrome-win64\\chrome.exe';
const CHROME = process.env.MAHARNESS_TEST_BROWSER
  ?? 'D:\\DEEPSEEK\\pw-browsers\\chromium_headless_shell-1248\\chrome-headless-shell-win64\\chrome-headless-shell.exe';

describe('浏览器 URL 边界', () => {
  it('拒绝非 http/https 与私网地址', async () => {
    await assert.rejects(() => assertBrowserUrl('ftp://example.com', false), /仅支持 http\/https/);
    await assert.rejects(() => assertBrowserUrl('http://127.0.0.1:3000', false), /私网|本机/);
    assert.equal((await assertBrowserUrl('http://127.0.0.1:3000', true)).hostname, '127.0.0.1');
    assert.equal((await assertBrowserUrl('https://example.com', false)).hostname, 'example.com');
  });
});

describe('浏览器插件', () => {
  it('打开、输入、点击、快照与关闭', { skip: !existsSync(CHROME) }, async () => {
    const server = createServer((req, res) => {
      if (req.url === '/download') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="report.txt"',
        });
        res.end('downloaded report');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1 id="title">Hello</h1><input id="name"><button id="go" onclick="document.getElementById(\'title\').textContent=\'Clicked\'">Go</button><a id="dl" href="/download" download>Download</a></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dataDir = mkdtempSync(join(process.cwd(), '.tmp-browser-'));
    let cleanup: (() => void) | undefined;
    try {
      const tools = new Map<string, any>();
      const config = new Map<string, unknown>([
        ['browser.enabled', true],
        ['browser.executablePath', CHROME],
        ['browser.allowPrivate', true],
        ['browser.headless', true],
      ]);
      browserPlugin.onLoad({
        config: { get: <T>(key: string, fallback?: T): T => (config.has(key) ? config.get(key) as T : fallback as T) },
        paths: { data: dataDir },
        register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
        effect(_init: () => void, cleanupFn: () => () => void) { cleanup = cleanupFn(); },
        logger: { info() {} },
      } as never);
      const ctx = { sessionId: 'browser-test', turn: 0, sandboxRoot: dataDir, cache: {}, trace: {} };
      const opened = await tools.get('browser_open').handler({ url: `http://127.0.0.1:${port}` }, ctx);
      assert.equal(opened.ok, true, opened.error);
      const first = await tools.get('browser_snapshot').handler({}, ctx);
      assert.match(first.data.text, /Hello/);
      const network = await tools.get('browser_network').handler({ filter: '127.0.0.1' }, ctx);
      assert.equal(network.ok, true, network.error);
      assert.ok(network.data.count >= 1);
      const shot = await tools.get('browser_screenshot').handler({ path: 'shot.png' }, ctx);
      assert.equal(shot.ok, true, shot.error);
      assert.ok(shot.data.bytes > 0);
      assert.equal(existsSync(join(dataDir, 'shot.png')), true);
      assert.equal((await tools.get('browser_type').handler({ selector: '#name', text: 'agent' }, ctx)).ok, true);
      assert.equal((await tools.get('browser_click').handler({ selector: '#go' }, ctx)).ok, true);
      const after = await tools.get('browser_snapshot').handler({}, ctx);
      assert.match(after.data.text, /Clicked/);
      assert.equal((await tools.get('browser_close').handler({}, ctx)).data.closed, true);
    } finally {
      cleanup?.();
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('下载与网络观测（完整 Chromium）', {
    skip: !existsSync(FULL_CHROME) || process.env.MAHARNESS_TEST_DOWNLOAD !== '1'
      ? '需要完整 Chromium 且设置 MAHARNESS_TEST_DOWNLOAD=1'
      : false,
  }, async () => {
    const server = createServer((req, res) => {
      if (req.url === '/download') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="report.txt"' });
        res.end('downloaded report');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><a id="dl" href="/download" download>Download</a></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dataDir = mkdtempSync(join(tmpdir(), 'mh-browser-dl-'));
    let cleanup: (() => void) | undefined;
    try {
      const tools = new Map<string, any>();
      const config = new Map<string, unknown>([
        ['browser.enabled', true], ['browser.executablePath', FULL_CHROME],
        ['browser.allowPrivate', true], ['browser.headless', true], ['browser.persistent', false],
      ]);
      browserPlugin.onLoad({
        config: { get: <T>(key: string, fallback?: T): T => (config.has(key) ? config.get(key) as T : fallback as T) },
        paths: { data: dataDir },
        register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
        effect(_init: () => void, cleanupFn: () => () => void) { cleanup = cleanupFn(); },
        logger: { info() {} },
      } as never);
      const ctx = { sessionId: 'download-test', turn: 0, sandboxRoot: dataDir, cache: {}, trace: {} };
      const opened = await tools.get('browser_open').handler({ url: `http://127.0.0.1:${port}` }, ctx);
      assert.equal(opened.ok, true, opened.error);
      const network = await tools.get('browser_network').handler({ filter: '127.0.0.1' }, ctx);
      assert.equal(network.ok, true, network.error);
      assert.ok(network.data.count >= 1);
      const download = await tools.get('browser_download').handler({ selector: '#dl' }, ctx);
      assert.equal(download.ok, true, download.error);
      assert.equal(existsSync(download.data.path), true);
      assert.equal(download.data.filename, 'report.txt');
    } finally {
      cleanup?.();
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
