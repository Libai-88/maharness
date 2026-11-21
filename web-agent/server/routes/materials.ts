import type { Express, Request, Response, NextFunction } from 'express';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveInSandbox, isProtectedWritePath } from '../../kernel/sandbox';
import { tenantSandboxRoot } from '../tenant-workspace';
import { assertTenantStorage, invalidateTenantStorage, TenantStorageQuotaError } from '../tenant-quota';
import { MATERIAL_MAX_BYTES, MaterialError } from '../materials';
import { tenantIdOf, type RouteDeps } from './shared';
import type { DocumentService } from '../host/adapters/document';
import type { OcrConfig } from '../host/adapters/document';

export function registerMaterialRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;
  const workspace = (req: Request) => tenantSandboxRoot(kernel.config.get<string>('sandboxRoot', kernel.rootDir), tenantIdOf(req));
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch(error => {
      if (res.headersSent) return next(error);
      const status = error instanceof MaterialError ? error.status : error instanceof TenantStorageQuotaError ? 413 : 400;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error.code ?? 'MATERIAL_ERROR' });
    });
  };
  app.get('/api/materials/capabilities', wrap((_req, res) => {
    const ocr = kernel.config.get<OcrConfig>('document.ocr', {});
    res.json({ document: Boolean(kernel.plugins.resolveService('service:document')), search: kernel.plugins.list().some(p => p.manifest.id === 'search' && p.state === 'started'), ocr: { image: Boolean(ocr.command), pdf: Boolean(ocr.command && ocr.pdfCommand), status: ocr.command ? 'configured' : 'not_configured', config: ocr }, maxBytes: MATERIAL_MAX_BYTES, maxAttachments: 10 });
  }));
  app.put('/api/document/ocr', wrap((req, res) => {
    const role = (req as Request & { apiRole?: string }).apiRole;
    if (role && role !== 'admin') throw new MaterialError(403, 'USER_AUTHORIZATION_REQUIRED', 'OCR 配置需要管理员授权');
    const { command, args, pdfCommand, pdfArgs } = req.body ?? {};
    if (typeof command !== 'string' || typeof pdfCommand !== 'string' || !Array.isArray(args) || !Array.isArray(pdfArgs) || [...args, ...pdfArgs].some(v => typeof v !== 'string') || command.length > 2000 || pdfCommand.length > 2000 || JSON.stringify(req.body).length > 16000) throw new MaterialError(400, 'INVALID_OCR_CONFIG', 'OCR 命令和参数格式无效');
    kernel.config.setPersistent('document.ocr', { command: command.trim(), args, pdfCommand: pdfCommand.trim(), pdfArgs }); res.json({ ok: true });
  }));
  app.post('/api/materials/register', wrap((req, res) => {
    if (typeof req.body?.path !== 'string') throw new MaterialError(400, 'INVALID_PATH', '需要工作区相对路径');
    res.json(store.materials.register(tenantIdOf(req), workspace(req), req.body.path, kernel.rootDir));
  }));
  app.post('/api/materials/artifact', wrap((req, res) => {
    const run = store.runs.get(String(req.body?.runId), tenantIdOf(req));
    if (!run || resolve(run.authorization.workspace) !== resolve(workspace(req))) throw new MaterialError(409, 'WORKSPACE_CHANGED', '请切回生成此文件的工作区后打开');
    const artifact = store.runs.artifacts(run.id).find(item => item.id === req.body?.artifactId && item.kind === 'file');
    if (!artifact) throw new MaterialError(404, 'ARTIFACT_NOT_FOUND', '任务文件不存在');
    const material = store.materials.register(tenantIdOf(req), workspace(req), artifact.ref, kernel.rootDir);
    if (artifact.metadata?.version && artifact.metadata.version !== material.version) throw new MaterialError(409, 'FILE_VERSION_CONFLICT', '产物已被修改，请在文件视图选择当前版本');
    res.json(material);
  }));
  app.post('/api/materials/import', wrap(async (req, res) => {
    if (!(req.get('Content-Type') ?? '').startsWith('application/octet-stream')) throw new MaterialError(415, 'INVALID_CONTENT_TYPE', '请以二进制文件上传');
    if (Number(req.get('Content-Length') ?? 0) > MATERIAL_MAX_BYTES) throw new MaterialError(413, 'MATERIAL_TOO_LARGE', '文件超过 20 MB');
    const name = String(req.query.name ?? 'file').normalize('NFC');
    if (!name || name.length > 160 || name !== basename(name) || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new MaterialError(400, 'INVALID_FILENAME', '文件名无效');
    const base = kernel.config.get<string>('sandboxRoot', kernel.rootDir); const root = workspace(req); const tenantId = tenantIdOf(req);
    const quota = (bytes: number) => assertTenantStorage({ base, tenantId, limitBytes: store.getTenant(tenantId)?.maxStorageBytes ?? 0, additionalBytes: bytes });
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > MATERIAL_MAX_BYTES) throw new MaterialError(413, 'MATERIAL_TOO_LARGE', '文件超过 20 MB'); quota(size); chunks.push(buffer); }
    } catch (error) { req.resume(); throw error; }
    if (req.aborted) throw new MaterialError(400, 'UPLOAD_CANCELLED', '上传已取消');
    const materialId = randomUUID(); const path = join('imports', materialId, name); const file = resolveInSandbox(root, path); if (isProtectedWritePath(file, root)) throw new MaterialError(403, 'MATERIAL_DENIED', '拒绝写入受保护路径');
    await mkdir(resolveInSandbox(root, join(path, '..')), { recursive: true });
    try { quota(size); await writeFile(file, Buffer.concat(chunks), { flag: 'wx' }); const material = store.materials.register(tenantId, root, path, kernel.rootDir, materialId); invalidateTenantStorage(tenantId); res.status(201).json(material); }
    catch (error) { await rm(file, { force: true }).catch(() => undefined); throw error; }
  }));
  app.get('/api/materials/:id', wrap((req, res) => res.json(store.materials.get(String(req.params.id), tenantIdOf(req), workspace(req)))));
  app.get('/api/materials/:id/content', wrap((req, res) => {
    const { material, bytes } = store.materials.resolve({ id: String(req.params.id), version: String(req.query.version ?? '') }, tenantIdOf(req), workspace(req), kernel.rootDir);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.name)}`);
    res.type(material.format === 'pdf' ? 'application/pdf' : 'application/octet-stream').send(bytes);
  }));
  app.get('/api/materials/:id/preview', wrap(async (req, res) => {
    const { material, bytes } = store.materials.resolve({ id: String(req.params.id), version: String(req.query.version ?? '') }, tenantIdOf(req), workspace(req), kernel.rootDir);
    const documents = kernel.plugins.resolveService('service:document') as DocumentService | undefined;
    if (!documents) throw new MaterialError(503, 'DOCUMENT_UNAVAILABLE', '文档插件未启用，请在插件设置中启用');
    const offset = Number(req.query.offset ?? 0); const limit = Number(req.query.limit ?? 60);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MaterialError(400, 'INVALID_RANGE', '读取范围无效');
    const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', close);
    try { res.json(await documents.read(bytes, material.format, { offset, limit, blockId: req.query.block ? String(req.query.block) : undefined }, abort.signal)); } finally { res.off('close', close); }
  }));
}
