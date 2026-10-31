import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPowershell } from '../index';

const tempDirs: string[] = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function processExists(pid: number): boolean {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.includes(String(pid));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function readPidWhenReady(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* PowerShell may still hold the file during the first read. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('child PID file did not become readable');
}

describe('PowerShell process cancellation', () => {
  it('aborts the command and reaps its descendant process within five seconds', { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maharness-ps-cancel-'));
    tempDirs.push(dir);
    const pidFile = join(dir, 'child.pid');
    const quotedPath = pidFile.replace(/'/g, "''");
    const command = `$p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 60') -PassThru; Set-Content -LiteralPath '${quotedPath}' -Value $p.Id; Start-Sleep -Seconds 60`;
    const controller = new AbortController();
    const running = runPowershell(command, 60_000, dir, controller.signal);
    try {
      const childPid = await readPidWhenReady(pidFile, 5_000);
      controller.abort(new Error('test cancellation'));
      await assert.rejects(running, /test cancellation/);
      assert.equal(await waitFor(() => !processExists(childPid), 5_000), true, `child process ${childPid} remained alive`);
    } finally {
      controller.abort();
      await running.catch(() => undefined);
    }
  });
});
