/**
 * server/routes/shared.ts —— 路由层共享工具
 * 从原单文件 routes.ts 拆出：SSE 帧写入、chat 服务解析/热刷新、密钥掩码、
 * SSRF 边界校验、git/文件管理器执行等跨资源复用的帮助函数与公共类型。
 */
import type { Express } from 'express';
import type { Kernel } from '../../kernel';
import type { ProviderDef } from '../../kernel/types';
import type { AgentRunner } from '../../core/chat/agent';
import type { ProviderConfig } from '../../core/chat/provider';
import type { Store } from '../db';
import type { ClientTracker } from '../client-tracker';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Response } from 'express';
import { lookup } from 'node:dns/promises';

const execFileAsync = promisify(execFile);

/** 各资源路由文件的公共依赖（index.ts 装配时统一传入） */
export interface RouteDeps {
  kernel: Kernel;
  store: Store;
  tracker?: ClientTracker;
}

export interface ChatService {
  providers: ProviderDef[];
  runner: AgentRunner;
  setProviders: (cfgs: ProviderConfig[]) => void;
  setPersonas: (list: { name: string; content: string }[]) => void;
  getSystemPrompt: () => string;
  approveApproval: (approvalId: string, approved: boolean) => boolean;
}

export function getChatService(kernel: Kernel): ChatService | undefined {
  // 共效应解析（v2）：依赖注册表按 key 解析，只返回 ACTIVE 提供者的绑定——比扫描能力表更直接
  return kernel.plugins.resolveService('service:chat') as ChatService | undefined;
}

/** 用 DB 中的启用 Provider 刷新对话服务（热生效，无需重启） */
export function refreshChatProviders(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listProviders().filter((r) => r.enabled);
  chat.setProviders(rows.map((r) => ({
    id: r.id, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model,
    inputPrice: r.priceIn ?? undefined, outputPrice: r.priceOut ?? undefined,
  })));
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

// ---- H5 SSRF 防护：/api/providers/test 的 baseUrl 边界 ----

/** IPv4 私网/环回/链路本地段判定（0.0.0.0/8、10/8、127/8、169.254/16、172.16/12、192.168/16） */
function isPrivateV4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 无法解析 → 按私网拒绝
  const [a, b] = o;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

/** IPv6 环回 / ULA(fc00::/7) / 链路本地(fe80::/10) 判定（含 IPv4-mapped 形式） */
function isPrivateV6(addr: string): boolean {
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('::ffff:')) return isPrivateV4(addr.slice(7)); // ::ffff:10.0.0.1
  const head = addr.split(':')[0];
  const first = head === '' ? 0 : parseInt(head, 16); // '::xxx' 压缩形式首组为空 → 0
  if (Number.isNaN(first)) return true;
  return (first & 0xfe00) === 0xfc00   // fc00::/7 Unique Local Address
    || (first & 0xffc0) === 0xfe80;    // fe80::/10 Link-Local
}

/** 校验 baseUrl：协议仅 http/https；hostname DNS 解析后拒绝私网/环回/链路本地段 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('地址格式无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议');
  }
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.length === 0) throw new Error('域名无法解析');
  for (const { address } of addrs) {
    const isV6 = address.includes(':');
    if (isV6 ? isPrivateV6(address.toLowerCase()) : isPrivateV4(address)) {
      throw new Error('不允许连接内网/环回/链路本地地址');
    }
  }
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
