/**
 * kernel/sandbox.ts —— 沙箱安全基础设施（从 core/tools-fs 上提）
 * 纯路径操作 + 安全策略，零插件依赖。server 层和 core 插件共同使用。
 */
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';

// ============ 路径沙箱 ============

/** 将相对路径解析到沙箱内；越界（含 .. 穿越、符号链接逃逸）一律拒绝。
 *  realpath 强化：校验通过后返回真实路径，消除 TOCTOU 窗口。 */
export function resolveInSandbox(sandboxRoot: string, relPath: string): string {
  const root = resolve(sandboxRoot);
  const target = resolve(root, relPath || '.');
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
    throw new Error(`路径越界（沙箱根目录: ${root}）: ${relPath}`);
  }
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      const real = resolveSync(current);
      const realLower = real.toLowerCase();
      if (realLower !== rootLower && !realLower.startsWith(rootLower + sep)) {
        throw new Error(`路径指向沙箱外（符号链接）: ${relPath}`);
      }
      const tail = relative(current, target);
      return tail ? join(real, tail) : real;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return target;
}

/** 相对沙箱根的规范化相对路径（小写 + 正斜杠） */
function normalizedRel(absPath: string, sandboxRoot: string): string {
  return relative(resolve(sandboxRoot), resolve(absPath)).split(sep).join('/').toLowerCase();
}

function resolveSync(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

// ============ 内核硬保护（C-R4） ============

let allowCoreEditCache: boolean | null = null;

/** kernel/ 与 core/chat/ 为 agent 运行时核心：写/删一律拒绝 */
export function isProtectedWritePath(absPath: string, sandboxRoot: string): boolean {
  if (allowCoreEditCache === null) allowCoreEditCache = process.env.AGENT_ALLOW_CORE_EDIT === '1';
  if (allowCoreEditCache) return false;
  const norm = normalizedRel(absPath, sandboxRoot);
  return norm === 'kernel' || norm.startsWith('kernel/')
    || norm === 'core/chat' || norm.startsWith('core/chat/');
}

// ============ 密钥黑名单（C-S4/H10） ============

/** .env 与 data/ 不可读 */
export function isDeniedReadPath(absPath: string, sandboxRoot: string): boolean {
  const norm = normalizedRel(absPath, sandboxRoot);
  if (!norm || norm.startsWith('../')) return false;
  if (norm === '.env' || norm.endsWith('/.env')) return true;
  return norm === 'data' || norm.startsWith('data/');
}

// ============ 智能读取（编码识别） ============

export interface ReadResult {
  text: string;
  encoding: string;
  isBinary: boolean;
  size: number;
  path: string;
  truncated?: boolean;
}

/** 读取文本文件，自动识别编码（UTF-8/UTF-16/GBK/二进制） */
export function readTextSmart(filePath: string): { text: string; encoding: string; isBinary: boolean } {
  const buf = readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8(BOM)', isBinary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', isBinary: false };
  }
  if (buf.includes(0)) return { text: '', encoding: 'binary', isBinary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', isBinary: false };
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', isBinary: false };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'utf-8(宽松)', isBinary: false };
    }
  }
}
