import assert from 'node:assert/strict';
import express from 'express';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { Kernel } from '../kernel';
import type { Store } from '../server/db';
import type { RunService } from '../server/run-service';
import { registerRunRoutes } from '../server/routes/runs';
import { registerMaterialRoutes } from '../server/routes/materials';

/** Isolated live acceptance host: production Run/material routes and built UI, no mocked model/task/file responses. */
export async function checkLiveRecoveryBrowser(input: {
  root: string;
  reportDir: string;
  kernel: Kernel;
  store: Store;
  service: RunService;
  providerId: string;
  model: string;
  runId: string;
}) {
  const { kernel, store, service } = input;
  const app = express();
  app.use(express.json());
  app.get('/api/sessions', (_req, res) => res.json(store.listSessions()));
  app.get('/api/sessions/:id/messages', (req, res) => res.json(store.listMessages(String(req.params.id))));
  app.get('/api/models', (_req, res) =>
    res.json([{ id: `${input.providerId}@${input.model}`, provider: input.providerId, model: input.model, label: input.model }]),
  );
  app.get('/api/providers', (_req, res) => res.json([{ id: input.providerId, model: input.model, enabled: true, hasKey: true }]));
  app.get('/api/plugins', (_req, res) => res.json([]));
  app.get('/api/plugins/diagnostics', (_req, res) => res.json([]));
  app.get('/api/nav', (_req, res) => res.json({ items: [] }));
  app.get('/api/commands', (_req, res) => res.json([]));
  app.get('/api/plugins/goal-plan/plan', (_req, res) => res.json({ plan: null }));
  app.get('/api/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected' + String.fromCharCode(10, 10));
  });
  registerRunRoutes(app, { kernel, store }, service);
  registerMaterialRoutes(app, { kernel, store });
  app.use(express.static(join(input.root, 'ui/dist')));
  app.get('/', (_req, res) => res.sendFile(join(input.root, 'ui/dist/index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const checks: string[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const draft = page.getByTestId('run-file').filter({ hasText: '草稿' }).last();
    await draft.waitFor();
    checks.push('persisted live draft visible');
    await draft.getByRole('button', { name: '预览 / 继续处理', exact: true }).click();
    await page.getByTestId('material-viewer').waitFor();
    checks.push('live draft content preview');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载文件', exact: true }).click();
    await (await downloaded).saveAs(join(input.reportDir, 'browser-draft.md'));
    checks.push('live draft downloaded');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '继续任务', exact: true }).waitFor();
    checks.push('refresh preserved resumable state');
    await page.screenshot({ path: join(input.reportDir, 'browser-interrupted.png'), fullPage: true });
    const resumed = page.waitForResponse((response) => response.url().endsWith('/resume') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '继续任务', exact: true }).click();
    assert.equal((await resumed).status(), 202);
    checks.push('resume through production HTTP route');
    for (let i = 0; i < 900; i++) {
      const status = service.get(input.runId, 'default').status;
      if (!['queued', 'running', 'waiting_approval', 'stopping'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(service.get(input.runId, 'default').status, 'completed');
    checks.push('real model completed after browser resume');
    await page.reload();
    const final = page.getByTestId('run-file').filter({ hasText: '最终文件' }).last();
    await final.waitFor();
    await final.getByRole('button', { name: '预览 / 继续处理', exact: true }).click();
    await page.getByTestId('material-viewer').waitFor();
    checks.push('final version persisted and previewed');
    await page.screenshot({ path: join(input.reportDir, 'browser-final.png'), fullPage: true });
    writeFileSync(
      join(input.reportDir, 'browser-validation.json'),
      JSON.stringify(
        {
          kind: 'live-model-browser',
          passed: true,
          checks,
          authenticationTesting: 'separate deterministic tests',
          host: 'isolated loopback acceptance host with production Run/material routes and built UI',
          humanReview: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    writeFileSync(
      join(input.reportDir, 'browser-validation.json'),
      JSON.stringify({ kind: 'live-model-browser', passed: false, checks, error: String(error), humanReview: false }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
