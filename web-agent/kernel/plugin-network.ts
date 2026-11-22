/**
 * 插件进程网络出口守卫。
 *
 * 在子进程加载插件前包住 fetch/http/https/net/tls/dgram，把 runtime.network 的
 * none/allowlist 变成运行时可观察的拒绝，而不是只写在 manifest 里。
 * 这不是 OS 级防火墙：原生扩展、已加载模块或绕过这些入口的代码仍可能出网；
 * 真正的强边界仍应由容器/网络命名空间/代理负责。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

export interface PluginNetworkPolicy {
  mode: 'none' | 'allowlist' | 'full';
  allowlist?: string[];
}

interface AllowEntry {
  host: string;
  wildcard: boolean;
  port?: number;
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function parseEntry(raw: string): AllowEntry | null {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (ipv6) return { host: normalizeHost(ipv6[1]!), wildcard: false, ...(ipv6[2] ? { port: Number(ipv6[2]) } : {}) };
  const lastColon = text.lastIndexOf(':');
  const hasSingleColon = lastColon > 0 && text.indexOf(':') === lastColon;
  const host = hasSingleColon ? text.slice(0, lastColon) : text;
  const port = hasSingleColon && /^\d+$/.test(text.slice(lastColon + 1)) ? Number(text.slice(lastColon + 1)) : undefined;
  const wildcard = host.startsWith('*.');
  return { host: normalizeHost(wildcard ? host.slice(2) : host), wildcard, ...(port ? { port } : {}) };
}

export function isNetworkAllowed(host: string, port: number | undefined, policy: PluginNetworkPolicy): boolean {
  if (policy.mode === 'full') return true;
  if (policy.mode === 'none') return false;
  const target = normalizeHost(host);
  const targetPort = port ?? undefined;
  for (const raw of policy.allowlist ?? []) {
    const entry = parseEntry(raw);
    if (!entry) continue;
    if (entry.port !== undefined && targetPort !== undefined && entry.port !== targetPort) continue;
    if (!entry.wildcard && target === entry.host) return true;
    if (entry.wildcard && target.endsWith(`.${entry.host}`)) return true;
  }
  return false;
}

function errorFor(host: string, port?: number): Error {
  return new Error(`插件网络出口被策略拒绝: ${host}${port ? `:${port}` : ''}`);
}

function urlOf(input: unknown): URL | null {
  if (typeof input === 'string' || input instanceof URL) {
    try {
      return new URL(String(input));
    } catch {
      return null;
    }
  }
  if (input && typeof input === 'object' && 'url' in input && typeof (input as { url?: unknown }).url === 'string') {
    try {
      return new URL((input as { url: string }).url);
    } catch {
      return null;
    }
  }
  return null;
}

function checkUrl(url: URL | null, policy: PluginNetworkPolicy): void {
  if (!url) return;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!isNetworkAllowed(url.hostname, port, policy)) throw errorFor(url.hostname, port);
}

function optionsOf(args: unknown[]): { host: string; port?: number } | null {
  const first = args[0];
  const url = urlOf(first);
  if (url) return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  if (typeof first === 'number') {
    return {
      host: typeof args[1] === 'string' ? args[1] : '127.0.0.1',
      port: first,
    };
  }
  if (first && typeof first === 'object') {
    const opts = first as { host?: unknown; hostname?: unknown; port?: unknown; protocol?: unknown };
    const host = typeof opts.hostname === 'string' ? opts.hostname : typeof opts.host === 'string' ? opts.host : '127.0.0.1';
    const port =
      typeof opts.port === 'number' ? opts.port : typeof opts.port === 'string' && /^\d+$/.test(opts.port) ? Number(opts.port) : undefined;
    return { host, ...(port ? { port } : {}) };
  }
  return null;
}

let installed = false;

export function installNetworkGuard(policy: PluginNetworkPolicy): void {
  if (installed || policy.mode === 'full') return;
  installed = true;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      checkUrl(urlOf(input), policy);
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  const wrapRequest = (mod: typeof http | typeof https) => {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const target = optionsOf(args);
      if (target && !isNetworkAllowed(target.host, target.port, policy)) throw errorFor(target.host, target.port);
      return (originalRequest as unknown as (...input: unknown[]) => unknown).apply(this, args);
    } as typeof mod.request;
    mod.request = wrapped;
    (mod as unknown as { get: typeof mod.get }).get = function (this: unknown, ...args: unknown[]) {
      const target = optionsOf(args);
      if (target && !isNetworkAllowed(target.host, target.port, policy)) throw errorFor(target.host, target.port);
      return (originalGet as unknown as (...input: unknown[]) => unknown).apply(this, args);
    } as typeof mod.get;
  };
  wrapRequest(http);
  wrapRequest(https);

  const wrapConnect = (mod: typeof net | typeof tls) => {
    const original = mod.connect;
    mod.connect = function (this: unknown, ...args: unknown[]) {
      const target = optionsOf(args);
      if (target && !isNetworkAllowed(target.host, target.port, policy)) throw errorFor(target.host, target.port);
      return (original as unknown as (...input: unknown[]) => unknown).apply(this, args);
    } as typeof mod.connect;
  };
  wrapConnect(net);
  wrapConnect(tls);

  const originalCreateSocket = dgram.createSocket;
  (dgram as unknown as { createSocket: typeof dgram.createSocket }).createSocket = function (this: unknown, ...args: unknown[]) {
    if (policy.mode !== 'full') throw errorFor('udp');
    return (originalCreateSocket as unknown as (...input: unknown[]) => unknown).apply(this, args);
  } as typeof dgram.createSocket;
}
