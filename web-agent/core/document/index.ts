/**
 * 文件内容读取、常规 Office 生成、定点另存与可选外部 OCR。
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Plugin, ToolContext } from '../../kernel/types';
import { isDeniedReadPath, resolveInSandbox } from '../../kernel/sandbox';
import { buildProcessEnv } from '../../kernel/plugin-process';
import { registerDocumentTools } from './tools';
import { documentService } from './service';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARS = 40_000;
const MAX_TABLES = 20;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 2_000;
const MAX_PAGE_SELECTION = 200;
const OCR_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);

export interface OcrConfig {
  command?: string;
  args?: string[];
  /** 扫描版 PDF 渲染命令；支持 {input} 与 {outDir} 占位符。 */
  pdfCommand?: string;
  pdfArgs?: string[];
  timeoutMs?: number;
  maxChars?: number;
}

async function runCommand(command: string, argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env: buildProcessEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = ''; let failure: Error | undefined;
    const kill = () => {
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else child.kill('SIGKILL');
    };
    const abort = () => { failure = new Error('OCR 已取消'); kill(); };
    const timer = setTimeout(() => { failure = new Error(`外部命令超时（${timeoutMs}ms）`); kill(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString(); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (failure) reject(failure); else resolve({ stdout, stderr, code }); });
  });
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeTableRows(rows: string[][]): string[][] {
  let cells = 0;
  return rows.slice(0, MAX_TABLE_ROWS).map((row) => row.map((cell) => {
    if (cells++ >= MAX_TABLE_CELLS) return '';
    return String(cell ?? '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
  }));
}

export default {
  id: 'document',
    name: '文件处理',
  version: '0.1.0',
  onLoad(ctx) {
    registerDocumentTools(ctx);
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'document-rules',
        name: '文档读取规则',
        description: '引导 PDF 等二进制文档使用 document 工具',
        priority: 4,
        content: [
          '文档读取规则：',
          '1. PDF/DOCX/XLSX/CSV/PPTX 使用 read_document_content，按 pages、offset、limit 或 blockId 读取；read_document 保留 PDF/DOCX 兼容调用；',
          '2. 创建文件用 create_document，修改既有普通内容用 patch_document；先读取版本和目标原文，再另存结果，保留原件；',
          '长篇 Markdown、Word 或演示文稿可选择 begin_document_draft 建稿、update_document_draft 分段保存、read_document_draft 按需检查，最后 finalize_document_draft 发布。内容块使用稳定 ID；重试保持 operationId 和参数一致。草稿是部分成果，不能宣称任务完成。',
          '3. 来源使用任务材料 ID、读取版本和内容块 ID 生成链接；仅 PDF 有原始页码，Office 均为内容预览；',
          '4. XLSX 公式为缓存值，修改后需要 Office 重算；域、修订、合并单元格和复杂对象不支持定点修改。提取失败或超限要如实说明；',
          '5. 图片文字用 ocr_image（需管理员配置 document.ocr 外部命令）；扫描版 PDF 先确认 OCR 能力，不要假装读到了文字。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'read_document',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 120_000,
        sideEffect: 'read',
        contentTrust: 'untrusted',
        limits: `PDF/DOCX ≤ ${MAX_BYTES / 1024 / 1024}MB；正文 ≤ ${MAX_CHARS} 字符；表格 ≤ ${MAX_TABLES} 个 / ${MAX_TABLE_ROWS} 行 / ${MAX_TABLE_CELLS} 单元格`,
        output: '{path, format, pages?, totalChars, truncated, text, tables: [{page?, rows}], tableCount}',
        outputSchema: {
          type: 'object', required: ['path', 'format', 'totalChars', 'truncated', 'text', 'tables', 'tableCount'],
          properties: {
            path: { type: 'string' }, format: { type: 'string' }, pages: { type: 'array' },
            totalChars: { type: 'integer' }, truncated: { type: 'boolean' }, text: { type: 'string' },
            tables: { type: 'array' }, tableCount: { type: 'integer' }, tableWarning: { type: 'string' },
          },
        },
        description: '读取 PDF / DOCX 文档正文与表格（PDF 支持指定页范围）。用于论文、报告、合同等二进制文档；read_file 无法读取二进制文档。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对沙箱根的文件路径' },
            pages: {
              type: 'array',
              items: { type: 'integer', minimum: 1 },
              description: '可选：只解析指定页（1-based，如 [1,2,3]）',
            },
            maxChars: { type: 'integer', minimum: 500, maximum: MAX_CHARS },
            tables: { type: 'boolean', description: '是否提取表格（默认 true）' },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; pages?: number[]; maxChars?: number; tables?: boolean }, tctx: ToolContext) {
          const raw = String(args.path ?? '').trim();
          if (!raw) return { ok: false, error: '缺少 path' };
          const format = extname(raw).toLowerCase();
          if (format !== '.pdf' && format !== '.docx') {
            return { ok: false, error: '当前文档插件仅支持 PDF / DOCX；文本文件请用 read_file' };
          }
          const file = resolveInSandbox(tctx.sandboxRoot, raw);
          if (isDeniedReadPath(file, tctx.sandboxRoot, ctx.paths?.root ?? tctx.sandboxRoot)) {
            return { ok: false, error: `拒绝读取: ${raw}（密钥与环境配置 .env、内部数据 data/ 不可读）` };
          }
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) return { ok: false, error: `文件不存在: ${raw}` };
          if (info.size > MAX_BYTES) return { ok: false, error: `文档过大（${info.size} > ${MAX_BYTES} 字节）` };

          const maxChars = Math.min(MAX_CHARS, Math.max(500, Math.floor(Number(args.maxChars) || MAX_CHARS)));
          const pages = Array.isArray(args.pages)
            ? [...new Set(args.pages.map((page) => Math.trunc(Number(page))).filter((page) => page >= 1))].slice(0, MAX_PAGE_SELECTION)
            : undefined;
          const includeTables = args.tables !== false;
          try {
            const content = await documentService.read(await readFile(file), format.slice(1), { pages, limit: 200 }, tctx.signal);
            const text = normalizeText(content.blocks.filter(block => block.type !== 'table').map(block => block.text).join('\n\n'));
            const tables = includeTables ? content.blocks.filter(block => block.rows?.length).slice(0, MAX_TABLES).map(block => ({ ...(block.anchor.page ? { page: block.anchor.page } : {}), rows: normalizeTableRows(block.rows!) })) : [];
            return { ok: true, data: { path: raw, format: format.slice(1), pages: pages?.length ? pages : undefined, totalChars: text.length, truncated: text.length > maxChars || content.nextOffset !== undefined, text: text.slice(0, maxChars), tables, tableCount: tables.length, version: content.version, nextOffset: content.nextOffset, warnings: content.warnings } };
          } catch (error) { return { ok: false, error: `文档解析失败: ${error instanceof Error ? error.message : String(error)}` }; }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'ocr_image',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 120_000,
        sideEffect: 'read',
        contentTrust: 'untrusted',
        output: '{path, text, chars, truncated, command}',
        outputSchema: {
          type: 'object', required: ['path', 'text', 'chars', 'truncated', 'command'],
          properties: { path: { type: 'string' }, text: { type: 'string' }, chars: { type: 'integer' }, truncated: { type: 'boolean' }, command: { type: 'string' } },
        },
        description: '对沙箱内图片执行 OCR（需管理员配置 document.ocr.command）。适合截图、扫描图与图片中的文字。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱内图片路径' },
            maxChars: { type: 'integer', minimum: 100, maximum: 40000 },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; maxChars?: number }, tctx: ToolContext) {
          const cfg = ctx.config.get<OcrConfig>('document.ocr', {});
          if (!cfg.command) return { ok: false, error: 'OCR 未配置：请在 config.json 设置 document.ocr.command（如 tesseract）' };
          const file = resolveInSandbox(tctx.sandboxRoot, String(args.path ?? ''));
          if (isDeniedReadPath(file, tctx.sandboxRoot, ctx.paths?.root ?? tctx.sandboxRoot)) return { ok: false, error: '拒绝读取受保护路径' };
          const ext = extname(file).toLowerCase();
          if (!OCR_EXTS.has(ext)) return { ok: false, error: `不支持的图片格式: ${ext || '(无扩展名)'}` };
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) return { ok: false, error: `图片不存在: ${args.path}` };
          if (info.size > MAX_BYTES) return { ok: false, error: `图片超过 ${MAX_BYTES} 字节上限` };
          const maxChars = Math.max(100, Math.min(MAX_CHARS, Math.floor(Number(args.maxChars) || MAX_CHARS)));
          const configured = Array.isArray(cfg.args) && cfg.args.length ? cfg.args : ['{file}', 'stdout'];
          const argv = configured.map((arg) => arg.replaceAll('{file}', file));
          if (!configured.some((arg) => arg.includes('{file}'))) argv.push(file);
          if (argv.some((arg) => /[\r\n]/.test(arg))) return { ok: false, error: 'OCR 参数不得包含换行' };
          const timeoutMs = Math.max(1_000, Math.min(120_000, Math.floor(Number(cfg.timeoutMs) || 30_000)));
          try {
            const result = await runCommand(cfg.command, argv, tctx.sandboxRoot, timeoutMs, tctx.signal);
            const text = normalizeText(result.stdout);
            if (result.code !== 0) {
              return { ok: false, error: `OCR 失败（exit ${result.code}）: ${result.stderr.slice(0, 500) || '外部引擎未成功完成'}`, data: { text: text.slice(0, maxChars), partial: true } };
            }
            return {
              ok: true,
              data: {
                path: String(args.path ?? ''),
                text: text.slice(0, maxChars),
                chars: text.length,
                truncated: text.length > maxChars,
                command: cfg.command,
              },
              evidence: [{ kind: 'content', label: `OCR ${args.path}`, value: text.slice(0, 500) }],
            };
          } catch (err) {
            return { ok: false, error: `OCR 执行失败: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'ocr_pdf',
        risk: 'low',
        costHint: 'medium',
        timeoutMs: 600_000,
        sideEffect: 'read',
        contentTrust: 'untrusted',
        output: '{path, pages: [{page, text}], text, rendered, truncated}',
        outputSchema: {
          type: 'object', required: ['path', 'pages', 'text', 'rendered', 'truncated'],
          properties: { path: { type: 'string' }, pages: { type: 'array' }, text: { type: 'string' }, rendered: { type: 'integer' }, truncated: { type: 'boolean' } },
        },
        description: '扫描版 PDF 的 OCR 流水线：先用 document.ocr.pdfCommand 渲染页面，再对每页执行 document.ocr.command。两者均需管理员配置。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱内 PDF 路径' },
            maxPages: { type: 'integer', minimum: 1, maximum: 20, description: '最多 OCR 页数，默认 5' },
            maxChars: { type: 'integer', minimum: 100, maximum: 40000 },
          },
          required: ['path'],
        },
        async handler(args: { path?: string; maxPages?: number; maxChars?: number }, tctx: ToolContext) {
          const cfg = ctx.config.get<OcrConfig>('document.ocr', {});
          if (!cfg.pdfCommand) return { ok: false, error: '扫描版 PDF OCR 未配置：请设置 document.ocr.pdfCommand（PDF→图片渲染命令）' };
          if (!cfg.command) return { ok: false, error: 'OCR 未配置：请设置 document.ocr.command' };
          const file = resolveInSandbox(tctx.sandboxRoot, String(args.path ?? ''));
          if (isDeniedReadPath(file, tctx.sandboxRoot, ctx.paths?.root ?? tctx.sandboxRoot)) return { ok: false, error: '拒绝读取受保护路径' };
          if (extname(file).toLowerCase() !== '.pdf') return { ok: false, error: 'ocr_pdf 只接受 .pdf 文件' };
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) return { ok: false, error: `PDF 不存在: ${args.path}` };
          if (info.size > MAX_BYTES) return { ok: false, error: `PDF 超过 ${MAX_BYTES} 字节上限` };

          const timeoutMs = Math.max(1_000, Math.min(120_000, Math.floor(Number(cfg.timeoutMs) || 30_000)));
          const maxPages = Math.max(1, Math.min(20, Math.floor(Number(args.maxPages) || 5)));
          const maxChars = Math.max(100, Math.min(MAX_CHARS, Math.floor(Number(args.maxChars) || MAX_CHARS)));
          let outDir = '';
          try {
            outDir = await mkdtemp(join(tmpdir(), 'mh-pdf-ocr-'));
            const pdfArgs = (Array.isArray(cfg.pdfArgs) && cfg.pdfArgs.length
              ? cfg.pdfArgs
              : ['-png', '-r', '150', '{input}', '{outDir}/page'])
              .map((arg) => arg.replaceAll('{input}', file).replaceAll('{outDir}', outDir));
            const render = await runCommand(cfg.pdfCommand, pdfArgs, tctx.sandboxRoot, timeoutMs, tctx.signal);
            const rendered = (await readdir(outDir)).filter((name) => OCR_EXTS.has(extname(name).toLowerCase())).sort().slice(0, maxPages);
            if (!rendered.length) {
              return { ok: false, error: `PDF 页面渲染失败（exit ${render.code}）: ${render.stderr.slice(0, 500) || '没有生成图片'}` };
            }
            const pages: { page: number; text: string }[] = [];
            for (let i = 0; i < rendered.length; i++) {
              const pageFile = join(outDir, rendered[i]!);
              const argv = (Array.isArray(cfg.args) && cfg.args.length ? cfg.args : ['{file}', 'stdout'])
                .map((arg) => arg.replaceAll('{file}', pageFile));
              if (!argv.some((arg) => arg.includes(pageFile))) argv.push(pageFile);
              const ocr = await runCommand(cfg.command, argv, tctx.sandboxRoot, timeoutMs, tctx.signal);
              const text = normalizeText(ocr.stdout);
              pages.push({ page: i + 1, text: text.slice(0, maxChars) });
              if (ocr.code !== 0) {
                return { ok: false, error: `第 ${i + 1} 页 OCR 失败（exit ${ocr.code}）: ${ocr.stderr.slice(0, 500) || '外部引擎未成功完成'}`, data: { pages, partial: true } };
              }
            }
            const text = pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join('\n\n').slice(0, maxChars);
            return {
              ok: true,
              data: { path: String(args.path ?? ''), rendered: rendered.length, pages, text, truncated: text.length >= maxChars },
              evidence: [{ kind: 'content', label: `OCR PDF ${args.path}`, value: text.slice(0, 500) }],
            };
          } catch (err) {
            return { ok: false, error: `PDF OCR 失败: ${err instanceof Error ? err.message : String(err)}` };
          } finally {
            if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
          }
        },
      },
    });

    ctx.logger.info('文件处理就绪：分页读取、Office 创建与定点另存、可选 OCR');
  },
} satisfies Plugin;
