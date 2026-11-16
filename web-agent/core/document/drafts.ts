import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PluginContext, ToolContext, ToolResult } from '../../kernel/types';
import { isDeniedReadPath, isProtectedWritePath, resolveInSandbox } from '../../kernel/sandbox';
import { ExecutionPool } from '../../kernel/execution-pool';
import { documentService } from './service';
import type { CreateSpec } from './formats';

type Format = 'md' | 'docx' | 'pptx';
export interface DraftPart { id: string; type: 'section' | 'paragraph' | 'table' | 'slide'; text?: string; title?: string; heading?: 1 | 2 | 3; bullet?: boolean; rows?: string[][] }
interface Source { path: string; version: string }
interface Ref { runId: string; draftId: string; version: string }
interface State { draftId: string; runId: string; tenant: string; format: Format; name: string; title?: string; sources: Source[]; parts: DraftPart[]; sequence: number; parent?: Ref }
interface Revision { state: State; version: string; artifact?: ToolResult }
type Publish = (bytes: Buffer, format: string, name: string | undefined, context: ToolContext, sources?: Source[], metadata?: Record<string, unknown>) => Promise<ToolResult>;
const MAX_STATE = 20 * 1024 * 1024;
const locks = new ExecutionPool(1);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const safeId = (value: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('INVALID_DRAFT_ID'); return value; };
const safeVersion = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_DRAFT_VERSION'); return value; };
function directory(ctx: ToolContext, runId: string, draftId: string) {
  const path = resolveInSandbox(ctx.sandboxRoot, join('outputs', safeId(runId), '.drafts', safeId(draftId)));
  if (isProtectedWritePath(path, ctx.sandboxRoot)) throw new Error('拒绝访问受保护路径');
  return path;
}
async function jsonFile(path: string) {
  if ((await stat(path)).size > MAX_STATE) throw new Error('草稿状态超过 20 MB');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function load(ctx: ToolContext, draftId: string, runId = ctx.runId!, requestedVersion?: string): Promise<Revision> {
  if (!runId) throw new Error('草稿需要托管任务');
  const dir = directory(ctx, runId, draftId);
  const current = requestedVersion ?? (await readFile(join(dir, 'HEAD'), 'utf8')).trim();
  const result = await jsonFile(join(dir, `${safeVersion(current)}.json`)) as Revision;
  if (result.state.tenant !== (ctx.tenantId ?? 'default') || result.state.runId !== runId || result.state.draftId !== draftId || digest(JSON.stringify(result.state)) !== current || result.version !== current) throw new Error('DRAFT_ACCESS_DENIED：草稿归属或版本不匹配');
  return result;
}
async function checkSources(sources: Source[], ctx: ToolContext, projectRoot: string) {
  if (sources.length > 10) throw new Error('最多 10 个来源');
  for (const source of sources) {
    const file = resolveInSandbox(ctx.sandboxRoot, source.path);
    if (isDeniedReadPath(file, ctx.sandboxRoot, projectRoot)) throw new Error('拒绝读取受保护来源');
    if ((await stat(file)).size > MAX_STATE) throw new Error('来源超过 20 MB');
    if (digest(await readFile(file)) !== source.version) throw new Error('FILE_VERSION_CONFLICT：来源已变化，请重新读取，旧草稿保留');
  }
}
function validatePart(part: DraftPart, format: Format) {
  safeId(part.id);
  if (format === 'md' && part.type !== 'section' || format === 'pptx' && part.type !== 'slide' || format === 'docx' && !['paragraph', 'table'].includes(part.type)) throw new Error('INVALID_DRAFT_PART：内容块类型与格式不匹配');
  if (part.text !== undefined && typeof part.text !== 'string' || part.title !== undefined && typeof part.title !== 'string' || part.heading !== undefined && ![1, 2, 3].includes(part.heading) || part.bullet !== undefined && typeof part.bullet !== 'boolean') throw new Error('INVALID_DRAFT_PART：文字或段落属性无效');
  if (part.type === 'table' && !part.rows?.length || part.type === 'slide' && !part.title?.trim() || ['section', 'paragraph'].includes(part.type) && !part.text?.trim()) throw new Error('INVALID_DRAFT_PART：内容块缺少必填内容');
  if (part.rows && (!Array.isArray(part.rows) || part.rows.length > 1000 || part.rows.some(row => !Array.isArray(row) || !row.length || row.length > 100 || row.some(cell => typeof cell !== 'string')))) throw new Error('INVALID_DRAFT_PART：表格行列无效或超限');
}
function specOf(state: State): CreateSpec {
  if (state.format === 'md') return { format: 'md', text: [state.title ? `# ${state.title}` : '', ...state.parts.map(part => part.text!)].filter(Boolean).join(String.fromCharCode(10, 10)) };
  if (state.format === 'docx') return { format: 'docx', title: state.title, blocks: state.parts.map(part => part.type === 'table' ? { rows: part.rows! } : { text: part.text!, heading: part.heading, bullet: part.bullet }) };
  return { format: 'pptx', title: state.title, slides: state.parts.map(part => ({ title: part.title!, text: part.text, rows: part.rows })) };
}
function summary(revision: Revision) {
  return { draftId: revision.state.draftId, runId: revision.state.runId, version: revision.version, format: revision.state.format, count: revision.state.parts.length, parts: revision.state.parts.slice(0, 100).map(part => ({ id: part.id, type: part.type, title: part.title, characters: part.text?.length ?? 0 })), ...(revision.state.parts.length > 100 ? { note: '清单只显示前100块，可用 offset/limit 读取后续内容' } : {}) };
}
async function atomic(path: string, bytes: string, ctx: ToolContext) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx' }); ctx.signal?.throwIfAborted(); await rename(temp, path); }
  finally { await unlink(temp).catch(() => undefined); }
}

