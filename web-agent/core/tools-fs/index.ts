/**
 * core/tools-fs/index.ts —— 文件工具插件
 * 提供 read_file / write_file / list_dir / delete_file 四个工具。
 * Windows 原生：路径沙箱（大小写不敏感防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、二进制防护。
 * 安全：内核硬保护（kernel/、core/chat/ 禁写，C-R4）；密钥黑名单（.env、data/ 禁读，C-S4/H10）。
 * 缓存：read_file/list_dir 按「路径 + mtime + size」做 L2 缓存；写删成功后清空 L2（保一致性）
 *  并失效本会话 L1 语义缓存（防陈旧观察答案，H8）。
 */
import { statSync, readdirSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import type { CacheLike, Plugin, ToolContext, TraceLike } from '../../kernel/types';

// ============ Windows 沙箱 ============

/** 将相对路径解析到沙箱内；越界（含 .. 穿越、符号链接逃逸）一律拒绝。
 *  realpath 强化：校验通过后返回真实路径（已存在部分取 realpath，未创建尾部拼接），
 *  后续读写直接走真实路径——消除「词法校验通过、实际写入经符号链接逃逸」的 TOCTOU 窗口。
 *  跨层契约：server 侧文件 API 统一 import 本函数做沙箱校验。 */
export function resolveInSandbox(sandboxRoot: string, relPath: string): string {
  const root = resolve(sandboxRoot);
  const target = resolve(root, relPath || '.');
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
    throw new Error(`路径越界（沙箱根目录: ${root}）: ${relPath}`);
  }
  // 防符号链接逃逸：逐级上溯最深已存在祖先，校验真实路径仍在沙箱内
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      const real = resolveSync(current);
      const realLower = real.toLowerCase();
      if (realLower !== rootLower && !realLower.startsWith(rootLower + sep)) {
        throw new Error(`路径指向沙箱外（符号链接）: ${relPath}`);
      }
      const tail = relative(current, target); // 未创建的尾部（write_file 新建文件场景）
      return tail ? join(real, tail) : real;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return target;
}

/** 相对沙箱根的规范化相对路径（小写 + 正斜杠），供保护区/黑名单前缀匹配 */
function normalizedRel(absPath: string, sandboxRoot: string): string {
  return relative(resolve(sandboxRoot), resolve(absPath)).split(sep).join('/').toLowerCase();
}

// ============ C-R4 内核硬保护（机器强制，不依赖提示词） ============

/** AGENT_ALLOW_CORE_EDIT=1 放行内核修改（首次读取后进程内缓存） */
let allowCoreEditCache: boolean | null = null;

/** kernel/ 与 core/chat/ 为 agent 运行时核心：写/删一律拒绝（AGENT_ALLOW_CORE_EDIT=1 可显式放行） */
export function isProtectedWritePath(absPath: string, sandboxRoot: string): boolean {
  if (allowCoreEditCache === null) allowCoreEditCache = process.env.AGENT_ALLOW_CORE_EDIT === '1';
  if (allowCoreEditCache) return false;
  const norm = normalizedRel(absPath, sandboxRoot);
  return norm === 'kernel' || norm.startsWith('kernel/')
    || norm === 'core/chat' || norm.startsWith('core/chat/');
}

// ============ C-S4/H10 密钥黑名单 ============

/** .env（密钥/环境配置）与 data/（内部数据）不可读；list_dir 照常列出（可发现不可读） */
export function isDeniedReadPath(absPath: string, sandboxRoot: string): boolean {
  const norm = normalizedRel(absPath, sandboxRoot);
  if (!norm || norm.startsWith('../')) return false; // 沙箱外由 resolveInSandbox 拒绝
  if (norm === '.env' || norm.endsWith('/.env')) return true;
  return norm === 'data' || norm.startsWith('data/');
}

/** H8：失效会话级 L1 语义缓存（契约方法由 kernel/cache.ts 提供；未上线时静默跳过） */
function invalidateSessionL1(tctx: ToolContext): void {
  const c = tctx.cache as { l1InvalidateSession?: (sessionId?: string) => void };
  c.l1InvalidateSession?.(tctx.sessionId);
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
  /** 超大文件截断标记：text 仅为前 MAX_READ 字符，完整内容可用分段读取获取 */
  truncated?: boolean;
}

