import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../../kernel/plugin-sdk';

interface CommandState { id: string; owner: string; status: 'running' | 'stopping' | 'exited' | 'cancelled' | 'failed'; exitCode: number | null; output: string; error?: string; outputLimited?: boolean }
export function isolatedProcessEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
}
export class CommandProcesses {
  private processes = new Map<string, { state: CommandState; process: ChildProcess; done: Promise<void>; stop: () => void }>();
  constructor(private readonly persist: (id: string, state: CommandState) => void, private readonly load: (id: string) => CommandState | undefined, private readonly capacity = 16, private readonly maxOutput = 4 * 1024 * 1024) {}
  private owner(ctx: ToolContext) { return `${ctx.tenantId ?? 'default'}:${ctx.runId ?? ctx.sessionId ?? ctx.traceId}`; }
  start(command: string, ctx: ToolContext) {
    if (ctx.signal?.aborted) throw new Error('任务已取消');
    if (this.processes.size >= this.capacity) throw new Error(`后台进程容量已满（${this.capacity}）`);
    const id = randomUUID();
    const state: CommandState = { id, owner: this.owner(ctx), status: 'running', exitCode: null, output: '' };
    const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`], { cwd: ctx.sandboxRoot, windowsHide: true, ...(ctx.authorization?.frameworkChangeId ? { env: isolatedProcessEnvironment() } : {}) });
    let saveTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (process.pid && globalThis.process.platform === 'win32') spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { process.kill(); });
      else process.kill('SIGTERM');
    };
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer); saveTimer = undefined;
      try { this.persist(id, state); }
      catch {
        state.error = '命令状态保存失败，进程已请求终止；请核对实际操作结果';
        if (state.status === 'running') { state.status = 'stopping'; terminate(); }
      }
    };
    const stop = () => {
      if (state.status !== 'running') return;
      terminate();
      state.status = 'stopping'; save();
    };
    const onData = (data: string) => {
      const overLimit = data.length > this.maxOutput - state.output.length;
      state.output += data.slice(0, Math.max(0, this.maxOutput - state.output.length));
      if (overLimit) { state.outputLimited = true; state.error = `输出达到容量上限（${this.maxOutput} 字符），进程已请求终止`; stop(); }
      if (!saveTimer) { saveTimer = setTimeout(save, 100); saveTimer.unref(); }
    };
    process.stdout?.setEncoding('utf8'); process.stderr?.setEncoding('utf8');
    process.stdout?.on('data', onData); process.stderr?.on('data', onData);
    const done = new Promise<void>(resolve => {
      process.once('error', error => { state.status = 'failed'; state.error = error.message; save(); });
      process.once('close', code => {
        state.exitCode = code;
        state.status = state.status === 'stopping' ? (state.outputLimited ? 'failed' : 'cancelled') : state.status === 'failed' ? 'failed' : code === 0 ? 'exited' : 'failed';
        ctx.runSignal?.removeEventListener('abort', stop); save(); this.processes.delete(id); resolve();
      });
    });
    this.processes.set(id, { state, process, done, stop });
    ctx.runSignal?.addEventListener('abort', stop, { once: true });
    if (ctx.runSignal?.aborted) stop();
    save(); return { id, status: state.status };
  }
  read(id: string, ctx: ToolContext, offset = 0, limit = 8000) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('命令不存在');
    const live = this.processes.get(id); const state = live?.state ?? this.load(id);
    if (!state || state.owner !== this.owner(ctx)) throw new Error('命令不存在');
    const start = Math.max(0, Math.min(state.output.length, Math.floor(offset)));
    const end = Math.min(state.output.length, start + Math.max(1, Math.min(16000, Math.floor(limit))));
    return { id, status: !live && (state.status === 'running' || state.status === 'stopping') ? 'interrupted' : state.status, exitCode: state.exitCode, error: state.error, outputLimited: !!state.outputLimited, output: state.output.slice(start, end), offset: start, nextOffset: end, length: state.output.length, truncated: end < state.output.length || !!state.outputLimited };
  }
  async wait(id: string, ctx: ToolContext, timeoutMs: number) {
    this.read(id, ctx);
    const live = this.processes.get(id);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (ctx.signal?.aborted) throw new Error('等待已取消；命令状态可重新查询');
      if (live) await Promise.race([live.done, new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, Math.min(10000, Math.max(0, timeoutMs)));
        onAbort = () => reject(new Error('等待已取消；命令状态可重新查询'));
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
      })]);
    } finally { if (timer) clearTimeout(timer); if (onAbort) ctx.signal?.removeEventListener('abort', onAbort); }
    return this.read(id, ctx);
  }
  cancel(id: string, ctx: ToolContext) { this.read(id, ctx); this.processes.get(id)?.stop(); return this.read(id, ctx); }
  stopAll() { for (const command of this.processes.values()) command.stop(); }
}
