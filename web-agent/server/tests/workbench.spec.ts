import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalItems } from '../../core/todo/items';
import { dateInTimeZone, registerWorkbenchRoutes } from '../routes/workbench';
import type { RouteDeps } from '../routes/shared';
import { Store } from '../db';
import type { RunRecord } from '../../kernel/run';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 可能延迟释放 */ }
  }
});

async function withServer(tenantId: string, inspect: (summary: Record<string, any>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'mh-workbench-summary-'));
  roots.push(root);
  const store = new Store(':memory:');
  const items = new PersonalItems(root);
  const session = store.createSession('fixture-model', 'fixture', tenantId);
  const run: RunRecord = {
    id: 'completed-run', sessionId: session.id, tenantId, rootId: 'completed-run', depth: 0,
    objective: '整理周报', providerId: 'fixture', model: 'fixture-model', status: 'running',
    createdAt: 1_000, updatedAt: 2_000, cost: 0.02, tokensIn: 10, tokensOut: 5,
    authorization: { workspace: root, profile: 'standard', readOnly: false, revision: 0 },
  };
  store.runs.create(run);
  store.runs.update(run, { status: 'completed' });
  store.runs.startTool(run.id, 'call-1', 'read_file', '{"path":"README.md"}');
  store.runs.finishTool(run.id, 'call-1', { ok: false, error: 'bad path', failure: { code: 'INVALID_PATH', retryable: false, outcome: 'not_started' } });
  items.create(tenantId, { title: '核对周报', due: dateInTimeZone(Date.now(), 'Asia/Shanghai'), timeZone: 'Asia/Shanghai' });
  const app = express();
  app.use((req, _res, next) => { (req as typeof req & { tenantId?: string }).tenantId = tenantId; next(); });
  registerWorkbenchRoutes(app, {
    store,
    kernel: { plugins: { resolveService: () => items } },
    automations: { list: () => [{ id: 'auto-1', approval: 'pending' }] },
  } as unknown as RouteDeps);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workbench/summary?timeZone=Asia%2FShanghai`);
    assert.equal(response.status, 200);
    inspect(await response.json() as Record<string, any>);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
}

async function statusFor(path: string): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'mh-workbench-timezone-'));
  roots.push(root);
  const store = new Store(':memory:');
  const app = express();
  registerWorkbenchRoutes(app, {
    store,
    kernel: { plugins: { resolveService: () => new PersonalItems(root) } },
    automations: { list: () => [] },
  } as unknown as RouteDeps);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    const address = server.address() as { port: number };
    return (await fetch(`http://127.0.0.1:${address.port}${path}`)).status;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
}

describe('工作台聚合与本地体验指标', () => {
  test('今日日期按请求时区计算，避免 UTC 日期边界分错栏', () => {
    const instant = Date.UTC(2026, 10, 16, 18, 30);
    assert.equal(dateInTimeZone(instant, 'UTC'), '2026-11-16');
    assert.equal(dateInTimeZone(instant, 'Asia/Shanghai'), '2026-11-17');
  });

  test('无效时区返回明确错误', async () => {
    assert.equal(await statusFor('/api/workbench/summary?timeZone=Mars%2FOlympus'), 400);
  });

  test('普通租户同样返回个人事项、项目与运行指标', async () => {
    await withServer('tenant-a', summary => {
      assert.equal(summary.todayItems[0]?.title, '核对周报');
      assert.equal(summary.pendingAutomations.length, 1);
      assert.equal(summary.recentRuns[0]?.id, 'completed-run');
      assert.equal(summary.metrics.firstTaskSuccessRate, 100);
      assert.equal(summary.metrics.invalidToolCalls, 1);
      assert.equal(summary.metrics.duplicateToolCalls, 0);
      assert.equal(summary.metrics.costUsd, 0.02);
    });
  });
});
