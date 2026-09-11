/**
 * kernel/plugin-snapshot.ts —— 插件模块图的版本化加载
 *
 * ESM 模块缓存以完整 URL 为键，而插件入口 import 的依赖模块 URL 无法从外部改写：
 * 入口内容变了会重建实例，依赖内容变了却永远命中首次加载的那份。
 *
 * 这里改「加载目录」而不是改 URL：对插件目录取内容聚合哈希，镜像到
 * 同层同级快照 `<parent>/<name>@<hash>/`，入口从快照目录加载。内容一变即换目录名，
 * 整张模块图按内容重建；同层同深度保证插件内的相对导入（含 `../../kernel/*`）
 * 路径关系完全不变——跨目录导入仍指向真实内核文件，内核模块保持进程内单例。
 */
import { readFileSync, readdirSync, cpSync, rmSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'data', 'dist', 'coverage']);
/** 快照目录名：<name>@<10 位十六进制>。扫描与监听据此识别并跳过，避免把快照当作插件重复加载 */
export const SNAPSHOT_SUFFIX = /@[0-9a-f]{10}$/;
/** 快照体积上限：超过则不落快照，退回入口级热重载并告警（不静默） */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 6;

export interface Snapshot {
  /** 目录内容聚合哈希 */
  hash: string;
  /** 实际加载目录（快照目录；skipped 时为原目录） */
  dir: string;
  /** 是否因体积超限放弃快照 */
  skipped: boolean;
}

/** 递归收集目录内的文件（跳过依赖目录、历史快照与深层子树） */
function walkFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name) || SNAPSHOT_SUFFIX.test(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, depth + 1, out);
    else out.push(full);
  }
  return out;
}

/** 单文件内容摘要（不可读返回空串） */
export function fileDigest(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
}

/** 目录内源码文件的内容聚合摘要（相对路径 + 内容，顺序稳定） */
export function dirDigest(dir: string): string {
  const h = createHash('sha256');
  const files = walkFiles(dir).filter((f) => SOURCE_EXT.test(f)).sort();
  for (const f of files) {
    h.update(relative(dir, f).replace(/\\/g, '/'));
    try { h.update(readFileSync(f)); } catch { /* 读不到的文件不参与版本 */ }
  }
  return files.length ? h.digest('hex').slice(0, 10) : '';
}

function totalBytes(dir: string): number {
  let total = 0;
  for (const f of walkFiles(dir)) {
    try { total += statSync(f).size; } catch { /* 忽略 */ }
  }
  return total;
}

/**
 * 为插件目录生成（或复用）快照目录。
 * 内容未变命中既有快照则不复制；超体积上限返回原目录并置 skipped。
 * 并发安全：同一插件的 reload 由 loader 的生命周期队列串行，不会同时写同一快照目录。
 */
export function materialize(pluginDir: string, hash: string): Snapshot {
  const snapDir = join(dirname(pluginDir), `${basename(pluginDir)}@${hash}`);
  if (existsSync(snapDir)) return { hash, dir: snapDir, skipped: false };
  if (totalBytes(pluginDir) > MAX_BYTES) return { hash, dir: pluginDir, skipped: true };
  try {
    cpSync(pluginDir, snapDir, {
      recursive: true,
      filter: (src) => !SKIP_DIR.has(basename(src)) && !SNAPSHOT_SUFFIX.test(basename(src)),
    });
    return { hash, dir: snapDir, skipped: false };
  } catch {
    rmSync(snapDir, { recursive: true, force: true });
    return { hash, dir: pluginDir, skipped: true };
  }
}

/** 清理目录下除 keep 之外的全部历史快照（提交后保留当前、回滚时保留旧版） */
export function pruneSnapshots(pluginDir: string, keep: string[] = []): void {
  const parent = dirname(pluginDir);
  const prefix = `${basename(pluginDir)}@`;
  let entries: string[];
  try { entries = readdirSync(parent); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !SNAPSHOT_SUFFIX.test(name)) continue;
    const full = join(parent, name);
    if (keep.includes(full)) continue;
    rmSync(full, { recursive: true, force: true });
  }
}
