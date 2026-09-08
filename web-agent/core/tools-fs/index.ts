/**
 * core/tools-fs/index.ts —— 文件与检索工具插件
 * 工具：list_dir / read_file / write_file / edit_file / delete_file / glob / grep。
 * Windows 原生：路径沙箱（大小写不敏感防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、二进制防护。
 * 安全：内核硬保护（kernel/、core/chat/ 禁写，C-R4）；密钥黑名单（.env、data/ 禁读，C-S4/H10）；
 *      写类工具审批由执行器侧 assessApproval 动态判定（默认沙箱内免审批，tools.writeRequiresApproval=true 可恢复强制审批）。
 * 缓存：读类工具按「路径 + mtime + size + 参数」做 L2；写/编辑/删除成功后清空文件类读缓存并失效会话 L1。
 */
import { statSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync, openSync, readSync, closeSync, renameSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import type { CacheLike, Plugin, ToolContext, TraceLike } from '../../kernel/types';
import { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart } from '../../kernel/sandbox';
import type { ReadResult } from '../../kernel/sandbox';
import { walkFiles, matchesGlob, grepFiles, sliceLines, applyEdits, detectEol, convertEol } from '../../kernel/fssearch';
import type { EditOp } from '../../kernel/fssearch';

export { resolveInSandbox, isProtectedWritePath, isDeniedReadPath, readTextSmart };
export type { ReadResult };

const TOOLS_FS_CACHE_VER = 'v3';
const MAX_READ_CHARS = 100_000;
const DEFAULT_READ_LINES = 2000;
const MAX_EDIT_BYTES = 2_000_000;

function invalidateFileCaches(tctx: ToolContext): void {
  tctx.cache.l2DeleteNamespace('list_dir');
  tctx.cache.l2DeleteNamespace('read_file');
  tctx.cache.l2DeleteNamespace('glob');
  tctx.cache.l2DeleteNamespace('grep');
  (tctx.cache as { l1InvalidateSession?: (s?: string) => void }).l1InvalidateSession?.(tctx.sessionId);
}

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

function startsWithBom(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(3);
    const n = readSync(fd, buf, 0, 3, 0);
    return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 忽略 */ } }
}

/** 原子写：tmp + rename（Windows 上 rename 目标已存在会 EEXIST，先移除） */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.maharness.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try { if (existsSync(file)) rmSync(file, { force: true }); } catch { /* 交给 rename 报错 */ }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { writeFileSync(file, content, 'utf8'); rmSync(tmp, { force: true }); }
    catch { throw err; }
  }
}

// ============ ripgrep 优先（缺失时回落纯 JS 引擎） ============

let rgAvailability: Promise<boolean> | null = null;
function hasRipgrep(): Promise<boolean> {
  if (rgAvailability === null) {
    rgAvailability = new Promise<boolean>((res) => {
      try {
        const p = spawn('rg', ['--version'], { windowsHide: true });
        p.on('error', () => res(false));
        p.on('close', (code) => res(code === 0));
        p.stdout.resume();
      } catch { res(false); }
    });
  }
  return rgAvailability;
}

interface RgOut { matches: { file: string; line: number; text: string }[]; files: string[]; truncated: boolean }

function runRipgrep(rootAbs: string, opts: { pattern: string; literal?: boolean; ignoreCase?: boolean; glob?: string; path?: string; limit: number }, signal?: AbortSignal): Promise<RgOut | null> {
  return new Promise((resolveP) => {
    const argv = ['--json', '--max-columns', '400', '--no-messages'];
    if (opts.ignoreCase) argv.push('-i');
    if (opts.literal) argv.push('-F');
    if (opts.glob) argv.push('--glob', opts.glob);
    argv.push('-e', opts.pattern, opts.path ?? '.');
    let child;
    try {
      child = spawn('rg', argv, { cwd: rootAbs, windowsHide: true, signal });
    } catch { resolveP(null); return; }
    let buf = '';
    const out: RgOut = { matches: [], files: [], truncated: false };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.type !== 'match') continue;
          const rel = String(j.data.path.text).split(/[\\/]/g).join('/');
          if (!out.files.includes(rel)) out.files.push(rel);
          out.matches.push({ file: rel, line: Number(j.data.line_number) || 0, text: String(j.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 500) });
          if (out.matches.length >= opts.limit) { out.truncated = true; try { child.kill(); } catch { /* 忽略 */ } }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.on('error', () => { clearTimeout(timer); resolveP(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 1 && out.matches.length === 0) { resolveP(out); return; }   // 正常「无匹配」
      if (code === 0 || out.truncated || out.matches.length) { resolveP(out); return; }
      resolveP(null);                                                          // 异常/参数不支持 → 回落 JS
    });
  });
}

