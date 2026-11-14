import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Store } from '../db';
import { RunService } from '../run-service';
import { registerRunRoutes } from '../routes/runs';
import type { RouteDeps } from '../routes/shared';
import type { RunOptions } from '../../kernel/loop';
import type { ProviderDef } from '../../kernel/types';

test('workspace plugin grants are independent, revision checked, tenant scoped and cannot widen on recovery', async () => {
  const store = new Store(':memory:'); let snapshot: RunOptions | undefined;
  const provider = { id: 'mock', defaultModel: 'mock' } as ProviderDef;
  const service = new RunService({ store, workspace: tenant => `workspace-${tenant}`, provider: () => ({ id: 'mock', model: 'mock' }), prepare: () => ({ provider, model: 'mock', traceId: '', messages: [] }), runner: () => ({ approveApproval: () => false, async *run(options) { snapshot = options; yield { type: 'error', error: 'checkpoint', kind: 'max-turns' }; } }) });
  const finish = (id: string) => new Promise<void>(resolve => { const off = service.subscribe(id, event => { if (event.type === 'state' && event.data.status === 'interrupted') { off(); resolve(); } }); });
  try {
    assert.equal(service.workspacePermission('default').pluginDevelopment.enabled, false);
    const updated = service.setPluginDevelopment('default', { enabled: true, permissions: ['workspace.read'], dependencies: [] }, 0);
    assert.equal(updated.profile, 'standard'); assert.equal(updated.revision, 1);
    assert.equal(service.workspacePermission('other').pluginDevelopment.enabled, false);
    assert.throws(() => service.setPluginDevelopment('default', { enabled: false, permissions: [], dependencies: [] }, 0), /刷新/);
    const session = store.createSession('mock', 'mock');
    const run = service.create(session, { message: 'inspect', principalRole: 'admin' }); await finish(run.id);
    assert.deepEqual(snapshot!.authorization!.pluginDevelopment?.permissions, ['workspace.read']);
    service.setPluginDevelopment('default', { enabled: true, permissions: ['workspace.read', 'workspace.write', 'network'], dependencies: [] }, 1);
    const resumed = finish(run.id); service.resume(run.id, 'default', 'admin'); await resumed;
    assert.deepEqual(snapshot!.authorization!.pluginDevelopment?.permissions, ['workspace.read']);
    assert.throws(() => service.get(run.id, 'other'), /不存在/);
  } finally { await service.shutdown(); store.close(); }
});

test('only user admin can edit plugin grants, with approved dependencies and audit records', async () => {
  const store = new Store(':memory:');
  const service = new RunService({ store, workspace: () => 'workspace', provider: () => undefined, prepare: () => { throw new Error('unused'); }, runner: () => undefined });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { apiRole: req.get('x-test-role') ?? 'admin' }); next(); });
  registerRunRoutes(app, { store, kernel: { rootDir: process.cwd(), config: { get: () => ['approved-package'] } } } as unknown as RouteDeps, service);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const put = (role: string, body: unknown) => fetch(base + '/api/v2/workspace/plugin-development', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
  const grant = { enabled: true, revision: 0, permissions: ['workspace.read'], dependencies: [] };
  try {
    assert.equal((await put('member', grant)).status, 403);
    assert.equal((await put('admin', { ...grant, permissions: ['admin'] })).status, 400);
    assert.equal((await put('admin', { ...grant, dependencies: ['unapproved'] })).status, 400);
    assert.equal((await put('admin', { ...grant, dependencies: ['approved-package'] })).status, 200);
    assert.equal((await put('admin', grant)).status, 409);
    assert.equal((await fetch(base + '/api/v2/workspace/permissions')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); store.close(); }
});

test('task plugin APIs isolate tenants and roles and forward async failures', async () => {
  const store = new Store(':memory:');
  const service = new RunService({ store, workspace: () => 'workspace', provider: () => ({ id: 'mock', model: 'mock' }), prepare: () => { throw new Error('unused'); }, runner: () => undefined });
  const session = store.createSession('mock', 'mock');
  const run = service.create(session, { message: 'panel' });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { apiRole: req.get('x-test-role') ?? 'admin', tenantId: req.get('x-test-tenant') ?? 'default' }); next(); });
  registerRunRoutes(app, { store, kernel: { rootDir: process.cwd(), plugins: { resolveService: () => ({ routes: () => [{ pluginId: 'sample', mount: 'panel', router: async () => { throw new Error('panel failure'); } }] }) } } } as unknown as RouteDeps, service);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const path = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2/runs/${run.id}/plugins/sample/api/panel`;
  try {
    assert.equal((await fetch(path, { headers: { 'x-test-role': 'member' } })).status, 403);
    assert.equal((await fetch(path, { headers: { 'x-test-tenant': 'other' } })).status, 404);
    const failed = await fetch(path); assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { error: 'panel failure' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.shutdown(); store.close(); }
});
