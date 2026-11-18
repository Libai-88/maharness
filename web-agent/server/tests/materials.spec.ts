import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../db';
import { RunService } from '../run-service';
import { registerMaterialRoutes } from '../routes/materials';
import { documentService } from '../../core/document/service';
import type { RouteDeps } from '../routes/shared';
import type { AgentLoop } from '../../kernel/loop';
import { Readable } from 'node:stream';

async function setup(fn: (env: { root: string; store: Store; base: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'mh-material-')); const store = new Store(':memory:'); const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { (req as typeof req & { tenantId?: string }).tenantId = req.get('x-maharness-tenant'); next(); });
  const config = new Map<string, unknown>(); config.set('sandboxRoot', root);
  registerMaterialRoutes(app, { store, kernel: { rootDir: root, config: { get: (key: string, fallback: unknown) => config.get(key) ?? fallback, setPersistent: (key: string, value: unknown) => config.set(key, value) }, plugins: { resolveService: () => documentService, list: () => [] } } } as unknown as RouteDeps);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); }); const address = server.address() as { port: number };
  try { await fn({ root, store, base: `http://127.0.0.1:${address.port}` }); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('Binary upload, authenticated reference scope, preview and download form one workflow', async () => setup(async ({ root, base }) => {
  const response = await fetch(`${base}/api/materials/import?name=${encodeURIComponent('学习资料.md')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: '# 研究问题\n说明' }); assert.equal(response.status, 201); const material = await response.json() as import('../../kernel/material').Material; assert.match(material.path, /^imports[\\/]/); assert.equal(readdirSync(join(root, 'imports')).length, 1);
  const preview = await fetch(`${base}/api/materials/${material.id}/preview?version=${material.version}`); assert.equal(preview.status, 200); assert.match((await preview.json() as { blocks: { text: string }[] }).blocks[0]!.text, /研究问题/);
  const file = await fetch(`${base}/api/materials/${material.id}/content?version=${material.version}`); assert.equal(file.headers.get('x-content-type-options'), 'nosniff'); assert.match(await file.text(), /研究问题/);
  const other = await fetch(`${base}/api/materials/${material.id}`, { headers: { 'x-maharness-tenant': 'another' } }); assert.equal(other.status, 404);
}));
test('File import rejects protected names, non-binary requests, size overflow and traversal', async () => setup(async ({ root, base }) => {
  const json = await fetch(`${base}/api/materials/import?name=a.md`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(json.status, 415);
  const bad = await fetch(`${base}/api/materials/import?name=..%2Fsecret`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' }); assert.equal(bad.status, 400);
  const huge = await fetch(`${base}/api/materials/import?name=huge.md`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(20 * 1024 * 1024 + 1) }); assert.equal(huge.status, 413);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data', 'secret.md'), 'secret');
  for (const path of ['../outside', 'data/secret.md']) { const result = await fetch(`${base}/api/materials/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }); assert.ok([400, 403].includes(result.status)); }
}));
test('Changed files and stale source links return version conflicts', async () => setup(async ({ root, store, base }) => {
  writeFileSync(join(root, 'a.md'), 'first'); const material = store.materials.register('default', root, 'a.md', root); writeFileSync(join(root, 'a.md'), 'second');
  const response = await fetch(`${base}/api/materials/${material.id}/content?version=${material.version}`); assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, 'FILE_VERSION_CONFLICT');
}));
test('Duplicate upload names stay separate and storage quotas reject before publication', async () => setup(async ({ root, store, base }) => {
  const upload = (body: string) => fetch(`${base}/api/materials/import?name=same.md`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  const first = await (await upload('one')).json() as import('../../kernel/material').Material;
  const second = await (await upload('two')).json() as import('../../kernel/material').Material;
  assert.notEqual(first.path, second.path); assert.ok(first.path.includes(first.id)); assert.ok(second.path.includes(second.id));
  store.updateTenantQuotas('default', { maxStorageBytes: 7 });
  assert.equal((await upload('over quota')).status, 413); assert.equal(readdirSync(join(root, 'imports')).length, 2);
}));
test('Chunked oversized uploads return 413 without publishing a file', async () => setup(async ({ root, base }) => {
  const body = Readable.from((async function* () { yield Buffer.alloc(20 * 1024 * 1024); yield Buffer.alloc(1); })());
  const response = await fetch(`${base}/api/materials/import?name=large.md`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: body as never, duplex: 'half' } as RequestInit);
  assert.equal(response.status, 413); assert.equal(readdirSync(root).includes('imports'), false);
}));
test('Material limits, duplicates and workspace isolation are enforced before execution', async () => setup(async ({ root, store }) => {
  writeFileSync(join(root, 'a.md'), 'safe'); const material = store.materials.register('default', root, 'a.md', root);
  assert.throws(() => store.materials.validate([material, material], 'default', root, root), /重复/);
  assert.throws(() => store.materials.validate(Array(11).fill(material), 'default', root, root), /最多/);
  assert.throws(() => store.materials.resolve(material, 'other', root, root), /不存在/);
  mkdirSync(join(root, 'other')); assert.throws(() => store.materials.resolve(material, 'default', join(root, 'other'), root), /不存在/);
}));
test('Run references persist in checkpoints and participate in idempotency', async () => setup(async ({ root, store }) => {
  writeFileSync(join(root, 'a.md'), 'safe'); writeFileSync(join(root, 'b.md'), 'other'); const a = store.materials.register('default', root, 'a.md', root), b = store.materials.register('default', root, 'b.md', root);
  const runner: AgentLoop = { approveApproval: () => false, async *run() { yield { type: 'assistant_done', content: 'ok', reasoning: '', usage: { input: 0, output: 0 }, cost: 0 }; } };
  const service = new RunService({ store, runner: () => runner, workspace: () => root, provider: () => ({ id: 'test', model: 'test' }), prepare: () => ({ provider: { id: 'test', label: 'test', defaultModel: 'test', async *chat() {} }, model: 'test', messages: [], traceId: '' }) });
  try { const session = store.createSession('test', 'test'); const run = service.create(session, { message: 'read', materials: [a], requestKey: 'same' }); assert.equal(service.create(session, { message: 'read', materials: [a], requestKey: 'same' }).id, run.id); assert.throws(() => service.create(session, { message: 'read', materials: [b], requestKey: 'same' }), /不同/); assert.equal(service.get(run.id, 'default').materials?.[0]?.version, a.version); assert.match(JSON.stringify(store.runs.checkpoint(run.id)), /material-references/); } finally { await service.shutdown(); }
}));
test('Schema 7 migration retains sessions and adds the material registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-schema8-')); const path = join(root, 'test.sqlite'); let store: Store | undefined = new Store(path); const session = store.createSession('test', 'test'); store.close();
  const raw = new Database(path); raw.exec('DROP TABLE materials_v1; DROP TABLE run_materials_v1; PRAGMA user_version=7'); raw.close();
  try {
    store = new Store(path);
    assert.equal(store.schemaVersion, 15);
    assert.equal(store.listSessions()[0]?.id, session.id);
    const tables = new Set((store as unknown as { db: Database.Database }).db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: unknown) => (row as { name: string }).name));
    assert.ok(tables.has('automations_v3')); assert.ok(tables.has('automation_occurrences_v3')); assert.ok(tables.has('automation_trigger_baselines_v3'));
    writeFileSync(join(root, 'note.md'), 'test'); assert.ok(store.materials.register('default', root, 'note.md', root).id);
    assert.ok(readdirSync(root).some(name => name.includes('.pre-v2-')));
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
