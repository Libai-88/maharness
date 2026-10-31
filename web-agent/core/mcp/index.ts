/**
 * core/mcp/index.ts —— MCP 客户端插件（接入 MCP 生态：filesystem/github/memory 等外部工具）
 *
 * 2026 共识：MCP（Model Context Protocol）已是 agent 工具生态的事实标准
 * （42% 采用率、Linux Foundation 治理、2026-07-28 规范转 stateless HTTP）。
 * maharness 自研插件体系不必重造生态——本插件作为 MCP client，把远程工具
 * 拉进能力注册表，与自研工具同享 Agent 循环/审批/Trace/缓存。
 *
 * 自研（零依赖，符合项目「全部自研」信条）：JSON-RPC 2.0 客户端，支持两种传输：
 *  - stdio：spawn 本地进程（推荐——filesystem/github 等绝大多数 MCP server 为 stdio）；
 *  - http ：stateless HTTP POST（2026-07-28 新规范的请求/响应形态）。
 *
 * 配置（config.json 或运行时）：mcp.servers = {
 *   "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *   "github":     { "type": "http",  "url": "https://mcp.example.com/mcp", "env": { "GITHUB_TOKEN": "ghp_…" } },
 *   "local":      { "type": "http",  "url": "http://127.0.0.1:8080/mcp", "allowPrivate": true }  // 本机端点需显式放行
 * }
 * server 需要凭据 → 写进该 server 的 `env`（不要开 inheritEnv）；不需要审批 → 写 `approval: false`（风险自担）。
 *
 * 安全边界（A4，默认拒绝模型）：
 *  1. env 最小透传：stdio 子进程默认只拿到"能跑起来"的运行必需变量（见 ENV_ALLOWLIST，
 *     大小写不敏感），父进程的 *_API_KEY / *_PROXY / AGENT_* / 连接串等一律不外泄；
 *     server 需要的凭据走 cfg.env 显式声明（唯一正道）。cfg.inheritEnv: true 为
 *     向后兼容逃生口 = 全量透传，属高风险配置，只在确有依赖时使用。
 *  2. 默认需审批：MCP 工具 approval 默认 true（内核没有"按 risk 自动挂起"机制，
 *     risk 标签不是防护，唯一门是 approval/assessApproval）。cfg.approval: false 显式关闭。
 *  3. HTTP 传输同 search/providers 做协议 + 私网 SSRF 校验；本机/内网端点需显式
 *     cfg.allowPrivate: true 或 AGENT_ALLOW_PRIVATE_URLS=1。
 *  4. win32 回收整棵进程树（taskkill /T /F）——npx/cmd 包装下真正干活的是孙进程。
 *
 * 远程工具调用结果统一包装为 {ok, data:{text, server, tool}}，错误回填给 LLM。
 * 生命周期：连接/工具注册全部入可逆效应作用域——插件停用/重载时子进程自动关闭、工具自动消失。
 */
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Plugin, ToolContext, ToolDef } from '../../kernel/types';

/**
 * MCP 协议版本——**单一事实源**（stdio 的 initialize 与 HTTP 的 Mcp-Protocol-Version
 * 头必须同值，否则同一份配置走不同传输会得到不同的协商结果）。
 * 取 2026-07-28：现行规范修订（stateless 化），与本文件头部认定一致。
 * @see https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

// ============ 配置与状态 ============

export interface ServerCfg {
  type: 'stdio' | 'http';
  /** stdio：启动命令（如 npx / node / python） */
  command?: string;
  args?: string[];
  /** 显式传给 server 进程的变量（server 凭据的唯一正道，不受白名单限制） */
  env?: Record<string, string>;
  /**
   * 高风险逃生口：true = 把父进程**全部**环境变量透传给 stdio 子进程（旧行为）。
   * 仅在某个 server 确实依赖白名单外的变量时开启；默认 false（最小透传）。
   */
  inheritEnv?: boolean;
  /** http：stateless MCP 端点 URL */
  url?: string;
  /** 该 server 的全部工具是否要求用户审批。**默认 true**；显式 false = 关闭审批（风险自担） */
  approval?: boolean;
  /** http：显式放行本机/内网端点（等价于全局 AGENT_ALLOW_PRIVATE_URLS=1，但作用域只到本 server） */
  allowPrivate?: boolean;
}

// ============ 安全辅助（A4；导出仅为可测性，见 core/mcp/tests/security.spec.ts） ============

