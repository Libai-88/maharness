import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../db';

const fixture = fileURLToPath(new URL('./fixtures/sqlite-crash-child.ts', import.meta.url));

describe('SQLite 事务崩溃恢复', () => {
  test('进程在事务提交前终止，重开数据库后不留下半事务行', () => {
    const root = mkdtempSync(join(tmpdir(), 'maharness-sqlite-crash-'));
    const dbPath = join(root, 'agent.db');
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, dbPath], {
        cwd: join(fileURLToPath(new URL('../..', import.meta.url))),
        encoding: 'utf8', windowsHide: true,
      });
      assert.notEqual(child.status, 0, `fixture should terminate inside transaction\n${child.stdout}\n${child.stderr}`);
      const reopened = new Store(dbPath);
      try { assert.equal(reopened.getSession('crash-only-session'), undefined); }
      finally { reopened.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
