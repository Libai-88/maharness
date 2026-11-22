/**
 * MCP Registry 客户端：只读发现 + 受控安装候选生成。
 *
 * registry 是外部来源，条目元数据不可信。这里只接受两种可验证形态：
 *  - npm 包 + stdio：固定 `npx -y <pkg>[@version]`，包名走安全正则；
 *  - https remote：只接受 https URL（本机调试可显式 allowPrivate）。
 * 条目里的 env/headers/命令模板不直接落地，避免 registry 注入本地命令。
 */
import type { ServerCfg } from './index';

export interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
}

export interface RegistryRemote {
  type?: string;
  url?: string;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
  repository?: { url?: string };
}

export interface RegistrySearchOptions {
  baseUrl: string;
  query?: string;
  limit?: number;
  signal?: AbortSignal;
  assertUrl?: (url: string) => Promise<void>;
}

const PACKAGE_REF = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9A-Za-z.+-]+)?$/i;

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeRegistryServer(raw: unknown): RegistryServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const source =
    (raw as { server?: unknown }).server && typeof (raw as { server?: unknown }).server === 'object'
      ? (raw as { server: Record<string, unknown> }).server
      : (raw as Record<string, unknown>);
  const name = stringOf(source.name);
  if (!name) return null;
  const packages = Array.isArray(source.packages)
    ? source.packages
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          registryType: stringOf(item.registryType),
          identifier: stringOf(item.identifier),
          version: stringOf(item.version),
          transport:
            item.transport && typeof item.transport === 'object'
              ? { type: stringOf((item.transport as Record<string, unknown>).type) }
              : undefined,
        }))
    : [];
  const remotes = Array.isArray(source.remotes)
    ? source.remotes
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          type: stringOf(item.type),
          url: stringOf(item.url),
        }))
    : [];
  return {
    name,
    ...(stringOf(source.title) ? { title: stringOf(source.title) } : {}),
    ...(stringOf(source.description) ? { description: stringOf(source.description) } : {}),
    ...(stringOf(source.version) ? { version: stringOf(source.version) } : {}),
    ...(packages.length ? { packages } : {}),
    ...(remotes.length ? { remotes } : {}),
    ...(source.repository && typeof source.repository === 'object'
      ? { repository: { url: stringOf((source.repository as Record<string, unknown>).url) } }
      : {}),
  };
}

export async function fetchRegistryServers(opts: RegistrySearchOptions): Promise<RegistryServer[]> {
  const raw = opts.baseUrl.replace(/\/+$/, '');
  const url = new URL(raw.endsWith('/v0/servers') ? raw : `${raw}/v0/servers`);
  if (opts.query) url.searchParams.set('search', opts.query);
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)))));
  await opts.assertUrl?.(url.toString());
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const res = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal });
  if (!res.ok) throw new Error(`MCP registry HTTP ${res.status}`);
  const data = (await res.json()) as { servers?: unknown[]; data?: unknown[] };
  const list = Array.isArray(data.servers) ? data.servers : Array.isArray(data.data) ? data.data : [];
  return list.map(normalizeRegistryServer).filter((item): item is RegistryServer => !!item);
}

export interface RegistryInstallCandidate {
  server: RegistryServer;
  cfg: ServerCfg;
  transport: 'stdio' | 'http';
  note?: string;
}

export function registryInstallCandidate(server: RegistryServer, allowPrivate = false): RegistryInstallCandidate | null {
  for (const pkg of server.packages ?? []) {
    if (pkg.registryType !== 'npm' || !pkg.identifier) continue;
    if (pkg.transport?.type && pkg.transport.type !== 'stdio') continue;
    const ref = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
    if (!PACKAGE_REF.test(ref)) return null;
    return {
      server,
      transport: 'stdio',
      cfg: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', ref],
        approval: true,
      },
      note: 'stdio 由 npx 启动；首次运行会下载 npm 包。',
    };
  }
  for (const remote of server.remotes ?? []) {
    if (!remote.url) continue;
    let url: URL;
    try {
      url = new URL(remote.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return null;
    return {
      server,
      transport: 'http',
      cfg: {
        type: 'http',
        url: remote.url,
        approval: true,
        ...(allowPrivate ? { allowPrivate: true } : {}),
      },
      note: remote.type ? `remote 传输类型：${remote.type}` : undefined,
    };
  }
  return null;
}