/** read_file 单次返回上限（字符）：保护上下文预算；截断显式告知（观测完整性） */
const MAX_READ = 100_000;

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
// 缓存键命名空间版本：工具实现变更（输出格式/行为）后递增，
// 旧缓存自动失效——缓存值依赖工具版本，这是 L2 的第一性原理约束
const TOOLS_FS_CACHE_VER = 'v2';

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
        risk: 'low',
        costHint: 'low',
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
          const key = tctx.cache.makeKey(['list_dir', TOOLS_FS_CACHE_VER, dir.toLowerCase(), String(st.mtimeMs), String(st.size)]);
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
        risk: 'low',
        costHint: 'low',
        limits: '仅文本文件；二进制返回错误',
        output: '{text, encoding, size, path}；超大文件返回前 100KB 并标注 truncated',
        description: '读取文本文件内容（自动识别 UTF-8/UTF-16/GBK 编码；二进制文件返回错误）。路径相对沙箱根目录。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件路径，相对沙箱根目录' } },
          required: ['path'],
        },
        async handler(args: { path?: string }, tctx: ToolContext): Promise<{ ok: boolean; data?: ReadResult; error?: string }> {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isDeniedReadPath(file, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝读取: ${relative(tctx.sandboxRoot, file)}（密钥与环境配置 .env、内部数据 data/ 不可读）` };
          }
          if (!existsSync(file)) return { ok: false, error: `文件不存在: ${relative(tctx.sandboxRoot, file)}` };
          const st = statSync(file);
          if (!st.isFile()) return { ok: false, error: '目标不是文件' };
          const key = tctx.cache.makeKey(['read_file', TOOLS_FS_CACHE_VER, file.toLowerCase(), String(st.mtimeMs), String(st.size)]);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
              .finish({ outputSummary: '文件读取缓存命中' });
            return { ok: true, data: hit.value as ReadResult };
          }
          const r = readTextSmart(file);
          if (r.isBinary) return { ok: false, error: `二进制文件（${st.size} 字节），v1 不支持读取` };
          const truncated = r.text.length > MAX_READ;
          const result: ReadResult = {
            text: truncated ? r.text.slice(0, MAX_READ) : r.text,
            encoding: r.encoding, isBinary: false,
            size: st.size, path: relative(tctx.sandboxRoot, file),
            truncated: truncated || undefined,
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
        risk: 'high',
        costHint: 'low',
        approval: true,
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
          // C-S2 工具侧双保险：写入前必须有用户审批（与执行器侧强制互补）
          if (!tctx.approved) {
            return {
              ok: false,
              needsApproval: true,
              approvalSummary: `写入文件\n路径：${args.path}`,
            };
          }
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isProtectedWritePath(file, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝写入内核保护区（kernel/、core/chat/）: ${relative(tctx.sandboxRoot, file)}。如确需修改 agent 运行时核心，设置环境变量 AGENT_ALLOW_CORE_EDIT=1 后重启放行。` };
          }
          if (args.content === undefined) return { ok: false, error: '缺少 content' };
          mkdirSync(resolve(file, '..'), { recursive: true });
          writeFileSync(file, args.content, 'utf8');
          // 写操作影响文件系统观察：失效文件类读缓存（list_dir/read_file），不误伤其他工具（如 web_search）
          tctx.cache.l2DeleteNamespace('list_dir');
          tctx.cache.l2DeleteNamespace('read_file');
          // H8：文件变化也可能使会话级 L1 里的「观察类答案」陈旧，一并失效
          invalidateSessionL1(tctx);
          return { ok: true, data: { path: relative(tctx.sandboxRoot, file), bytes: Buffer.byteLength(args.content, 'utf8') } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'delete_file',
        risk: 'high',
        costHint: 'low',
        approval: true,
        description: '删除沙箱内的文件或空目录。破坏性操作：默认需要用户审批，批准后执行；非空目录会失败（不能递归删除）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件或空目录路径（相对沙箱根目录）' } },
          required: ['path'],
        },
        async handler(args: { path?: string }, tctx: ToolContext) {
          const target = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (!existsSync(target)) return { ok: false, error: `目标不存在: ${relative(tctx.sandboxRoot, target) || '.'}` };
          const rel = relative(tctx.sandboxRoot, target) || '.';
          if (rel === '.') return { ok: false, error: '不能删除沙箱根目录' };
          if (isProtectedWritePath(target, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝删除内核保护区（kernel/、core/chat/）: ${rel}。如确需修改 agent 运行时核心，设置环境变量 AGENT_ALLOW_CORE_EDIT=1 后重启放行。` };
          }
          if (!tctx.approved) {
            // 删除是破坏性操作：请求用户审批（执行器级挂起，批准后自动重试）
            return {
              ok: false,
              needsApproval: true,
              approvalSummary: `删除文件/目录\n路径：${rel}`,
            };
          }
          const st = statSync(target);
          try {
            rmSync(target, { force: true }); // 非空目录会抛 ENOTEMPTY
          } catch (err) {
            return { ok: false, error: `删除失败（非空目录不允许递归删除）: ${err instanceof Error ? err.message : String(err)}` };
          }
          tctx.cache.l2DeleteNamespace('list_dir'); // 文件变化，失效文件读缓存（保留其他工具缓存）
          tctx.cache.l2DeleteNamespace('read_file');
          invalidateSessionL1(tctx); // H8：观察类答案可能陈旧，失效会话级 L1
          return { ok: true, data: { removed: rel, type: st.isDirectory() ? 'dir' : 'file' } };
        },
      },
    });

    ctx.logger.info('工具就绪: list_dir / read_file / write_file / delete_file（沙箱内）');
  },
} satisfies Plugin;
