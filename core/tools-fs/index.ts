/**
 * core/tools-fs/index.ts —— 文件工具插件
 * 提供 read_file / write_file / list_dir 三个工具。
 * Windows 原生：路径沙箱（大小写不敏感防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、二进制防护。
 * 缓存：read_file/list_dir 按「路径 + mtime + size」做 L2 缓存；write_file 成功后清空 L2（保一致性）。
 */
import { statSync, readdirSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { CacheLike, Plugin, ToolContext, TraceLike } from '../../kernel/types';

// ============ Windows 沙箱 ============

/** 将相对路径解析到沙箱内；越界（含 .. 穿越、符号链接逃逸）一律拒绝 */
export function resolveInSandbox(sandboxRoot: string, relPath: string): string {
  const root = resolve(sandboxRoot);
  const target = resolve(root, relPath || '.');
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
    throw new Error(`路径越界（沙箱根目录: ${root}）: ${relPath}`);
  }
  // 防符号链接逃逸：逐级校验真实路径仍在沙箱内
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      const real = resolveSync(current);
      const realLower = real.toLowerCase();
      if (realLower !== rootLower && !realLower.startsWith(rootLower + sep)) {
        throw new Error(`路径指向沙箱外（符号链接）: ${relPath}`);
      }
      break;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return target;
}

function resolveSync(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

// ============ 编码识别（Windows 文件常见编码） ============

export interface ReadResult {
  text: string;
  encoding: string;
  isBinary: boolean;
  size: number;
  path: string;
}

export function readTextSmart(filePath: string): { text: string; encoding: string; isBinary: boolean } {
  const buf = readFileSync(filePath);
  // BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8(BOM)', isBinary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', isBinary: false };
  }
  // 二进制检测：内容含 NUL 且非 UTF-16
  if (buf.includes(0)) return { text: '', encoding: 'binary', isBinary: true };
  // 无 BOM：先严格 UTF-8，失败降级 GBK
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

// ============ L2 缓存辅助 ============

function cachedRead(cache: CacheLike, trace: TraceLike, traceId: string, turn: number, key: string, load: () => unknown): unknown {
  const hit = cache.l2Get(key);
  if (hit.hit) {
    trace.startStep({ traceId, turn, type: 'cache_hit', name: 'L2', cacheKey: key }).finish({ outputSummary: '工具结果缓存命中' });
    return hit.value;
  }
  const value = load();
  cache.l2Set(key, value);
  return value;
}

// ============ 插件 ============

export default {
  id: 'tools-fs',
  name: '文件工具',
  version: '0.1.0',
  onLoad(ctx) {
    // L2 插件自述：随插件加载/卸载自动增减的系统提示词片段
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'tools-fs-rules',
        name: '文件工具使用规则',
        description: '约束 LLM 正确使用文件工具',
        priority: 10,
        content: [
          '文件工具使用规则：',
          '1. 所有路径相对沙箱根目录（当前工作区），不要使用绝对路径；',
          '2. 不确定路径时先 list_dir 查看，再 read_file 读取；',
          '3. 写入前先说明意图；写入内容要完整，不要截断；',
          '4. 不要读取 .env、密钥文件等敏感内容，除非用户明确要求；',
          '5. 二进制文件无法读取时，告知用户并说明原因；',
          '6. 查看代码时优先读关键文件（入口/类型定义/配置），避免无差别全量扫描。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_dir',
        description: '列出目录内容（文件名、类型、大小、修改时间）。路径相对沙箱根目录。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径，如 . 或 docs 或 ui/src' } },
          required: ['path'],
        },
        async handler(args: { path?: string }, tctx: ToolContext) {
          const dir = resolveInSandbox(tctx.sandboxRoot, args.path ?? '.');
          if (!existsSync(dir)) return { ok: false, error: `目录不存在: ${relative(tctx.sandboxRoot, dir) || '.'}` };
          const st = statSync(dir);
          if (!st.isDirectory()) return { ok: false, error: '目标不是目录' };
          const key = tctx.cache.makeKey(['list_dir', dir.toLowerCase(), String(st.mtimeMs), String(st.size)]);
          const result = cachedRead(tctx.cache, tctx.trace, tctx.traceId ?? '', tctx.turn, key, () => {
            const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
              const full = resolve(dir, e.name);
              let info: { type: string; size?: number; mtime?: number };
              try {
                const s = statSync(full);
                info = { type: e.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
              } catch {
                info = { type: e.isDirectory() ? 'dir' : 'file' };
              }
              return { name: e.name, ...info };
            }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
            return entries;
          });
          return { ok: true, data: { path: relative(tctx.sandboxRoot, dir) || '.', entries: result } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'read_file',
        description: '读取文本文件内容（自动识别 UTF-8/UTF-16/GBK 编码；二进制文件返回错误）。路径相对沙箱根目录。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件路径，相对沙箱根目录' } },
          required: ['path'],
        },
        async handler(args: { path?: string }, tctx: ToolContext): Promise<{ ok: boolean; data?: ReadResult; error?: string }> {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (!existsSync(file)) return { ok: false, error: `文件不存在: ${relative(tctx.sandboxRoot, file)}` };
          const st = statSync(file);
          if (!st.isFile()) return { ok: false, error: '目标不是文件' };
          const key = tctx.cache.makeKey(['read_file', file.toLowerCase(), String(st.mtimeMs), String(st.size)]);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
              .finish({ outputSummary: '文件读取缓存命中' });
            return { ok: true, data: hit.value as ReadResult };
          }
          const r = readTextSmart(file);
          if (r.isBinary) return { ok: false, error: `二进制文件（${st.size} 字节），v1 不支持读取` };
          const result: ReadResult = {
            text: r.text, encoding: r.encoding, isBinary: false,
            size: st.size, path: relative(tctx.sandboxRoot, file),
          };
          tctx.cache.l2Set(key, result);
          return { ok: true, data: result };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'write_file',
        description: '写入文本文件（UTF-8，自动创建父目录；已存在则覆盖）。路径相对沙箱根目录。写成功后相关读缓存自动失效。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，相对沙箱根目录' },
            content: { type: 'string', description: '完整文件内容' },
          },
          required: ['path', 'content'],
        },
        async handler(args: { path?: string; content?: string }, tctx: ToolContext) {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (args.content === undefined) return { ok: false, error: '缺少 content' };
          mkdirSync(resolve(file, '..'), { recursive: true });
          writeFileSync(file, args.content, 'utf8');
          tctx.cache.clear(); // 写操作可能影响任意读缓存，v1 直接清空 L2（保一致性优先）
          return { ok: true, data: { path: relative(tctx.sandboxRoot, file), bytes: Buffer.byteLength(args.content, 'utf8') } };
        },
      },
    });

    ctx.logger.info('工具就绪: list_dir / read_file / write_file（沙箱内）');
  },
} satisfies Plugin;
