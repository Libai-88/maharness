/**
 * core/tools-fs/index.ts —— 文件工具插件
 * 提供 read_file / write_file / list_dir / delete_file 四个工具。
 * Windows 原生：路径沙箱（大小写不敏感防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、二进制防护。
 * 安全：内核硬保护（kernel/、core/chat/ 禁写，C-R4）；密钥黑名单（.env、data/ 禁读，C-S4/H10）。
 * 缓存：read_file/list_dir 按「路径 + mtime + size」做 L2 缓存；写删成功后清空 L2（保一致性）
 *  并失效本会话 L1 语义缓存（防陈旧观察答案，H8）。
 */
import { statSync, readdirSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { CacheLike, Plugin, ToolContext, TraceLike } from '../../kernel/types';
import { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart } from '../../kernel/sandbox';
import type { ReadResult } from '../../kernel/sandbox';

// Re-export 沙箱工具（向后兼容，原有 import 路径仍可用）
export { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart };
export type { ReadResult };

/** H8：失效会话级 L1 语义缓存（契约方法由 kernel/cache.ts 提供；未上线时静默跳过） */
function invalidateSessionL1(tctx: ToolContext): void {
  const c = tctx.cache as { l1InvalidateSession?: (sessionId?: string) => void };
  c.l1InvalidateSession?.(tctx.sessionId);
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
