import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/process-recovery-child.ts', import.meta.url));

function waitForLine(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try { resolve(JSON.parse(line) as Record<string, unknown>); return; } catch { /* 等待完整 JSON */ }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`fixture exited before ready: code=${code} signal=${signal}\n${output}`)));
  });
}

function runFixture(mode: 'seed' | 'verify', env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', fixture, mode], {
    cwd: join(fileURLToPath(new URL('../..', import.meta.url))),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function stopHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('真实服务进程强杀恢复', () => {
  test('同一数据目录重启后恢复 checkpoint 并保留已完成副作用账本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-process-recovery-'));
    const port = 38000 + Math.floor(Math.random() * 1000);
    let providerServer: Server | undefined;
    providerServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache' });
      res.write('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => providerServer!.listen(0, '127.0.0.1', resolve));
    const providerPort = (providerServer.address() as { port: number }).port;
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_DATA_DIR: join(root, 'data'),
      AGENT_ROOT: join(fileURLToPath(new URL('../..', import.meta.url))),
      SANDBOX_ROOT: root,
      PORT: String(port),
      AUTO_STOP_IDLE_MS: '0',
      AGENT_USER_PLUGINS_DIR: join(root, 'plugins'),
      MOCK_URL: `http://127.0.0.1:${providerPort}`,
      RECOVERY_PROVIDER_BASE_URL: `http://127.0.0.1:${providerPort}`,
      RECOVERY_PROVIDER_API_KEY: 'recovery-key',
      RECOVERY_PROVIDER_MODEL: 'recovery-model',
    };
    let seed: ChildProcess | undefined;
    let verify: ChildProcess | undefined;
    try {
      seed = runFixture('seed', baseEnv);
      const seeded = await waitForLine(seed);
      const sessionId = String(seeded.sessionId ?? '');
      assert.match(sessionId, /^[0-9a-f-]{36}$/);
      await stopHard(seed);
      seed = undefined;

      verify = runFixture('verify', { ...baseEnv, RECOVERY_SESSION_ID: sessionId });
      const result = await waitForLine(verify);
      assert.equal(result.status, 200);
      assert.equal(result.completed, true);
      assert.equal(result.checkpointCleared, true);
      assert.deepEqual(result.effectBefore, { state: 'done', result: { ok: true, data: { written: true } } });
      await new Promise<void>((resolve, reject) => verify?.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`verify exited ${code}`))));
      verify = undefined;
    } finally {
      if (seed) await stopHard(seed);
      if (verify) await stopHard(verify);
      await new Promise<void>((resolve) => providerServer?.close(() => resolve()) ?? resolve());
      rmSync(root, { recursive: true, force: true });
    }
  });
});