/**
 * stdio 子进程默认透传的变量白名单（**小写比对，大小写不敏感**）。
 * 判据：缺它子进程跑不起来，或它本身无凭据价值。密钥/代理/内核配置一律不在此列，
 * 需要时走 cfg.env 显式声明。Windows 上 npx/cmd 的可执行文件解析靠 PATH + PATHEXT，
 * node 的 DNS/加密子系统靠 SystemRoot/WINDIR，cmd 靠 COMSPEC——均为运行必需。
 */
const ENV_ALLOWLIST = new Set([
  // --- 进程/可执行文件解析（win32 起 npx 的关键）---
  'path', 'pathext', 'comspec', 'systemroot', 'windir', 'systemdrive',
  // --- 用户/临时目录（npm/node/python 写缓存与读配置）---
  'home', 'userprofile', 'homedrive', 'homepage', 'temp', 'tmp',
  'appdata', 'localappdata', 'allusersprofile', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432',
  // --- 语言/时区/终端（输出编码与排序）---
  'lang', 'lc_all', 'lc_messages', 'lc_numeric', 'tz', 'term', 'terminfo',
  // --- Linux/macOS 桌面与 XDG 目录（playwright 类 server 需要 DISPLAY）---
  'display', 'wayland_display', 'xdg_config_home', 'xdg_data_home', 'xdg_cache_home', 'xdg_runtime_dir',
]);

/**
 * 构造 stdio 子进程的 env（纯函数，不碰 process.env 之外的世界）。
 *  - 默认：只透传 ENV_ALLOWLIST 命中的变量（保留父进程原始大小写键名）+ cfg.env；
 *  - cfg.inheritEnv === true：全量透传（向后兼容逃生口）+ cfg.env 覆盖。
 * 导出仅为可测性：security.spec.ts 需在不真实 spawn 的前提下断言透传集合。
 */
export function buildSpawnEnv(
  cfg: ServerCfg,
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    if (v !== undefined) extra[k] = String(v);
  }
  if (cfg.inheritEnv) return { ...(parentEnv as Record<string, string>), ...extra };
  const picked: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (!ENV_ALLOWLIST.has(lower) || seen.has(lower)) continue; // 同名多大小写时取先出现者
    seen.add(lower);
    picked[key] = value;
  }
  return { ...picked, ...extra };
}

/**
 * MCP 工具审批门判定（纯函数）。内核里没有"按 risk 自动挂起"的机制——唯一门是
 * `approval` / `assessApproval`，所以 risk 标签不构成防护：默认必须要求审批。
 * 逃生口：cfg.approval === false（严格 false，缺失/true 都需要审批）。
 * 导出仅为可测性。
 */
export function assessApprovalGate(
  cfg: Pick<ServerCfg, 'approval'>,
  toolName = '',
): { approval: boolean; needsApproval: boolean; reason: string } {
  const approval = cfg.approval !== false;
  return {
    approval,
    needsApproval: approval,
    reason: approval
      ? `MCP 外部工具${toolName ? `「${toolName}」` : ''}默认需用户审批（外部 server 的代码/数据不受本内核约束）`
      : '',
  };
}

/**
 * win32 下杀进程树所需的 taskkill 参数；非 win32 或无 pid → null（维持 proc.kill() 现状）。
 * 与 core/powershell/index.ts 超时回收用的是同一做法：`npx`→`node` 的孙进程不随父退出。
 * 导出仅为可测性（测试不真实 spawn）。
 */
export function taskkillArgs(
  platform: NodeJS.Platform | string,
  pid: number | undefined,
): string[] | null {
  if (platform !== 'win32' || !pid || pid <= 0) return null;
  return ['/PID', String(pid), '/T', '/F'];
}

/** IPv4 私网/环回/链路本地/保留段判定（入参为四段数字） */
function isPrivateV4Octets(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 无法解析 → fail closed
  const [a = 0, b = 0, c = 0] = o;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)   // 100.64.0.0/10 CGNAT（Tailscale 等）
    || (a === 169 && b === 254)             // 链路本地（云 metadata 169.254.169.254）
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)    // 192.0.0.0/24 IETF 协议分配
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 基准测试
    || a >= 224;                             // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
}

