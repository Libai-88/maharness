import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import type { DocumentContent } from '../../kernel/material';
import type { CreateSpec, Patch } from './formats';
import { ExecutionPool } from '../../kernel/execution-pool';
const workers = new ExecutionPool(2);

export interface DocumentService {
  read(bytes: Uint8Array, format: string, options?: { offset?: number; limit?: number; pages?: number[]; blockId?: string }, signal?: AbortSignal): Promise<DocumentContent>;
  create(spec: CreateSpec, signal?: AbortSignal): Promise<Buffer>;
  patch(bytes: Uint8Array, format: string, version: string, patches: Patch[], signal?: AbortSignal): Promise<Buffer>;
}
export async function workerJob<T>(job: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const release = await workers.acquire('document', signal);
  try { return await new Promise<T>((resolve, reject) => {
    // PDF's native canvas bindings on Windows cannot be safely terminated inside a worker thread.
    const pdf = job.format === 'pdf';
    const worker = pdf ? fork(new URL('./pdf-process.mjs', import.meta.url), [], { execArgv: ['--max-old-space-size=256'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }) : new Worker(new URL('./worker.mjs', import.meta.url), { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let finished = false;
    const finish = (error?: Error, value?: T) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if ('terminate' in worker) void worker.terminate(); else worker.kill();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error('文档处理已取消'));
    const timer = setTimeout(() => finish(new Error('文档处理超时')), 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { error?: string; result: T }) => finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`文档工作线程提前退出（${code}）`)); });
    if ('send' in worker) { worker.stderr?.resume(); worker.send(job); }
    if (signal?.aborted) abort();
  }); } finally { release(); }
}
export const documentService: DocumentService = {
  read: (bytes, format, options, signal) => workerJob({ action: 'read', bytes, format, ...options }, signal),
  create: async (spec, signal) => Buffer.from(await workerJob<Uint8Array>({ action: 'create', spec }, signal)),
  patch: async (bytes, format, version, patches, signal) => Buffer.from(await workerJob<Uint8Array>({ action: 'patch', bytes, format, version, patches }, signal)),
};
