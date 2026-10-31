import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '../../kernel';
import { EventBus } from '../../kernel/bus';
import { Config } from '../../kernel/config';
import { registerConfigRoutes } from '../routes/config';

function setup() {
  const values = new Map<string, unknown>();
  const writes: [string, unknown][] = [];
  let retentionMs = 30 * 24 * 60 * 60 * 1000;
  const kernel = {
    paths: { dbFile: 'db', traces: 'traces', configFile: 'config' },
    rootDir: 'root',
    config: {
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
      setPersistent: (key: string, value: unknown) => { values.set(key, value); writes.push([key, value]); },
    },
    setCheckpointRetentionMs: (value: number) => { retentionMs = value; },
    plugins: { resolveService: () => undefined },
  } as unknown as Kernel;
  let getHandler: ((req: unknown, res: unknown) => void) | undefined;
  let patchHandler: ((req: unknown, res: unknown) => void) | undefined;
  const app = {
    get: (path: string, handler: typeof getHandler) => { if (path === '/api/config') getHandler = handler; return app; },
    patch: (_path: string, handler: typeof patchHandler) => { patchHandler = handler; return app; },
    post: () => app,
  };
  registerConfigRoutes(app as never, { kernel, store: { setCheckpointRetentionMs: (value: number) => { retentionMs = value; } } } as never);
  return { values, writes, get: getHandler!, patch: patchHandler!, retention: () => retentionMs };
}

function invoke(handler: (req: unknown, res: unknown) => void, body?: unknown) {
  let status = 200;
  let result: unknown;
  const res = {
    status: (code: number) => { status = code; return res; },
    json: (value: unknown) => { result = value; return res; },
  };
  handler({ body }, res);
  return { status, result };
}

describe('provider circuit breaker config', () => {
  test('GET returns defaults and PATCH persists bounded integer settings', () => {
    const routes = setup();
    const response = invoke(routes.get);
    assert.equal(response.status, 200);
    assert.deepEqual((response.result as { provider: unknown }).provider, {
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
    });
    assert.deepEqual(invoke(routes.patch, { provider: { circuitBreakerThreshold: 0, circuitBreakerResetMs: 4_000_000 } }), {
      status: 200, result: { ok: true, revision: 'unversioned' },
    });
    assert.deepEqual(routes.writes, [
      ['provider.circuitBreakerThreshold', 1],
      ['provider.circuitBreakerResetMs', 3_600_000],
    ]);
  });

  test('rejects non-finite and fractional values without persisting provider settings', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'invalid', 1.5]) {
      const routes = setup();
      const response = invoke(routes.patch, { provider: { circuitBreakerThreshold: value } });
      assert.equal(response.status, 400);
      assert.deepEqual(routes.writes, []);
    }
    const routes = setup();
    const response = invoke(routes.patch, { provider: { circuitBreakerResetMs: 'Infinity' } });
    assert.equal(response.status, 400);
    assert.deepEqual(routes.writes, []);
  });

  test('checkpoint retention is bounded, persisted, and applied at runtime', () => {
    const routes = setup();
    assert.deepEqual(invoke(routes.patch, { checkpoint: { retentionDays: 90 } }), { status: 200, result: { ok: true, revision: 'unversioned' } });
    assert.equal(routes.values.get('checkpoint.retentionDays'), 90);
    assert.equal(routes.retention(), 90 * 24 * 60 * 60 * 1000);
    const invalid = invoke(routes.patch, { checkpoint: { retentionDays: 0.5 } });
    assert.equal(invalid.status, 400);
  });

  test('真实 Config 提交失败时 API 不发布部分配置且保留原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maharness-config-route-'));
    try {
      const path = join(dir, 'config.json');
      const original = '{invalid config';
      writeFileSync(path, original, 'utf8');
      const config = new Config(new EventBus(), { provider: { circuitBreakerThreshold: 3 } }, path);
      let patchHandler: ((req: unknown, res: unknown) => void) | undefined;
      const app = {
        get: () => app,
        patch: (_path: string, handler: typeof patchHandler) => { patchHandler = handler; return app; },
        post: () => app,
      };
      const kernel = {
        paths: { dbFile: 'db', traces: 'traces', configFile: path },
        rootDir: dir,
        config,
        plugins: { resolveService: () => undefined },
      } as unknown as Kernel;
      registerConfigRoutes(app as never, { kernel, store: { setCheckpointRetentionMs: () => undefined } } as never);
      const response = invoke(patchHandler!, {
        revision: config.getPersistedRevision(),
        provider: { circuitBreakerThreshold: 12 }, agent: { reasoningBudget: 1200 },
      });
      assert.equal(response.status, 503);
      assert.equal(config.get('provider.circuitBreakerThreshold'), 3);
      assert.equal(config.get('agent.reasoningBudget'), undefined);
      assert.equal(readFileSync(path, 'utf8'), original);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