/** 把 IPv6 文本展开成 8 组 16 位数（支持 :: 压缩与末尾内嵌 IPv4 点分形式） */
function v6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase().split('%')[0] ?? ''; // 丢弃 zone id（fe80::1%eth0）
  const mapped = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) { // ::ffff:127.0.0.1 → ::ffff:7f00:1（与 WHATWG URL 规范化后的形态统一）
    const o = mapped[1]!.split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = [((o[0]! << 8) | o[1]!).toString(16), ((o[2]! << 8) | o[3]!).toString(16)];
    s = s.slice(0, s.length - mapped[1]!.length) + hex.join(':');
  }
  const toNums = (gs: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out.length === 8 ? out : null;
  };
  const dbl = s.indexOf('::');
  if (dbl >= 0) {
    const head = s.slice(0, dbl).split(':').filter(Boolean);
    const tail = s.slice(dbl + 2).split(':').filter(Boolean);
    if (head.length + tail.length > 7) return null;
    return toNums([...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]);
  }
  return toNums(s.split(':'));
}

/**
 * 判断地址是否为"内网/环回/链路本地/保留"（决定拒绝连接）。
 * 覆盖 A3/A5 同族绕过：`::ffff:7f00:1`（= 127.0.0.1）、`::ffff:a9fe:a9fe`（云 metadata）、
 * 6to4（2002::/16）、NAT64（64:ff9b::/96）、Teredo（2001::/32）内嵌 IPv4 全部还原后再判；
 * 只有 2000::/3 全局单播算公网——**解析不了就按私网拒绝（fail closed）**。
 * 导出仅为可测性。
 */