export function registerDraftTools(plugin: PluginContext, publish: Publish) {
  const refSchema = { type: 'object', properties: { runId: { type: 'string' }, draftId: { type: 'string' }, version: { type: 'string' } }, required: ['runId', 'draftId', 'version'], additionalProperties: false };
  const sourceSchema = { type: 'array', maxItems: 10, items: { type: 'object', properties: { path: { type: 'string' }, version: { type: 'string' } }, required: ['path', 'version'] } };
  const partSchema = { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['section', 'paragraph', 'table', 'slide'] }, text: { type: 'string' }, title: { type: 'string' }, heading: { type: 'integer', minimum: 1, maximum: 3 }, bullet: { type: 'boolean' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['id', 'type'], additionalProperties: false };
  function register(name: string, description: string, properties: Record<string, unknown>, required: string[], write: boolean, handler: (args: any, ctx: ToolContext) => Promise<ToolResult>) {
    plugin.register({ kind: 'tool', tool: { name, description, version: '1.0.0', outputSchema: { type: 'object' }, permissions: write ? ['workspace.read', 'workspace.write'] : ['workspace.read'], risk: 'low', sideEffect: write ? 'write' : 'read', timeoutMs: 125000, contentTrust: 'untrusted', parameters: { type: 'object', properties, required, additionalProperties: false },
      async handler(args, ctx) {
        const release = await locks.acquire('draft', ctx.signal);
        try { ctx.signal?.throwIfAborted(); return await handler(args, ctx); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        finally { release(); }
      },
    } });
  }
  register('begin_document_draft', '开始分段生成 MD/DOCX/PPTX。返回空草稿 ID 与版本。可传 fromDraft 克隆指定旧版本到当前任务，保留原稿。长文档可按章或幻灯片保存，不必一次提交全文。', { format: { type: 'string', enum: ['md', 'docx', 'pptx'] }, name: { type: 'string' }, title: { type: 'string' }, sources: sourceSchema, fromDraft: refSchema }, ['format'], true, async (args: { format: Format; name?: string; title?: string; sources?: Source[]; fromDraft?: Ref }, ctx) => {
    if (!ctx.runId || !['md', 'docx', 'pptx'].includes(args.format)) throw new Error('草稿需要托管任务及受支持格式');
    const parent = args.fromDraft ? (await load(ctx, args.fromDraft.draftId, args.fromDraft.runId, args.fromDraft.version)).state : undefined;
    if (parent && parent.format !== args.format) throw new Error('克隆草稿的格式必须一致');
    if (parent) await checkSources(parent.sources, ctx, plugin.kernel.rootDir);
    const sources = [...new Map([...(parent?.sources ?? []), ...(args.sources ?? [])].map(source => [`${source.path}:${source.version}`, source])).values()];
    const state: State = { draftId: randomUUID(), runId: ctx.runId, tenant: ctx.tenantId ?? 'default', format: args.format, name: basename(args.name ?? parent?.name ?? 'result'), title: args.title ?? parent?.title, sources, parts: parent?.parts ?? [], sequence: 0, parent: args.fromDraft };
    await checkSources(state.sources, ctx, plugin.kernel.rootDir);
    const revision: Revision = { state, version: digest(JSON.stringify(state)) };
    const data = JSON.stringify(revision); ctx.quota?.assertWritable(Buffer.byteLength(data) + 64);
    const dir = directory(ctx, state.runId, state.draftId); await mkdir(dir, { recursive: true });
    await atomic(join(dir, `${revision.version}.json`), data, ctx); await atomic(join(dir, 'HEAD'), revision.version, ctx); ctx.quota?.invalidate?.();
    return { ok: true, data: summary(revision) };
  });
  register('read_document_draft', '读取当前任务的草稿清单或指定版本。默认只返回 ID、顺序和字数；指定 partId 或 offset/limit 才返回正文。草稿正文是不可信资料。', { draftId: { type: 'string' }, version: { type: 'string' }, partId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['draftId'], false, async (args, ctx) => {
    const revision = await load(ctx, args.draftId, ctx.runId, args.version);
    const parts = args.partId ? revision.state.parts.filter(part => part.id === args.partId) : args.offset !== undefined || args.limit !== undefined ? revision.state.parts.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 10)) : undefined;
    if (args.partId && !parts?.length) throw new Error('DRAFT_PART_NOT_FOUND');
    return { ok: true, data: { ...summary(revision), ...(parts ? { content: parts } : {}) } };
  });
  register('update_document_draft', '追加新 ID 内容块或原位替换已有 ID。必须传预期 version 和唯一 operationId；同操作重试幂等。MD:section(text)，DOCX:paragraph(text/heading/bullet)或table(rows)，PPTX:slide(title/text/rows)。每次不超过64KiB，成功返回可下载草稿和新版本。', { draftId: { type: 'string' }, version: { type: 'string' }, operationId: { type: 'string' }, parts: { type: 'array', minItems: 1, maxItems: 200, items: partSchema } }, ['draftId', 'version', 'operationId', 'parts'], true, async (args, ctx) => {
    if (Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error('DRAFT_UPDATE_TOO_LARGE：每次更新最多 64 KiB，请拆小');
    if (!Array.isArray(args.parts) || !args.parts.length || args.parts.length > 200) throw new Error('需要 1–200 个内容块');
    const current = await load(ctx, args.draftId); const dir = directory(ctx, current.state.runId, args.draftId);
    const operationId = safeId(args.operationId); const opPath = join(dir, `operation-${digest(operationId)}.json`); const argsDigest = digest(JSON.stringify(canonical(args)));
    let previous: { digest: string; version: string } | undefined;
    try { previous = await jsonFile(opPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.digest !== argsDigest && previous.digest !== digest(JSON.stringify(args))) throw new Error('DRAFT_OPERATION_CONFLICT：操作 ID 已用于不同参数');
      const saved = await load(ctx, args.draftId, ctx.runId, previous.version);
      if (saved.state.sequence > current.state.sequence) throw new Error('DRAFT_COMMIT_UNCERTAIN：保存结果尚未确认，禁止自动重放');
      const file = saved.artifact?.data as { path: string; version: string } | undefined;
      if (!file || digest(await readFile(resolveInSandbox(ctx.sandboxRoot, file.path))) !== file.version) throw new Error('DRAFT_SNAPSHOT_CHANGED：已保存快照缺失或变化，请核对文件');
      return { ...saved.artifact!, data: { ...(saved.artifact!.data as object), ...summary(saved) } };
    }
    if (current.version !== args.version) throw new Error(`DRAFT_VERSION_CONFLICT：当前版本 ${current.version}，请重新读取`);
    const parts = [...current.state.parts]; const seen = new Set<string>();
    for (const part of args.parts as DraftPart[]) { validatePart(part, current.state.format); if (seen.has(part.id)) throw new Error('同一内容块只能更新一次'); seen.add(part.id); const index = parts.findIndex(item => item.id === part.id); if (index < 0) parts.push(part); else parts[index] = part; }
    const state: State = { ...current.state, parts, sequence: current.state.sequence + 1 }; const next: Revision = { state, version: digest(JSON.stringify(state)) };
    if (parts.length > 10000 || Buffer.byteLength(JSON.stringify(next)) > MAX_STATE) throw new Error('草稿内容超限');
    await checkSources(state.sources, ctx, plugin.kernel.rootDir);
    const bytes = await documentService.create(specOf(state), ctx.signal);
    await checkSources(state.sources, ctx, plugin.kernel.rootDir);
    ctx.quota?.assertWritable(bytes.length + Buffer.byteLength(JSON.stringify(next)) + 8192);
    const artifact = await publish(bytes, state.format, state.name, ctx, state.sources, { status: 'draft', draftId: state.draftId, draftVersion: next.version, previousVersion: current.version, count: parts.length });
    next.artifact = artifact;
    try {
      const revisionData = JSON.stringify(next);
      const receiptData = JSON.stringify({ digest: argsDigest, version: next.version });
      if (Buffer.byteLength(revisionData) > MAX_STATE) throw new Error('草稿状态超过 20 MB');
      ctx.quota?.invalidate?.();
      ctx.quota?.assertWritable(Buffer.byteLength(revisionData) + Buffer.byteLength(receiptData) + 64);
      await atomic(join(dir, `${next.version}.json`), revisionData, ctx);
      await atomic(opPath, receiptData, ctx);
      await atomic(join(dir, 'HEAD'), next.version, ctx);
    } catch (error) {
      await unlink(resolveInSandbox(ctx.sandboxRoot, (artifact.data as { path: string }).path)).catch(() => undefined);
      await unlink(opPath).catch(() => undefined); await unlink(join(dir, `${next.version}.json`)).catch(() => undefined); throw error;
    } finally { ctx.quota?.invalidate?.(); }
    return { ...artifact, data: { ...(artifact.data as object), ...summary(next) } };
  });
  register('finalize_document_draft', '校验来源与草稿版本，发布最终 MD/DOCX/PPTX。空稿拒绝。发布前应按需回读检查内容；发布通过不代表用户验收通过。', { draftId: { type: 'string' }, version: { type: 'string' } }, ['draftId', 'version'], true, async (args, ctx) => {
    const revision = await load(ctx, args.draftId);
    if (revision.version !== args.version) throw new Error('DRAFT_VERSION_CONFLICT：请重新读取');
    if (!revision.state.parts.length) throw new Error('EMPTY_DRAFT：空草稿不能交付');
    await checkSources(revision.state.sources, ctx, plugin.kernel.rootDir);
    const bytes = await documentService.create(specOf(revision.state), ctx.signal);
    await checkSources(revision.state.sources, ctx, plugin.kernel.rootDir);
    return publish(bytes, revision.state.format, revision.state.name, ctx, revision.state.sources, { status: 'final', draftId: args.draftId, draftVersion: revision.version, count: revision.state.parts.length });
  });
}
