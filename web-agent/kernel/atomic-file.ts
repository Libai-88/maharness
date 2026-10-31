import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** Fault-injection seam after the complete temp file is flushed and before commit. */
  beforeRename?: (tempPath: string, targetPath: string) => void;
  /** Expected content revision; checked again immediately before the atomic rename. */
  expectedRevision?: string;
}

export class ConcurrentWriteError extends Error {
  readonly code = 'concurrent_write';
  constructor(readonly targetPath: string, readonly expectedRevision: string, readonly actualRevision: string) {
    super(`目标文件已被其他进程修改：${targetPath}`);
    this.name = 'ConcurrentWriteError';
  }
}

/** Stable content revision for optimistic file writes; missing files use a fixed sentinel. */
export function fileRevisionSync(targetPath: string): string {
  if (!existsSync(targetPath)) return 'missing';
  let bytes: Buffer;
  try { bytes = readFileSync(targetPath); }
  catch { if (!existsSync(targetPath)) return 'missing'; throw new Error(`无法读取目标文件版本：${targetPath}`); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${digest}`;
}

/** Replace a file with a flushed same-directory temp file; failures leave the old target intact. */
export function atomicWriteFileSync(targetPath: string, content: string, options: AtomicWriteOptions = {}): void {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : 0o600;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', mode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.beforeRename?.(tempPath, targetPath);
    if (options.expectedRevision !== undefined) {
      const actualRevision = fileRevisionSync(targetPath);
      if (actualRevision !== options.expectedRevision) {
        throw new ConcurrentWriteError(targetPath, options.expectedRevision, actualRevision);
      }
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the write/commit error */ }
    }
    try { rmSync(tempPath, { force: true }); } catch { /* preserve the write/commit error */ }
    throw error;
  }
}