export function isPrivateHostAddress(addr: string): boolean {
  const a = (addr ?? '').replace(/^\[+|\]+$/g, '').trim().toLowerCase();
  if (!a) return true;
  if (!a.includes(':')) {
    const o = a.split('.').map(Number);
    return o.length !== 4 ? true : isPrivateV4Octets(o);
  }
  const g = v6Groups(a);
  if (!g) return true;                                     // 非法/片段形式 → 拒绝（A3 的 7f00:1 落这里）
  const octetsFrom = (hi: number, lo: number) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
  const zeroHead = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (zeroHead && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4Octets(octetsFrom(g[6]!, g[7]!)); // ::ffff:/96 与 ::/96
  if (g[0] === 0 && g[1] === 0) return true;                // ::/8（含 ::1、未指定地址）
  if (g[0] === 0x2002) return isPrivateV4Octets(octetsFrom(g[1]!, g[2]!)); // 6to4 2002::/16 内嵌 IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true;           // Teredo 2001:0000::/32
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateV4Octets(octetsFrom(g[6]!, g[7]!));     // NAT64 64:ff9b::/96
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true;             // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true;             // 链路本地 fe80::/10
  if ((first & 0xff00) === 0xff00) return true;             // 组播 ff00::/8
  return (first & 0xe000) !== 0x2000;                        // 非 2000::/3 全局单播 → 保留段，拒绝
}

/**
 * MCP HTTP 端点校验：仅 http/https，且拒绝解析到内网/环回/链路本地（与 search、
 * providers 两处防护对齐）。放行本机端点的逃生口：cfg.allowPrivate 或 AGENT_ALLOW_PRIVATE_URLS=1。
 * 自带精简实现（不复用 server/routes/shared.ts，避免跨层耦合与写范围冲突）。
 * opts 仅为可测性注入（不联网、不打 DNS）。
 */
export async function assertSafeMcpUrl(
  raw: string,
  opts: { resolve?: (host: string) => Promise<string[]>; allowPrivate?: boolean } = {},
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('MCP url 地址格式无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`仅支持 http/https（当前 ${u.protocol}）`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('MCP url 缺少主机名');
  const allowPrivate = opts.allowPrivate ?? process.env.AGENT_ALLOW_PRIVATE_URLS === '1';
  if (isIP(host)) {
    if (!allowPrivate && isPrivateHostAddress(host)) throw new Error('拒绝访问内网/回环/链路本地地址');
    return u;
  }
  if (host === 'localhost' || /\.(localhost|internal|local|home\.arpa)$/i.test(host)) {
    throw new Error('拒绝访问内网主机名');
  }
  if (allowPrivate) return u;
  const resolve = opts.resolve
    ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  const addrs = await resolve(host);
  if (!addrs.length) throw new Error('MCP url 域名无法解析');
  if (addrs.some((addr) => isPrivateHostAddress(addr))) throw new Error('域名解析到内网地址（SSRF 拦截）');
  return u;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

interface McpConnection {
  initialize(): Promise<void>;
  toolsList(): Promise<McpToolDef[]>;
  toolsCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): void;
}

interface ServerStatus {
  state: 'connected' | 'error';
  tools: number;
  error?: string;
}

// ============ stdio 传输（JSON-RPC 2.0 over stdio） ============

/** pending 条目携带超时 timer：settle 即 clearTimeout（不再让 timer 滞留到触发时刻） */
interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// ============ stdio 启动计划（缺陷 B18：Windows 上 npx 是 .cmd 垫片） ============

/** cmd.exe / CreateProcess 层的参数引号：含空格或命令分隔符的参数必须整体加引号，
 *  内部双引号按 CreateProcess 语义转义（`\"`）。 */
function quoteCmdArg(s: string): string {
  return /["\s&|^<>)]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export interface SpawnPlan { file: string; args: string[]; shell: boolean }

/** 决定如何 spawn 一个 stdio MCP server（缺陷 B18）。
 *
 * 真实故障：Windows 上 `npx` / `npm` / `yarn` 都是 `.cmd` 垫片，而 Node 自 CVE-2024-27980
 * 起**禁止不带 shell 启动 .bat/.cmd**——实测 `spawn('npx')` → ENOENT（PATH 上只有 .cmd 没有
 * .exe）、`spawn('npx.cmd')` → EINVAL。于是 `config.example.json` 里推荐的
 * `npx -y @modelcontextprotocol/server-filesystem` 在 Windows 上**根本起不来**，
 * 报错还只是笼统一句"进程启动失败"。
 *
 * 对策：Windows 上非 `.exe` 的命令一律经 cmd.exe 解析（`shell:true`），且由我们**自己**
 * 组装命令行（args 传空数组）——不把用户参数交给 Node 去拼，引号规则可控。
 * 安全边界：命令行内容全部来自用户自己写的 `mcp.servers` 配置（非模型可控），
 * 因此不构成注入面；配置他人 server 的命令本身就是一个"允许它在你机器上跑"的决定。 */
export function buildSpawnPlan(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  if (platform !== 'win32') return { file: cmd, args, shell: false };
  if (/\.exe$/i.test(cmd)) return { file: cmd, args, shell: false };
  return { file: [cmd, ...args].map(quoteCmdArg).join(' '), args: [], shell: true };
}

export class StdioConnection implements McpConnection {
  private proc: ReturnType<typeof spawn> | null = null;
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private buf = '';
  private closed = false;

  constructor(private name: string, private cfg: ServerCfg) {}

  private write(obj: unknown): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  async initialize(): Promise<void> {
    const cmd = this.cfg.command;
    if (!cmd) throw new Error('stdio server 缺少 command');
    const env = buildSpawnEnv(this.cfg);
    if (this.cfg.inheritEnv) {
      console.warn(`[mcp:${this.name}] inheritEnv=true：父进程全部环境变量透传给该 server（凭据外泄风险，请确认 server 可信）`);
    }
    const plan = buildSpawnPlan(cmd, this.cfg.args ?? []);
    this.proc = spawn(plan.file, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
      shell: plan.shell,
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const s = String(chunk).trim();
      if (s) console.warn(`[mcp:${this.name}] stderr: ${s.slice(0, 300)}`);
    });
    this.proc.on('error', (err) => this.failAll(new Error(
      `进程启动失败: ${err.message}`
      + (plan.shell ? `（已经 cmd.exe 解析，命令行：${String(plan.file).slice(0, 160)}）` : '')
      + ((err as NodeJS.ErrnoException).code === 'ENOENT' ? '——请确认命令已安装且在 PATH 上' : ''),
    )));
    this.proc.on('exit', (code) => this.failAll(new Error(`进程退出 code=${code}`)));
    const v = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'maharness', version: '0.1.0' },
    });
    const agreed = (v as { protocolVersion?: string } | undefined)?.protocolVersion;
    this.notify('notifications/initialized', {});
    console.log(`[mcp:${this.name}] 已连接（协议 ${agreed ?? '未知'}）`);
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC 错误'));
        else p.resolve(msg.result);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('MCP 请求已取消'));
        return;
      }
      const id = this.nextId++;
      const entry: PendingEntry = { resolve, reject, signal };
      this.pending.set(id, entry);
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      };
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          cleanup();
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30_000);
      timer.unref?.();
      entry.timer = timer;
      entry.onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { requestId: id } });
        reject(new Error('MCP 请求已取消'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
      p.reject(err);
    }
    this.pending.clear();
  }

  async toolsList(): Promise<McpToolDef[]> {
    const r = (await this.request('tools/list', {})) as { tools?: McpToolDef[] };
    return r.tools ?? [];
  }

  async toolsCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = (await this.request('tools/call', { name, arguments: args }, signal)) as McpCallResult;
    return r ?? {};
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('连接已关闭'));
    // Windows 下 `npx`→`node` 是孙进程，proc.kill() 只杀直接子进程，孙进程滞留；
    // 与 core/powershell/index.ts 的超时回收一致，用 taskkill /T /F 杀整棵进程树。
    const args = taskkillArgs(process.platform, this.proc?.pid);
    if (args) {
      try { spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }); } catch { /* 忽略 */ }
    }
    try { this.proc?.kill(); } catch { /* 忽略 */ }
    this.proc = null;
  }
}

