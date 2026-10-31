import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync, ConcurrentWriteError, fileRevisionSync } from '../atomic-file';

const root = mkdtempSync(join(tmpdir(), 'maharness-atomic-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('atomicWriteFileSync', () => {
  test('pre-commit failure preserves the previous complete file and cleans its temp file', () => {
    const target = join(root, 'config.json');
    const original = '{"agent":{"maxTurns":12}}\n';
    writeFileSync(target, original, 'utf8');

    assert.throws(() => atomicWriteFileSync(target, '{"agent":{"maxTurns":20}}\n', {
      beforeRename: () => { throw new Error('injected pre-commit failure'); },
    }), /injected pre-commit failure/);

    assert.equal(readFileSync(target, 'utf8'), original);
    assert.deepEqual(readdirSync(root), ['config.json']);
  });

  test('successful replacement writes complete contents and removes the temporary file', () => {
    const target = join(root, 'rules.json');
    atomicWriteFileSync(target, '{"rules":[]}\n');
    assert.equal(readFileSync(target, 'utf8'), '{"rules":[]}\n');
    assert.deepEqual(readdirSync(root).sort(), ['config.json', 'rules.json']);
  });

  test('optimistic revision rejects an external change and preserves the newer file', () => {
    const target = join(root, 'concurrent.json');
    writeFileSync(target, 'v1', 'utf8');
    const expected = fileRevisionSync(target);
    assert.throws(() => atomicWriteFileSync(target, 'local-v2', {
      expectedRevision: expected,
      beforeRename: () => writeFileSync(target, 'external-v2', 'utf8'),
    }), (error: unknown) => error instanceof ConcurrentWriteError && error.code === 'concurrent_write');
    assert.equal(readFileSync(target, 'utf8'), 'external-v2');
    assert.ok(!readdirSync(root).some((name) => name.includes('concurrent.json.') && name.endsWith('.tmp')));
  });
});
