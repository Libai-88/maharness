/**
 * 最小 LSP 客户端：stdio JSON-RPC、按扩展名选择 server、懒启动。
 * 只实现导航所需能力（definition/hover/documentSymbol/diagnostics），
 * 不把 LSP 生命周期塞进内核；server 由管理员配置，属于本地受信进程。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensions: string[];
  initializationOptions?: Record<string, unknown>;
}

export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspDiagnostic {
  uri: string;
  severity?: number;
  message: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_HEADER = 64 * 1024;
const ENV_ALLOWLIST = new Set([
  'path', 'pathext', 'comspec', 'systemroot', 'windir', 'systemdrive',
  'home', 'userprofile', 'homedrive', 'homepage', 'temp', 'tmp',
  'appdata', 'localappdata', 'allusersprofile', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432',
  'lang', 'lc_all', 'tz',
]);

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (!ENV_ALLOWLIST.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out[key] = value;
  }
  return out;
}

export class LspClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);
  private initialized = false;
  private opened = new Set<string>();
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly cfg: LspServerConfig,
    private readonly root: string,
  ) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    if (!this.cfg.command || /[\r\n]/.test(this.cfg.command)) throw new Error(`LSP server ${this.name} command 非法`);
    if (this.cfg.args?.some((arg) => /[\r\n]/.test(arg))) throw new Error(`LSP server ${this.name} args 不得包含换行`);
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.root,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !/\.exe$/i.test(this.cfg.command),
      windowsHide: true,
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      if (process.env.DEBUG) process.stderr.write(`[lsp:${this.name}] ${chunk.toString()}`);
    });
    this.proc.on('exit', (code) => this.failAll(new Error(`LSP server ${this.name} exited code=${code}`)));
    const rootUri = pathToFileURL(this.root).href;
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
      ...(this.cfg.initializationOptions ? { initializationOptions: this.cfg.initializationOptions } : {}),
    }) as { capabilities?: unknown };
    if (!result || typeof result !== 'object') throw new Error(`LSP server ${this.name} initialize 返回非法`);
    this.notify('initialized', {});
    this.initialized = true;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) throw new Error(`LSP server ${this.name} 未连接`);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${this.name} ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buf.length > MAX_HEADER) this.buf = Buffer.alloc(0);
        return;
      }
      const header = this.buf.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.buf = this.buf.slice(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + length) return;
      const body = this.buf.slice(start, start + length).toString('utf8');
      this.buf = this.buf.slice(start + length);
      try { this.onMessage(JSON.parse(body)); } catch { /* 忽略坏帧 */ }
    }
  }

  private onMessage(message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`LSP ${this.name}: ${message.error.message ?? 'request failed'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) this.diagnosticsByUri.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private uriOf(file: string): string {
    return pathToFileURL(file).href;
  }

  private async open(file: string): Promise<string> {
    const uri = this.uriOf(file);
    if (!this.opened.has(uri)) {
      const text = readFileSync(file, 'utf8');
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.languageId(file), version: 1, text },
      });
      this.opened.add(uri);
    }
    return uri;
  }

  private languageId(file: string): string {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') return ext === '.tsx' ? 'typescriptreact' : 'typescript';
    if (ext === '.js' || ext === '.jsx') return ext === '.jsx' ? 'javascriptreact' : 'javascript';
    if (ext === '.py') return 'python';
    if (ext === '.go') return 'go';
    if (ext === '.rs') return 'rust';
    if (ext === '.java') return 'java';
    if (ext === '.cs') return 'csharp';
    return 'plaintext';
  }

  async definition(file: string, line: number, character: number): Promise<LspLocation[]> {
    await this.start();
    const uri = await this.open(file);
    const result = await this.request('textDocument/definition', {
      textDocument: { uri }, position: { line, character },
    }) as LspLocation | LspLocation[] | null;
    return result ? (Array.isArray(result) ? result : [result]) : [];
  }

  async hover(file: string, line: number, character: number): Promise<string> {
    await this.start();
    const uri = await this.open(file);
    const result = await this.request('textDocument/hover', {
      textDocument: { uri }, position: { line, character },
    }) as { contents?: unknown } | null;
    const contents = result?.contents;
    if (typeof contents === 'string') return contents;
    if (contents && typeof contents === 'object' && 'value' in contents) return String((contents as { value?: unknown }).value ?? '');
    if (Array.isArray(contents)) return contents.map((part) => typeof part === 'string' ? part : String((part as { value?: unknown })?.value ?? '')).join('\n');
    return '';
  }

  async diagnostics(file: string): Promise<LspDiagnostic[]> {
    await this.start();
    await this.open(file);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return this.diagnosticsByUri.get(this.uriOf(file)) ?? [];
  }

  pathOf(uri: string): string {
    try { return fileURLToPath(uri); } catch { return uri; }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try { await this.request('shutdown', {}, 2_000); } catch { /* 已退出 */ }
    try { this.notify('exit', {}); } catch { /* 忽略 */ }
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    setTimeout(() => { try { proc.kill(); } catch { /* 忽略 */ } }, 1_000);
    await exited;
    this.proc = undefined;
  }
}

export function pickLspServer(
  configs: Record<string, LspServerConfig>,
  file: string,
): { name: string; cfg: LspServerConfig } | undefined {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  for (const [name, cfg] of Object.entries(configs)) {
    if (Array.isArray(cfg.extensions) && cfg.extensions.map((item) => item.toLowerCase()).includes(ext)) return { name, cfg };
  }
  return undefined;
}