// ============ http 传输（stateless POST，2026-07-28 规范形态） ============

export class HttpConnection implements McpConnection {
  private validatedUrl?: string;

  constructor(private name: string, private cfg: ServerCfg) {}

  /**
   * 端点校验（每次调用都过一遍，结果按 url 记忆，避免重复 DNS）：
   * 与 search（core/search/index.ts assertPublicUrl）、providers（server/routes/shared.ts
   * assertPublicHttpUrl）同款防护——不校验则本传输是直连内网的旁路（SSRF）。
   */
  private async safeUrl(): Promise<string> {
    const raw = this.cfg.url;
    if (!raw) throw new Error('http server 缺少 url');
    if (this.validatedUrl !== raw) {
      // undefined → 交由 assertSafeMcpUrl 回落全局 AGENT_ALLOW_PRIVATE_URLS 逃生口
      await assertSafeMcpUrl(raw, { allowPrivate: this.cfg.allowPrivate });
      this.validatedUrl = raw;
    }
    return raw;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const url = await this.safeUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': String(body.method ?? ''),
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify(body),
      // stateless 无会话可续，重定向一律不跟随：跟随机重定向会绕开上面的端点校验
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // stateless 响应 = JSON（兼容部分 server 返回 SSE 帧，取 data: 行）
    try { return JSON.parse(text); } catch {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      if (line) return JSON.parse(line.slice(5).trim());
      throw new Error('MCP HTTP 响应不是有效 JSON');
    }
  }

  async initialize(): Promise<void> {
    // stateless：先 server/discover 探测能力（新规范）；失败则回退 legacy initialize
    try {
      await this.post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    } catch {
      await this.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'maharness', version: '0.1.0' } } });
    }
    console.log(`[mcp:${this.name}] 已连接（http）`);
  }

  async toolsList(): Promise<McpToolDef[]> {
    const r = (await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as { result?: { tools?: McpToolDef[] } };
    return r.result?.tools ?? [];
  }

  async toolsCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = (await this.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, signal)) as {
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
    if (r.error) throw new Error(r.error.message ?? 'MCP 调用错误');
    return r.result ?? {};
  }

  close(): void { /* http 无长连接 */ }
}

// ============ 工具包装 ============

/** 工具名净化：MCP 工具名可能含 . : 等字符 → 统一为 [a-z0-9_-] 的合法函数名 */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function contentToText(content: McpCallResult['content']): string {
  return (content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type ?? 'data'} 内容已省略]`))
    .filter(Boolean)
    .join('\n');
}

/**
 * 导出仅为可测性：security.spec.ts 需断言产出的 ToolDef 默认带 approval === true，
 * 而真实 spawn/连网才能走到这条路径。插件内部仍按原样调用。
 */
export function wrapMcpTool(serverName: string, mt: McpToolDef, conn: McpConnection, cfg: ServerCfg): ToolDef {
  const toolName = `mcp_${sanitize(serverName)}_${sanitize(mt.name)}`;
  const gate = assessApprovalGate(cfg, `${serverName}/${mt.name}`);
  const base: ToolDef = {
    name: toolName,
    description: `${mt.description ?? `调用 MCP server ${serverName} 的 ${mt.name} 工具`}（来源: MCP server「${serverName}」）`,
    parameters: mt.inputSchema ?? { type: 'object', properties: {} },
    risk: 'medium',
    // A4：默认要求审批——内核没有"按 risk 自动挂起"机制，risk 标签只是给 LLM 看的提示，
    // 不是防护；唯一门是 approval/assessApproval。cfg.approval: false 才是显式关闭。
    approval: gate.approval,
    costHint: 'medium',
    output: '{text, server, tool}',
    limits: gate.approval
      ? '外部 MCP 工具：每次调用都需用户审批'
      : '外部 MCP 工具：配置已显式关闭审批（approval:false），调用无需确认——仅对可信 server 使用',
    handler: async (args: unknown, tctx: ToolContext) => {
      try {
        const res = await conn.toolsCall(mt.name, (args ?? {}) as Record<string, unknown>, tctx.signal);
        const text = contentToText(res.content);
        if (res.isError) return { ok: false, error: text || `MCP 工具 ${mt.name} 执行失败` };
        return { ok: true, data: { text, server: serverName, tool: mt.name } };
      } catch (err) {
        return { ok: false, error: `MCP 调用失败 [${serverName}/${mt.name}]: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
  return base;
}

