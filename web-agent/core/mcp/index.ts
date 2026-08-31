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
 *   "github":     { "type": "http",  "url": "http://localhost:8080/mcp" }
 * }
 *
 * 安全边界：MCP 工具以 server 自身凭据/权限运行（本地 stdio 进程 = 本地权限）。
 * 只连接可信 server；工具统一标 risk:medium（需审批的工具可在配置 approval:true）；
 * 远程工具调用结果统一包装为 {ok, data:{text, server, tool}}，错误回填给 LLM。
 * 生命周期：连接/工具注册全部入可逆效应作用域——插件停用/重载时子进程自动关闭、工具自动消失。
 */
import { spawn } from 'node:child_process';
import type { Plugin, ToolDef } from '../../kernel/types';

// ============ 配置与状态 ============

interface ServerCfg {
  type: 'stdio' | 'http';
  /** stdio：启动命令（如 npx / node / python） */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http：stateless MCP 端点 URL */
  url?: string;
  /** 该 server 的全部工具是否要求用户审批（默认 false；risk 恒为 medium） */
  approval?: boolean;
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
  toolsCall(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
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
}

class StdioConnection implements McpConnection {
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
    this.proc = spawn(cmd, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      windowsHide: true,
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const s = String(chunk).trim();
      if (s) console.warn(`[mcp:${this.name}] stderr: ${s.slice(0, 300)}`);
    });
    this.proc.on('error', (err) => this.failAll(new Error(`进程启动失败: ${err.message}`)));
    this.proc.on('exit', (code) => this.failAll(new Error(`进程退出 code=${code}`)));
    const v = await this.request('initialize', {
      protocolVersion: '2025-03-26',
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
        if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC 错误'));
        else p.resolve(msg.result);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry: PendingEntry = { resolve, reject };
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30_000);
      timer.unref?.();
      entry.timer = timer;
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async toolsList(): Promise<McpToolDef[]> {
    const r = (await this.request('tools/list', {})) as { tools?: McpToolDef[] };
    return r.tools ?? [];
  }

  async toolsCall(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = (await this.request('tools/call', { name, arguments: args })) as McpCallResult;
    return r ?? {};
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('连接已关闭'));
    try { this.proc?.kill(); } catch { /* 忽略 */ }
  }
}

// ============ http 传输（stateless POST，2026-07-28 规范形态） ============

class HttpConnection implements McpConnection {
  constructor(private name: string, private cfg: ServerCfg) {}

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const url = this.cfg.url;
    if (!url) throw new Error('http server 缺少 url');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': String(body.method ?? ''),
        'Mcp-Protocol-Version': '2026-07-28',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
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
      await this.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'maharness', version: '0.1.0' } } });
    }
    console.log(`[mcp:${this.name}] 已连接（http）`);
  }

  async toolsList(): Promise<McpToolDef[]> {
    const r = (await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as { result?: { tools?: McpToolDef[] } };
    return r.result?.tools ?? [];
  }

  async toolsCall(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = (await this.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })) as {
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

function wrapMcpTool(serverName: string, mt: McpToolDef, conn: McpConnection, cfg: ServerCfg): ToolDef {
  const toolName = `mcp_${sanitize(serverName)}_${sanitize(mt.name)}`;
  const base: ToolDef = {
    name: toolName,
    description: `${mt.description ?? `调用 MCP server ${serverName} 的 ${mt.name} 工具`}（来源: MCP server「${serverName}」）`,
    parameters: mt.inputSchema ?? { type: 'object', properties: {} },
    risk: 'medium',
    costHint: 'medium',
    output: '{text, server, tool}',
    handler: async (args: unknown) => {
      try {
        const res = await conn.toolsCall(mt.name, (args ?? {}) as Record<string, unknown>);
        const text = contentToText(res.content);
        if (res.isError) return { ok: false, error: text || `MCP 工具 ${mt.name} 执行失败` };
        return { ok: true, data: { text, server: serverName, tool: mt.name } };
      } catch (err) {
        return { ok: false, error: `MCP 调用失败 [${serverName}/${mt.name}]: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
  if (cfg.approval) base.approval = true;
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
          '3. 敏感操作（配置 approval 的 server）会触发用户审批，等待批准即可；',
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
