/**
 * 插件进程文件系统守卫。
 *
 * 在子进程加载插件前包住 node:fs / node:fs.promises 的公开入口，把
 * runtime.filesystem 的 none/storage/sandbox 变成运行时可观察的拒绝。
 * 这不是 OS 级沙箱：原生扩展、直接系统调用或已持有的文件描述符仍可能绕过；
 * 真正的强边界仍应由独立账户/容器/文件 ACL 负责。
 */
import fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

export type PluginFilesystemMode = 'none' | 'storage' | 'sandbox' | 'full';

export interface PluginFilesystemPolicy {
  mode: PluginFilesystemMode;
  storageDir: string;
  /** sandbox 模式允许的工作区根 */
  sandboxRoot?: string;
  /** 始终允许只读的根（默认插件自身目录，用于读取资产） */
  readOnlyRoots?: string[];
}

type Operation = 'read' | 'write';

function canonicalPath(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function within(target: string, root: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isFilesystemAllowed(target: string, policy: PluginFilesystemPolicy, op: Operation): boolean {
  if (policy.mode === 'full') return true;
  const candidate = canonicalPath(target);
  if (within(candidate, policy.storageDir)) return true;
  for (const root of policy.readOnlyRoots ?? []) {
    if (op === 'read' && within(candidate, root)) return true;
  }
  if (policy.mode === 'sandbox' && policy.sandboxRoot && within(candidate, policy.sandboxRoot)) return true;
  return false;
}

function pathOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return null;
}

function deny(target: string, op: Operation): never {
  throw new Error(`插件文件系统访问被策略拒绝（${op}）: ${target}`);
}

function assertPath(value: unknown, policy: PluginFilesystemPolicy, op: Operation): void {
  const target = pathOf(value);
  if (target && !isFilesystemAllowed(target, policy, op)) deny(target, op);
}

function wrapOne(
  holder: Record<string, unknown>,
  name: string,
  policy: PluginFilesystemPolicy,
  op: Operation | ((args: unknown[]) => Operation),
): void {
  const original = holder[name];
  if (typeof original !== 'function') return;
  holder[name] = function (this: unknown, ...args: unknown[]) {
    const resolvedOp = typeof op === 'function' ? op(args) : op;
    assertPath(args[0], policy, resolvedOp);
    return Reflect.apply(original as (...input: unknown[]) => unknown, this, args);
  };
}

function wrapTwo(
  holder: Record<string, unknown>,
  name: string,
  policy: PluginFilesystemPolicy,
  firstOp: Operation,
  secondOp: Operation,
): void {
  const original = holder[name];
  if (typeof original !== 'function') return;
  holder[name] = function (this: unknown, ...args: unknown[]) {
    assertPath(args[0], policy, firstOp);
    assertPath(args[1], policy, secondOp);
    return Reflect.apply(original as (...input: unknown[]) => unknown, this, args);
  };
}

const READ_ONLY = [
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'accessSync',
  'access',
  'existsSync',
  'realpathSync',
  'realpath',
  'createReadStream',
  'watch',
  'watchFile',
] as const;

const WRITE_ONLY = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'mkdirSync',
  'mkdir',
  'rmSync',
  'rm',
  'unlinkSync',
  'unlink',
  'rmdirSync',
  'rmdir',
  'createWriteStream',
  'truncateSync',
  'truncate',
  'chmodSync',
  'chmod',
  'utimesSync',
  'utimes',
  'mkdtempSync',
  'mkdtemp',
] as const;

const TWO_PATH = [
  ['renameSync', 'write', 'write'],
  ['rename', 'write', 'write'],
  ['copyFileSync', 'read', 'write'],
  ['copyFile', 'read', 'write'],
  ['linkSync', 'read', 'write'],
  ['link', 'read', 'write'],
  ['symlinkSync', 'read', 'write'],
  ['symlink', 'read', 'write'],
  ['cpSync', 'read', 'write'],
  ['cp', 'read', 'write'],
] as const;

let installed = false;

export function installFilesystemGuard(policy: PluginFilesystemPolicy): void {
  if (installed || policy.mode === 'full') return;
  installed = true;
  const holder = fs as unknown as Record<string, unknown>;
  for (const name of READ_ONLY) wrapOne(holder, name, policy, 'read');
  for (const name of WRITE_ONLY) wrapOne(holder, name, policy, 'write');
  for (const [name, first, second] of TWO_PATH) wrapTwo(holder, name, policy, first, second);
  // open 的读写取决于 flags；无法判定时按写处理（fail-closed）。
  wrapOne(holder, 'openSync', policy, (args) => (/[wa+]/.test(String(args[1] ?? 'r')) ? 'write' : 'read'));
  wrapOne(holder, 'open', policy, (args) => (/[wa+]/.test(String(args[1] ?? 'r')) ? 'write' : 'read'));

  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of READ_ONLY) wrapOne(promises, name, policy, 'read');
  for (const name of WRITE_ONLY) wrapOne(promises, name, policy, 'write');
  for (const [name, first, second] of TWO_PATH) wrapTwo(promises, name, policy, first, second);
  wrapOne(promises, 'open', policy, (args) => (/[wa+]/.test(String(args[1] ?? 'r')) ? 'write' : 'read'));

  syncBuiltinESMExports();
}
