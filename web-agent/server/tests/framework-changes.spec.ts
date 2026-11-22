import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameworkChanges } from '../framework-changes';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'maharness-change-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  writeFileSync(join(root, 'file.txt'), 'committed');
  writeFileSync(join(root, '.env'), 'test-only');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: Object.fromEntries(['typecheck', 'test', 'build'].map((name) => [name, 'node -e "process.exit(0)"'])) }),
  );
  git('add', '.');
  git('commit', '-m', 'fixture');
  return {
    root,
    changes: new FrameworkChanges(root),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

test('isolated changes preserve dirty baseline, omit credentials, validate and adopt reviewed snapshot', async () => {
  const { root, changes, cleanup } = setup();
  try {
    writeFileSync(join(root, 'file.txt'), 'existing user edit');
    const [change, list] = await Promise.all([changes.create('tenant'), changes.list('other')]);
    assert.deepEqual(list, []);
    assert.equal(readFileSync(join(change.workspace, 'file.txt'), 'utf8'), 'existing user edit');
    assert.equal(existsSync(join(change.workspace, '.env')), false);
    await assert.rejects(changes.get(change.id, 'other'), /不存在/);
    writeFileSync(join(change.workspace, 'file.txt'), 'reviewed edit');
    const reviewed = await changes.review(change.id, 'tenant');
    assert.match(reviewed.review!.diff, /existing user edit/);
    const validating = changes.validate(change.id, 'tenant');
    await assert.rejects(changes.review(change.id, 'tenant'), /正在检查/);
    const validated = await validating;
    assert.equal(validated.validation?.ok, true, JSON.stringify(validated.validation));
    // Adoption applies the exact reviewed snapshot even if the editable copy drifts.
    writeFileSync(join(change.workspace, 'file.txt'), 'later unreviewed edit');
    await changes.adopt(change.id, 'tenant', validated.review!.digest);
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'reviewed edit');
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'test-only');
  } finally {
    cleanup();
  }
});

test('adoption refuses source drift', async () => {
  const { root, changes, cleanup } = setup();
  try {
    const change = await changes.create('tenant');
    writeFileSync(join(change.workspace, 'file.txt'), 'new');
    const validated = await changes.validate(change.id, 'tenant');
    writeFileSync(join(root, 'file.txt'), 'concurrent user edit');
    await assert.rejects(changes.adopt(change.id, 'tenant', validated.review!.digest), /原工作区已变化/);
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'concurrent user edit');
  } finally {
    cleanup();
  }
});