// ============ 插件 ============

export default {
  id: 'tools-fs',
  name: '文件工具',
  version: '0.2.0',
  onLoad(ctx) {
    const writeNeedsApproval = () => ctx.config.get<boolean>('tools.writeRequiresApproval', false);

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'tools-fs-rules',
        name: '文件工具使用规则',
        description: '约束 LLM 正确使用文件与检索工具',
        priority: 10,
        content: [
          '文件与检索工具使用规则：',
          '1. 所有路径相对沙箱根目录（当前工作区），不要使用绝对路径；',
          '2. 找文件用 glob（如 **/*.ts、src/*.tsx），找代码用 grep（正则或 literal），不要 list_dir 逐层翻目录；',
          '3. 读文件先给路径，需要定位时传 offset/limit 分段读，行号从 1 开始，用返回的 nextOffset 续读；',
          '4. 局部修改一律用 edit_file（精确字符串替换，oldText 要带足够上下文以唯一定位；多处同改用 replaceAll 或一次传多个 edits）；整份重写只在新建文件或小文件时用 write_file；',
          '5. 编辑前先 read_file 拿到准确文本（含缩进），不要凭记忆写 oldText；',
          '6. 不要读取 .env、密钥文件等敏感内容，除非用户明确要求；二进制文件（图片/文档）read_file 会拒绝，应说明而非反复尝试；',
          '7. 查看代码优先读关键文件（入口/类型定义/配置），避免无差别全量扫描。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_dir',
        risk: 'low',
        costHint: 'low',
        description: '列出单层目录内容（名称、类型、大小、修改时间）。递归找文件请用 glob。路径相对沙箱根目录。',
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
            return readdirSync(dir, { withFileTypes: true }).map((e) => {
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
        limits: '仅文本文件；单次最多 2000 行 / 100k 字符，超出用 offset 续读',
        output: '{text, encoding, size, path, totalLines, startLine, endLine, nextOffset?}；nextOffset 表示还有后续行',
        description: '读取文本文件（自动识别 UTF-8/UTF-16/GBK）。支持 offset（1 起始行号）/limit（行数）分段读，lineNumbers=true 可给每行加行号前缀。路径相对沙箱根目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，相对沙箱根目录' },
            offset: { type: 'number', description: '起始行号（1 起始，默认 1）' },
            limit: { type: 'number', description: '读取行数（默认 2000，最大 20000）' },
            lineNumbers: { type: 'boolean', description: 'true 时每行加 "行号: " 前缀（便于人读，勿用于 oldText 匹配）' },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; offset?: number; limit?: number; lineNumbers?: boolean }, tctx: ToolContext): Promise<{ ok: boolean; data?: ReadResult; error?: string }> {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isDeniedReadPath(file, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝读取: ${relative(tctx.sandboxRoot, file)}（密钥与环境配置 .env、内部数据 data/ 不可读）` };
          }
          if (!existsSync(file)) return { ok: false, error: `文件不存在: ${relative(tctx.sandboxRoot, file)}` };
          const st = statSync(file);
          if (!st.isFile()) return { ok: false, error: '目标不是文件' };
          const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
          const limit = Math.min(20_000, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_READ_LINES)));
          const lineNumbers = args.lineNumbers === true;
          const key = tctx.cache.makeKey(['read_file', TOOLS_FS_CACHE_VER, file.toLowerCase(), String(st.mtimeMs), String(st.size), String(offset), String(limit), lineNumbers ? 'n' : '']);
          const hit = tctx.cache.l2Get(key);
          if (hit.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key })
              .finish({ outputSummary: '文件读取缓存命中' });
            return { ok: true, data: hit.value as ReadResult };
          }
          const r = readTextSmart(file);
          if (r.isBinary) return { ok: false, error: `二进制文件（${st.size} 字节），read_file 不支持；图片/文档类请如实告知用户当前无法读取` };
          const s = sliceLines(r.text, offset, limit, MAX_READ_CHARS);
          const result: ReadResult = {
            text: lineNumbers ? s.text.split('\n').map((ln, i) => `${s.startLine + i}: ${ln}`).join('\n') : s.text,
            encoding: r.encoding, isBinary: false,
            size: st.size, path: relative(tctx.sandboxRoot, file),
            truncated: s.nextOffset ? true : undefined,
            totalLines: s.totalLines, startLine: s.startLine, endLine: s.endLine, nextOffset: s.nextOffset,
          };
          tctx.cache.l2Set(key, result);
          return { ok: true, data: result };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'glob',
        risk: 'low',
        costHint: 'low',
        limits: '不跟随符号链接；默认忽略 node_modules/.git/dist/build 等；上限 500 条',
        output: '{matches: [{path,size,mtime}], total, truncated, root}',
        description: '按 glob 模式递归查找文件（如 **/*.ts、src/**/*.spec.ts、*.md）。不含 / 的模式按文件名匹配。路径参数相对沙箱根目录。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，支持 ** * ? {a,b}' },
            path: { type: 'string', description: '限定搜索的子目录（相对沙箱根目录，默认 .）' },
            limit: { type: 'number', description: '最多返回条数（默认 200，上限 500）' },
          },
          required: ['pattern'],
        },
        async handler(args: { pattern?: string; path?: string; limit?: number }, tctx: ToolContext) {
          const pattern = String(args.pattern ?? '').trim();
          if (!pattern) return { ok: false, error: 'pattern 不能为空' };
          const rootAbs = resolveInSandbox(tctx.sandboxRoot, args.path ?? '.');
          if (!existsSync(rootAbs)) return { ok: false, error: `目录不存在: ${relative(tctx.sandboxRoot, rootAbs) || '.'}` };
          const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 200)));
          const key = tctx.cache.makeKey(['glob', TOOLS_FS_CACHE_VER, rootAbs.toLowerCase(), pattern, String(limit)]);
          const data = cachedRead(tctx.cache, tctx.trace, tctx.traceId ?? '', tctx.turn, key, () => {
            const { hits, truncated } = walkFiles(rootAbs, { maxFiles: 20_000, maxMs: 8_000, accept: rel => matchesGlob(rel, pattern) });
            const sorted = hits.sort((a, b) => a.rel.localeCompare(b.rel));
            return {
              matches: sorted.slice(0, limit).map(h => ({ path: h.rel, size: h.size })),
              total: sorted.length,
              truncated: truncated || sorted.length > limit,
              root: relative(tctx.sandboxRoot, rootAbs) || '.',
            };
          });
          return { ok: true, data };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'grep',
        risk: 'low',
        costHint: 'medium',
        limits: '单文件默认跳过 >2MB；ripgrep 可用时走 rg，回落纯 JS；上限 200 条',
        output: '{matches: [{file,line,text,before?,after?}], files, scannedFiles, truncated}',
        description: '在工作区内按正则（或 literal=true 原文）搜索文件内容，返回 文件:行号:内容。可用 glob 限定文件类型、path 限定目录、contextLines 带上下文行。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式（JS 语法）；literal=true 时按原文匹配' },
            path: { type: 'string', description: '限定搜索子目录（相对沙箱根目录，默认 .）' },
            glob: { type: 'string', description: '文件过滤 glob，如 *.ts 或 src/**/*.{ts,tsx}' },
            ignoreCase: { type: 'boolean', description: '忽略大小写' },
            literal: { type: 'boolean', description: '按原文匹配（不解释正则元字符）' },
            contextLines: { type: 'number', description: '每个匹配附带前后各 N 行（0-5，>0 时用内置 JS 引擎）' },
            maxResults: { type: 'number', description: '最多返回条数（默认 200，上限 500）' },
          },
          required: ['pattern'],
        },
        async handler(args: { pattern?: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; contextLines?: number; maxResults?: number }, tctx: ToolContext) {
          const pattern = String(args.pattern ?? '');
          if (!pattern) return { ok: false, error: 'pattern 不能为空' };
          const rootAbs = resolveInSandbox(tctx.sandboxRoot, args.path ?? '.');
          if (!existsSync(rootAbs)) return { ok: false, error: `目录不存在: ${relative(tctx.sandboxRoot, rootAbs) || '.'}` };
          const limit = Math.min(500, Math.max(1, Math.floor(Number(args.maxResults) || 200)));
          const ctxLines = Math.max(0, Math.min(5, Math.floor(Number(args.contextLines) || 0)));
          const key = tctx.cache.makeKey(['grep', TOOLS_FS_CACHE_VER, rootAbs.toLowerCase(), pattern, args.glob ?? '', args.ignoreCase ? 'i' : '', args.literal ? 'F' : '', String(ctxLines), String(limit)]);
          const cached = tctx.cache.l2Get(key);
          if (cached.hit) {
            tctx.trace.startStep({ traceId: tctx.traceId ?? '', turn: tctx.turn, type: 'cache_hit', name: 'L2', cacheKey: key }).finish({ outputSummary: '搜索结果缓存命中' });
            return { ok: true, data: cached.value };
          }
          const opts = { pattern, glob: args.glob, ignoreCase: args.ignoreCase, literal: args.literal };
          let data: unknown = null;
          if (ctxLines === 0 && await hasRipgrep()) {
            const rg = await runRipgrep(rootAbs, { ...opts, limit }, tctx.signal);
            if (rg) data = { ...rg, scannedFiles: rg.files.length, engine: 'ripgrep' };
          }
          if (!data) {
            const r = grepFiles(rootAbs, {
              pattern, literal: args.literal, ignoreCase: args.ignoreCase, path: '.', glob: args.glob,
              contextLines: ctxLines, limit,
            });
            if (r.error) return { ok: false, error: r.error };
            data = { ...r, engine: 'js' };
          }
          tctx.cache.l2Set(key, data);
          return { ok: true, data };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'write_file',
        risk: 'medium',
        costHint: 'low',
        approval: true,
        limits: '整文件覆写；内核保护区（kernel/、core/chat/）与 .env/data 拒写',
        description: '写入文本文件（UTF-8，自动创建父目录；已存在则整份覆盖）。局部改动优先用 edit_file。沙箱内写默认免审批（可经 tools.writeRequiresApproval 恢复审批）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，相对沙箱根目录' },
            content: { type: 'string', description: '完整文件内容' },
          },
          required: ['path', 'content'],
        },
        assessApproval: () => ({ needsApproval: writeNeedsApproval(), reason: '写入工作区文件' }),
        async handler(args: { path?: string; content?: string }, tctx: ToolContext) {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isProtectedWritePath(file, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝写入内核保护区（kernel/、core/chat/）: ${relative(tctx.sandboxRoot, file)}。如确需修改 agent 运行时核心，设置环境变量 AGENT_ALLOW_CORE_EDIT=1 后重启放行。` };
          }
          if (args.content === undefined) return { ok: false, error: '缺少 content' };
          mkdirSync(resolve(file, '..'), { recursive: true });
          atomicWrite(file, args.content);
          invalidateFileCaches(tctx);
          return { ok: true, data: { path: relative(tctx.sandboxRoot, file), bytes: Buffer.byteLength(args.content, 'utf8') } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'edit_file',
        risk: 'medium',
        costHint: 'low',
        approval: true,
        limits: '目标须为已存在的文本文件且 <2MB；oldText 必须与文件内容逐字符一致（含缩进），不唯一时报错',
        output: '{path, edits: [{index, replaced}], bytesBefore, bytesAfter}',
        description: '对已存在文件做精确字符串替换（一次可传多处 edits，全部命中才写盘；任一处未命中或匹配不唯一则整体放弃并逐条报错）。保留原换行风格（CRLF/LF）与 BOM。局部改动的首选工具。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，相对沙箱根目录' },
            edits: {
              type: 'array',
              description: '按顺序应用的编辑列表',
              items: {
                type: 'object',
                properties: {
                  oldText: { type: 'string', description: '要被替换的原文（含足够上下文以唯一定位）' },
                  newText: { type: 'string', description: '替换后的文本' },
                  replaceAll: { type: 'boolean', description: 'true 时替换全部匹配（默认要求唯一匹配）' },
                },
                required: ['oldText', 'newText'],
              },
            },
          },
          required: ['path', 'edits'],
        },
        assessApproval: () => ({ needsApproval: writeNeedsApproval(), reason: '编辑工作区文件' }),
        async handler(args: { path?: string; edits?: EditOp[] }, tctx: ToolContext) {
          const file = resolveInSandbox(tctx.sandboxRoot, args.path ?? '');
          if (isProtectedWritePath(file, tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝编辑内核保护区（kernel/、core/chat/）: ${relative(tctx.sandboxRoot, file)}` };
          }
          if (!existsSync(file)) return { ok: false, error: `文件不存在: ${relative(tctx.sandboxRoot, file)}——新建请用 write_file` };
          const st = statSync(file);
          if (!st.isFile()) return { ok: false, error: '目标不是文件' };
          if (st.size > MAX_EDIT_BYTES) return { ok: false, error: `文件过大（${st.size} 字节 > ${MAX_EDIT_BYTES}），edit_file 不支持` };
          const edits = Array.isArray(args.edits) ? args.edits : [];
          if (!edits.length) return { ok: false, error: 'edits 不能为空' };
          if (edits.length > 50) return { ok: false, error: '单次最多 50 处编辑' };
          const bom = startsWithBom(file);
          const r = readTextSmart(file);
          if (r.isBinary) return { ok: false, error: '二进制文件不可编辑' };
          const eol = detectEol(r.text);
          const normalized = edits.map(e => ({
            oldText: convertEol(String(e.oldText ?? ''), eol),
            newText: convertEol(String(e.newText ?? ''), eol),
            replaceAll: !!e.replaceAll,
          }));
          const outcome = applyEdits(r.text, normalized);
          if (!outcome.ok) return { ok: false, error: `${outcome.error}（文件未改动）` };
          atomicWrite(file, (bom ? '\ufeff' : '') + outcome.text);
          invalidateFileCaches(tctx);
          return {
            ok: true,
            data: {
              path: relative(tctx.sandboxRoot, file),
              edits: outcome.applied,
              bytesBefore: st.size,
              bytesAfter: Buffer.byteLength(outcome.text, 'utf8'),
            },
          };
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
        description: '删除沙箱内的文件或空目录。破坏性操作：始终需要用户审批；非空目录会失败（不能递归删除）。',
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
            return { ok: false, needsApproval: true, approvalSummary: `删除文件/目录\n路径：${rel}` };
          }
          const st = statSync(target);
          try {
            rmSync(target, { force: true });
          } catch (err) {
            return { ok: false, error: `删除失败（非空目录不允许递归删除）: ${err instanceof Error ? err.message : String(err)}` };
          }
          invalidateFileCaches(tctx);
          return { ok: true, data: { removed: rel, type: st.isDirectory() ? 'dir' : 'file' } };
        },
      },
    });

    ctx.logger.info('工具就绪: list_dir / read_file / glob / grep / write_file / edit_file / delete_file（沙箱内，写类默认免审批）');
  },
} satisfies Plugin;
