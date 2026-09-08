/**
 * kernel/fssearch.ts —— 仓库内检索引擎（纯函数，零依赖，可单测）
 * 提供 glob 匹配、目录遍历、正则/literal 逐行搜索。
 * 设计约束：不跟随符号链接、忽略目录内置、有文件数与时间双预算（防大仓库扫穿）。
 */
import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { readTextSmart } from './sandbox';

/** 默认忽略目录：依赖产物与构建输出，检索几乎从不需要 */
export const DEFAULT_IGNORES = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'bin', 'obj',
  '.next', '.nuxt', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  '.idea', '.gradle', 'target', '.terraform',
];

/** 归一化为沙箱相对路径（小写不敏感比较用 lower，展示用原样正斜杠） */
export function toRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/');
}

/** glob → RegExp：支持 ** / * / ? / {a,b}；不含 / 的模式同时按 basename 匹配 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { i += 2; re += '(?:.*/)?'; }
        else { i += 1; re += '.*'; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) { re += `(?:${pattern.slice(i + 1, end).split(',').map(escapeRe).join('|')})`; i = end; }
      else re += '\\{';
    } else if (c === '.') re += '\\.';
    else if (c === '/') re += '/';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** 路径是否命中 glob（无斜杠模式退化为 basename 匹配） */
export function matchesGlob(rel: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const re = globToRegex(p);
  if (re.test(rel)) return true;
  if (!p.includes('/')) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return re.test(base);
  }
  return false;
}

export interface WalkOptions {
  ignore?: string[];
  maxFiles?: number;
  maxMs?: number;
  /** 只收集满足条件的文件（提前过滤，避免全量物化） */
  accept?: (rel: string) => boolean;
}

export interface WalkHit { abs: string; rel: string; size: number }

/** 深度优先遍历目录（不跟随符号链接），超预算即停并标记 truncated */
export function walkFiles(root: string, opts: WalkOptions = {}): { hits: WalkHit[]; truncated: boolean } {
  const ignore = new Set((opts.ignore ?? DEFAULT_IGNORES).map(s => s.toLowerCase()));
  const maxFiles = opts.maxFiles ?? 20_000;
  const deadline = Date.now() + (opts.maxMs ?? 10_000);
  const base = resolve(root);
  const hits: WalkHit[] = [];
  let truncated = false;
  const stack: string[] = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ignore.has(e.name.toLowerCase())) continue;
        stack.push(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const abs = join(dir, e.name);
      const rel = toRel(base, abs);
      if (opts.accept && !opts.accept(rel)) continue;
      let size = 0;
      try { size = statSync(abs).size; } catch { continue; }
      hits.push({ abs, rel, size });
      if (hits.length >= maxFiles) { truncated = true; return { hits, truncated }; }
    }
    if (Date.now() > deadline) { truncated = true; break; }
  }
  return { hits, truncated };
}

export interface GrepOptions {
  pattern: string;
  literal?: boolean;
  ignoreCase?: boolean;
  /** 限定检索范围（沙箱相对目录），默认 '.' */
  path?: string;
  glob?: string;
  maxFileBytes?: number;
  contextLines?: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  files: string[];
  totalFiles: number;
  scannedFiles: number;
  truncated: boolean;
  error?: string;
}

function buildMatcher(opts: GrepOptions): { test: (s: string) => boolean } {
  if (opts.literal) {
    const needle = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    return { test: (s: string) => (opts.ignoreCase ? s.toLowerCase() : s).includes(needle) };
  }
  const re = new RegExp(opts.pattern, opts.ignoreCase ? 'i' : '');
  return { test: (s: string) => re.test(s) };
}

