import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRipgrep } from './index';

const hasRipgrep = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;

test('ripgrep 取消后等待子进程退出并传播取消错误', { skip: !hasRipgrep }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'maharness-rg-cancel-'));
  try {
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024, 0x61));
    const controller = new AbortController();
    const pending = runRipgrep(root, { pattern: 'needle-not-present', limit: 10 }, controller.signal);
    controller.abort(new Error('搜索已取消'));
    await assert.rejects(pending, /搜索已取消/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
