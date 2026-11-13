/**
 * core/document/index.ts —— 文档读取插件
 *
 * 第一阶段：PDF / DOCX 文本抽取（pdf-parse / mammoth）。
 * 后续可扩展 OCR、Office、表格与页码引用。
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import type { Plugin, ToolContext } from '../../kernel/types';
import { isDeniedReadPath, resolveInSandbox } from '../../kernel/sandbox';
import { buildProcessEnv } from '../../kernel/plugin-process';

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

async function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      env: buildProcessEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && !/\.exe$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch { try { child.kill(); } catch { /* 忽略 */ } }
      } else {
        try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      }
    };
    const timer = setTimeout(() => { killTree(); reject(new Error(`外部命令超时（${timeoutMs}ms）`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number(code);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    });
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ''));
}

function extractHtmlTables(html: string): { page?: number; rows: string[][] }[] {
  const out: { page?: number; rows: string[][] }[] = [];
  let cells = 0;
  for (const tableMatch of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (out.length >= MAX_TABLES || cells >= MAX_TABLE_CELLS) break;
    const rows: string[][] = [];
    for (const rowMatch of (tableMatch[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (rows.length >= MAX_TABLE_ROWS || cells >= MAX_TABLE_CELLS) break;
      const row: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        if (cells >= MAX_TABLE_CELLS) break;
        row.push(decodeEntities((cellMatch[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
        cells++;
      }
      if (row.length) rows.push(row);
    }
    if (rows.length) out.push({ rows });
  }
  return out;
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
  name: '文档读取',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'document-rules',
        name: '文档读取规则',
        description: '引导 PDF 等二进制文档使用 document 工具',
        priority: 4,
        content: [
          '文档读取规则：',
          '1. read_file 不支持 PDF/DOCX 等二进制文档；需要正文时用 read_document；',
          '2. 大文档先用 pages 指定页范围，避免整本塞入上下文；',
          '3. 需要表格时保持 tables=true（默认），PDF 按页返回检测到的表格，DOCX 按文档顺序返回；',
          '4. 引用文档内容时标注页码或表格序号；抽取失败要如实说明，不要编造原文；',
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
          if (format === '.docx') {
            try {
              const buffer = await readFile(file);
              let text = '';
              let tables: { rows: string[][] }[] = [];
              if (includeTables) {
                const html = await mammoth.convertToHtml({ buffer }, { ignoreEmptyParagraphs: true });
                text = normalizeText(htmlToText(html.value ?? ''));
                tables = extractHtmlTables(html.value ?? '').slice(0, MAX_TABLES).map((table) => ({
                  rows: normalizeTableRows(table.rows),
                }));
              } else {
                const result = await mammoth.extractRawText({ buffer });
                text = normalizeText(result.value ?? '');
              }
              const truncated = text.length > maxChars;
              return {
                ok: true,
                data: {
                  path: raw, format: 'docx', totalChars: text.length, truncated,
                  text: truncated ? text.slice(0, maxChars) : text,
                  tables, tableCount: tables.length,
                },
              };
            } catch (err) {
              return { ok: false, error: `DOCX 解析失败: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
          let parser: PDFParse | undefined;
          try {
            parser = new PDFParse({ data: await readFile(file) });
            const result = await parser.getText(pages?.length ? { partial: pages } : undefined);
            const text = normalizeText(result.text ?? '');
            const truncated = text.length > maxChars;
            let tables: { page?: number; rows: string[][] }[] = [];
            let tableWarning: string | undefined;
            if (includeTables) {
              try {
                const tableResult = await parser.getTable(pages?.length ? { partial: pages } : undefined);
                tables = tableResult.pages.flatMap((page) => page.tables.map((rows) => ({
                  page: page.num,
                  rows: normalizeTableRows(rows),
                }))).filter((table) => table.rows.length > 0).slice(0, MAX_TABLES);
              } catch (err) {
                tableWarning = `表格检测失败: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
            return {
              ok: true,
              data: {
                path: raw,
                format: 'pdf',
                pages: pages?.length ? pages : undefined,
                totalChars: text.length,
                truncated,
                text: truncated ? text.slice(0, maxChars) : text,
                tables,
                tableCount: tables.length,
                ...(tableWarning ? { tableWarning } : {}),
              },
            };
          } catch (err) {
            return { ok: false, error: `PDF 解析失败: ${err instanceof Error ? err.message : String(err)}` };
          } finally {
            await parser?.destroy().catch(() => undefined);
          }
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
          if (isDeniedReadPath(file, tctx.sandboxRoot)) return { ok: false, error: '拒绝读取受保护路径' };
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
            const result = await runCommand(cfg.command, argv, tctx.sandboxRoot, timeoutMs);
            const text = normalizeText(result.stdout);
            if (result.code !== 0 && !text) {
              return { ok: false, error: `OCR 失败（exit ${result.code}）: ${result.stderr.slice(0, 500) || '无输出'}` };
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
          if (isDeniedReadPath(file, tctx.sandboxRoot)) return { ok: false, error: '拒绝读取受保护路径' };
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
            const render = await runCommand(cfg.pdfCommand, pdfArgs, tctx.sandboxRoot, timeoutMs);
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
              const ocr = await runCommand(cfg.command, argv, tctx.sandboxRoot, timeoutMs);
              const text = normalizeText(ocr.stdout);
              pages.push({ page: i + 1, text: text.slice(0, maxChars) });
              if (ocr.code !== 0 && !text) {
                return { ok: false, error: `第 ${i + 1} 页 OCR 失败（exit ${ocr.code}）: ${ocr.stderr.slice(0, 500) || '无输出'}` };
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

    ctx.logger.info('文档读取就绪: read_document（PDF 文本抽取）/ ocr_image / ocr_pdf');
  },
} satisfies Plugin;