/** 逐行正则/literal 搜索（JS 引擎版；ripgrep 可用时由插件层优先走 rg） */
export function grepFiles(root: string, opts: GrepOptions & { limit?: number }): GrepResult {
  const limit = opts.limit ?? 200;
  if (!opts.pattern) return { matches: [], files: [], totalFiles: 0, scannedFiles: 0, truncated: false, error: 'pattern 不能为空' };
  if (!opts.literal && !isValidRegex(opts.pattern)) {
    return { matches: [], files: [], totalFiles: 0, scannedFiles: 0, truncated: false, error: `非法正则: ${opts.pattern}` };
  }
  const matcher = buildMatcher(opts);
  const rootAbs = resolve(join(resolve(root), opts.path ?? '.'));
  const maxFileBytes = opts.maxFileBytes ?? 2_000_000;
  const ctxN = Math.max(0, Math.min(5, opts.contextLines ?? 0));
  const { hits, truncated: walkTruncated } = walkFiles(rootAbs, {
    maxFiles: 30_000, maxMs: 15_000,
    accept: rel => (opts.glob ? matchesGlob(rel, opts.glob) : true),
  });
  const matches: GrepMatch[] = [];
  const files: string[] = [];
  let scanned = 0;
  let truncated = walkTruncated;
  for (const hit of hits) {
    if (matches.length >= limit) { truncated = true; break; }
    if (hit.size > maxFileBytes) continue;
    const r = readTextSmart(hit.abs);
    scanned++;
    if (r.isBinary) continue;
    const lines = r.text.split(/\r?\n/);
    let fileHits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i])) continue;
      fileHits++;
      const m: GrepMatch = { file: hit.rel, line: i + 1, text: lines[i].slice(0, 500) };
      if (ctxN && i - ctxN >= 0) m.before = lines.slice(Math.max(0, i - ctxN), i).map(s => s.slice(0, 500));
      if (ctxN && i + ctxN < lines.length) m.after = lines.slice(i + 1, i + 1 + ctxN).map(s => s.slice(0, 500));
      matches.push(m);
      if (matches.length >= limit) { truncated = true; break; }
    }
    if (fileHits && !files.includes(hit.rel)) files.push(hit.rel);
  }
  return { matches, files, totalFiles: hits.length, scannedFiles: scanned, truncated };
}

export function isValidRegex(src: string): boolean {
  try { new RegExp(src); return true; } catch { return false; }
}

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export interface EditOp { oldText: string; newText: string; replaceAll?: boolean }

export type EditOutcome =
  | { ok: true; text: string; applied: { index: number; replaced: number }[] }
  | { ok: false; error: string; failedIndex: number };

/** 精确字符串替换引擎：全部编辑成功才产出新文本（任一失败即整体放弃，不产生半成品） */
export function applyEdits(text: string, edits: EditOp[]): EditOutcome {
  let cur = text;
  const applied: { index: number; replaced: number }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const oldText = e.oldText ?? '';
    const newText = e.newText ?? '';
    if (!oldText) return { ok: false, error: `第 ${i + 1} 处编辑的 oldText 为空`, failedIndex: i };
    if (oldText === newText) return { ok: false, error: `第 ${i + 1} 处编辑 oldText 与 newText 相同`, failedIndex: i };
    const n = countOccurrences(cur, oldText);
    if (n === 0) return { ok: false, error: `第 ${i + 1} 处编辑未找到匹配文本`, failedIndex: i };
    if (n > 1 && !e.replaceAll) {
      return { ok: false, error: `第 ${i + 1} 处编辑匹配到 ${n} 处，无法唯一定位：请扩大 oldText 的上下文，或设 replaceAll=true`, failedIndex: i };
    }
    cur = e.replaceAll ? cur.split(oldText).join(newText) : cur.replace(oldText, () => newText);
    applied.push({ index: i, replaced: e.replaceAll ? n : 1 });
  }
  return { ok: true, text: cur, applied };
}

export function detectEol(text: string): '\n' | '\r\n' {
  const lf = text.indexOf('\n');
  if (lf === -1) return '\n';
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
}

export function convertEol(s: string, eol: '\n' | '\r\n'): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** 按行切片读取：返回行号区间与续读游标 */
export function sliceLines(text: string, offset: number, limit: number, maxChars: number): {
  text: string; startLine: number; endLine: number; totalLines: number; nextOffset?: number; truncatedByChars: boolean;
} {
  const lines = text.split('\n');
  const totalLines = lines.length;
  const start = Math.max(1, offset);
  const out: string[] = [];
  let chars = 0;
  let truncatedByChars = false;
  for (let i = start - 1; i < Math.min(totalLines, start + limit - 1); i++) {
    const line = lines[i];
    if (chars + line.length + 1 > maxChars) { truncatedByChars = true; break; }
    chars += line.length + 1;
    out.push(line);
  }
  const lastLine = start - 1 + out.length;
  const more = lastLine < totalLines;
  return {
    text: out.join('\n'),
    startLine: out.length ? start : 0,
    endLine: out.length ? lastLine : 0,
    totalLines,
    nextOffset: more ? lastLine + 1 : undefined,
    truncatedByChars,
  };
}
