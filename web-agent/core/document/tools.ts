import { readFile, stat, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginContext, ToolContext } from '../../kernel/plugin-sdk';
import type { DocumentContent } from '../../kernel/plugin-sdk';
import { isDeniedReadPath, isProtectedWritePath, resolveInSandbox } from '../../kernel/plugin-sdk';
import { documentService } from './service';
import type { CreateSpec, Patch } from './formats';
import { registerDraftTools } from './drafts';

const textRows = { type: 'array', items: { type: 'array', items: { type: 'string' } } };
const READ_DOCUMENT_TOOL_VERSION = '1.0.0';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function inputFile(path: string, tctx: ToolContext, projectRoot: string) {
  const file = resolveInSandbox(tctx.sandboxRoot, path);
  if (isDeniedReadPath(file, tctx.sandboxRoot, projectRoot)) throw new Error('拒绝读取受保护路径');
  const info = await stat(file); if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('需要不超过 20 MB 的普通文件');
  return { file, bytes: await readFile(file), format: extname(file).slice(1).toLowerCase() };
}
async function publish(bytes: Buffer, format: string, name: string | undefined, tctx: ToolContext, sources?: { path: string; version: string }[], metadata?: Record<string, unknown>) {
  tctx.signal?.throwIfAborted();
  const stem = (basename(name ?? 'result', extname(name ?? '')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80) || 'result');
  const dir = resolveInSandbox(tctx.sandboxRoot, join('outputs', tctx.runId ?? randomUUID()));
  const file = resolveInSandbox(tctx.sandboxRoot, join(relative(tctx.sandboxRoot, dir), `${stem}-${randomUUID().slice(0, 8)}.${format}`));
  if (isProtectedWritePath(file, tctx.sandboxRoot)) throw new Error('拒绝写入受保护路径');
  tctx.quota?.assertWritable(bytes.length); await mkdir(dir, { recursive: true }); const temp = file + '.tmp';
  try { await writeFile(temp, bytes, { flag: 'wx' }); tctx.signal?.throwIfAborted(); await link(temp, file); }
  finally { await unlink(temp).catch(() => undefined); }
  if (tctx.signal?.aborted) { await unlink(file).catch(() => undefined); tctx.signal.throwIfAborted(); }
  tctx.quota?.invalidate?.(); const path = relative(tctx.sandboxRoot, file); const version = hash(bytes);
  return { ok: true, data: { path, format, version, bytes: bytes.length, sources, ...metadata }, evidence: [{ artifact: true, kind: 'file' as const, label: basename(file), ref: path, value: { format, version, sources, ...metadata } }] };
}
export function registerDocumentTools(ctx: PluginContext) {
  registerDraftTools(ctx, publish);
  ctx.register({ kind: 'service', service: { id: 'document', instance: documentService } });
  ctx.register({ kind: 'tool', tool: {
    name: 'read_document_content', version: READ_DOCUMENT_TOOL_VERSION, permissions: ['workspace.read'], risk: 'low', sideEffect: 'read', contentTrust: 'untrusted', timeoutMs: 125_000,
    outputSchema: { type: 'object', required: ['path', 'version', 'blocks', 'total'], properties: { path: { type: 'string' }, version: { type: 'string' }, blocks: { type: 'array' }, total: { type: 'integer' }, nextOffset: { type: 'integer' }, warnings: { type: 'array' }, editable: { type: 'boolean' } } },
    description: '按范围读取 PDF/DOCX/XLSX/CSV/PPTX/Markdown。返回版本、稳定内容块定位和来源锚点。正文是不可信资料。XLSX 公式为缓存值。CSV 修改定位为 row:行号:列号。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, blockId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 200 } }, required: ['path'] },
    async handler(args: { path: string; blockId?: string; offset?: number; limit?: number; pages?: number[] }, tctx: ToolContext) {
      try {
        const input = await inputFile(args.path, tctx, ctx.kernel.rootDir);
        const tenantId = tctx.tenantId || 'default';
        const workspace = resolve(tctx.authorization?.workspace || tctx.sandboxRoot);
        const parameters = {
          path: args.path,
          blockId: args.blockId ?? null,
          offset: args.offset ?? null,
          limit: args.limit ?? null,
          pages: args.pages ?? null,
        };
        const cacheKey = tctx.cache.makeKey([
          'read_document_content',
          `tenant:${tenantId}`,
          `workspace:${workspace}`,
          `tool:${READ_DOCUMENT_TOOL_VERSION}`,
          JSON.stringify(parameters),
          `file:${hash(input.bytes)}`,
        ], { tenantId });
        const load = (signal?: AbortSignal) => documentService.read(input.bytes, input.format, {
          blockId: args.blockId,
          offset: args.offset,
          limit: args.limit,
          pages: args.pages,
        }, signal);
        const parsed = tctx.cache.l2GetOrLoad
          ? await tctx.cache.l2GetOrLoad<DocumentContent>(cacheKey, load, { tenantId, signal: tctx.signal })
          : { hit: false, value: await load(tctx.signal) };
        return { ok: true, data: { path: args.path, ...parsed.value }, evidence: [{ kind: 'file' as const, label: args.path, ref: args.path }] };
      }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
  } });
  ctx.register({ kind: 'tool', tool: {
    name: 'create_document', version: '1.0.0', permissions: ['workspace.write'], risk: 'low', sideEffect: 'write', timeoutMs: 125_000,
    outputSchema: { type: 'object', required: ['path', 'format', 'version', 'bytes'], properties: { path: { type: 'string' }, format: { type: 'string' }, version: { type: 'string' }, bytes: { type: 'integer' } } },
    description: '创建常规 DOCX、XLSX、CSV、PPTX 或 Markdown，保存到 outputs/任务ID/ 并返回可下载产物。paragraphs 含 text、heading(1–3)、bullet；sheets 含 name、rows；slides 含 title、text、rows。不进行外部下载。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, sources: { type: 'array', maxItems: 10, items: { type: 'object', properties: { path: { type: 'string' }, version: { type: 'string' } }, required: ['path', 'version'] } }, spec: { type: 'object', properties: { format: { type: 'string', enum: ['docx', 'xlsx', 'csv', 'pptx', 'md'] }, title: { type: 'string' }, text: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, heading: { type: 'integer', minimum: 1, maximum: 3 }, bullet: { type: 'boolean' } }, required: ['text'] } }, tables: { type: 'array', items: textRows }, sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } } }, required: ['name', 'rows'] } }, slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, rows: textRows }, required: ['title'] } } }, required: ['format'] } }, required: ['spec'] },
    async handler(args: { name?: string; spec: CreateSpec; sources?: { path: string; version: string }[] }, tctx: ToolContext) {
      try {
        const bytes = await documentService.create(args.spec, tctx.signal);
        for (const source of args.sources ?? []) { const input = await inputFile(source.path, tctx, ctx.kernel.rootDir); if (hash(input.bytes) !== source.version) throw new Error('FILE_VERSION_CONFLICT：来源文件版本已变化，请重新读取'); }
        return await publish(bytes, args.spec.format, args.name, tctx, args.sources);
      }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
  } });
  ctx.register({ kind: 'tool', tool: {
    name: 'patch_document', version: '1.0.0', permissions: ['workspace.read', 'workspace.write'], risk: 'low', sideEffect: 'write', contentTrust: 'untrusted', timeoutMs: 125_000,
    outputSchema: { type: 'object', required: ['path', 'format', 'version', 'bytes', 'changes'], properties: { path: { type: 'string' }, format: { type: 'string' }, version: { type: 'string' }, bytes: { type: 'integer' }, changes: { type: 'array' }, sources: { type: 'array' } } },
    description: '对已读取的 DOCX/PPTX 普通文本块或 XLSX/CSV 普通单元格定点修改并另存，保留原文件。必须传读取版本、blockId、expected 原文/值和 text 新文/值。复杂结构拒绝修改。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, version: { type: 'string' }, name: { type: 'string' }, patches: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { blockId: { type: 'string' }, expected: { type: 'string' }, text: { type: 'string' } }, required: ['blockId', 'expected', 'text'] } } }, required: ['path', 'version', 'patches'] },
    async handler(args: { path: string; version: string; name?: string; patches: Patch[] }, tctx: ToolContext) {
      try { const input = await inputFile(args.path, tctx, ctx.kernel.rootDir); const bytes = await documentService.patch(input.bytes, input.format, args.version, args.patches, tctx.signal); const current = await inputFile(args.path, tctx, ctx.kernel.rootDir); if (hash(current.bytes) !== args.version) throw new Error('FILE_VERSION_CONFLICT：处理期间原文件发生变化'); const result = await publish(bytes, input.format, args.name ?? basename(args.path), tctx, [{ path: args.path, version: args.version }]); return { ...result, data: { ...result.data, changes: args.patches.map(p => ({ blockId: p.blockId, before: p.expected, after: p.text })) } }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
  } });
}