// ============ 插件 ============

export default {
  id: 'mcp',
  name: 'MCP 客户端',
  version: '0.1.0',
  async onLoad(ctx) {
    const servers = ctx.config.get<Record<string, ServerCfg>>('mcp.servers', {});
    const statuses = new Map<string, ServerStatus>();
    const connections = new Map<string, McpConnection>();

    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (!cfg || (cfg.type !== 'stdio' && cfg.type !== 'http')) continue;
      let conn: McpConnection | undefined;
      try {
        conn = cfg.type === 'stdio' ? new StdioConnection(name, cfg) : new HttpConnection(name, cfg);
        await conn.initialize();
        const tools = await conn.toolsList();
        for (const mt of tools) {
          ctx.register({ kind: 'tool', tool: wrapMcpTool(name, mt, conn, cfg) });
        }
        connections.set(name, conn);
        // 可逆效应：插件停用/重载时关闭连接、工具随作用域自动消失
        ctx.effect<void>(() => undefined, () => () => { conn?.close(); });
        statuses.set(name, { state: 'connected', tools: tools.length });
        ctx.logger.info(`MCP server「${name}」已连接，注册 ${tools.length} 个工具`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 初始化/工具列表失败也回收连接：stdio 子进程可能已 spawn（超时/部分失败），
        // 不 close 则进程滞留（close 内有 proc.kill）
        try { conn?.close(); } catch { /* 忽略 */ }
        statuses.set(name, { state: 'error', tools: 0, error: msg });
        console.warn(`[mcp] server「${name}」连接失败（不影响其他 server/插件）: ${msg.slice(0, 200)}`);
      }
    }

    // ---- 可观测：mcp_status 工具（server 状态 / 工具数 / 错误） ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'mcp_status',
        risk: 'low',
        costHint: 'low',
        output: '{servers: [{name, state, tools, error}]}',
        description: '查看已配置的 MCP server 连接状态与工具数量（mcp_* 前缀的工具来自 MCP server）。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          const list = Object.entries(servers ?? {})
            .map(([name, cfg]) => ({
              name,
              type: cfg?.type ?? 'unknown',
              ...(statuses.get(name) ?? { state: 'error', tools: 0, error: '未尝试连接' }),
            }));
          return { ok: true, data: { count: list.length, servers: list } };
        },
      },
    });

    // ---- L2 人设：MCP 工具使用规则 ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'mcp-rules',
        name: 'MCP 工具使用规则',
        description: '约束 LLM 正确使用来自 MCP server 的外部工具',
        priority: 5,
        content: [
          'MCP 工具使用规则（mcp_ 前缀工具来自外部 MCP server）：',
          '1. mcp_* 工具是外部能力（文件系统/github/数据库等），用法与内置工具一致，但结果来自外部系统；',
          '2. 调用前按 mcp_status 确认 server 已连接；调用失败时说明 server 状态，不要反复重试；',
          '3. MCP 工具默认每次调用都弹审批卡片（外部 server 的代码与数据不受本内核约束），等待用户批准即可；',
          '4. 结果中的 text 是文本内容，按需引用；不要把外部工具结果当作内置工具的结果。',
        ].join('\n'),
      },
    });

    ctx.logger.info(
      Object.keys(servers ?? {}).length
        ? `MCP 客户端就绪（${connections.size}/${Object.keys(servers).length} 个 server 连接成功）`
        : 'MCP 客户端就绪（未配置 mcp.servers——在 config.json 添加后热重载本插件即可接入）',
    );
  },
} satisfies Plugin;
