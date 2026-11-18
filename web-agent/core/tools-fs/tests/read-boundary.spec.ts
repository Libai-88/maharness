import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../index';
import type { Capability, PluginContext, ToolContext, ToolDef } from '../../../kernel/types';

test('search engines and directory tools enforce the same private-data boundary as read_file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-search-boundary-'));
  const tools = new Map<string, ToolDef>();
  const trace = { startStep: () => ({ finish() {} }) };
  const cache = { makeKey: () => '', l2Get: () => ({ hit: false }), l2Set() {} };
  const context = { sandboxRoot: root, turn: 0, cache, trace } as unknown as ToolContext;
  const ctx = { paths: { root }, config: { get: (_key: string, fallback: unknown) => fallback }, register: (cap: Capability) => { if (cap.kind === 'tool') tools.set(cap.tool.name, cap.tool); }, logger: { info() {} } } as unknown as PluginContext;
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'data', 'private.txt'), 'boundary-marker PRIVATE');
    writeFileSync(join(root, 'nested', '.env'), 'boundary-marker PRIVATE');
    writeFileSync(join(root, 'public.txt'), 'boundary-marker PUBLIC');
    await plugin.onLoad(ctx);
    for (const contextLines of [0, 1]) {
      const result = await tools.get('grep')!.handler({ pattern: 'boundary-marker', contextLines }, context);
      assert.equal(result.ok, true);
      assert.match(JSON.stringify(result.data), /PUBLIC/);
      assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE/);
      assert.equal((await tools.get('grep')!.handler({ pattern: '.', path: 'data', contextLines }, context)).ok, false);
    }
    const glob = await tools.get('glob')!.handler({ pattern: '**/*' }, context);
    assert.doesNotMatch(JSON.stringify(glob.data), /private\.txt|\.env/);
    for (const name of ['list_dir', 'glob']) {
      assert.equal((await tools.get(name)!.handler({ path: 'data', pattern: '**/*' }, context)).ok, false);
    }
    const listing = await tools.get('list_dir')!.handler({ path: 'nested' }, context);
    assert.doesNotMatch(JSON.stringify(listing.data), /\.env/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contract writes stay on the named file and recheck junctions at execution time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-contract-boundary-'));
  const tools = new Map<string, ToolDef>();
  const context = {
    sandboxRoot: root, turn: 0, runId: 'child', tenantId: 'tenant-a',
    cache: { l2DeleteNamespace() {} },
    authorization: { workspace: root, profile: 'standard', revision: 0, readOnly: false, artifactWritePaths: ['delivery/result.md'] },
  } as unknown as ToolContext;
  const ctx = { paths: { root }, config: { get: (_key: string, fallback: unknown) => fallback }, register: (cap: Capability) => { if (cap.kind === 'tool') tools.set(cap.tool.name, cap.tool); }, logger: { info() {} } } as unknown as PluginContext;
  try {
    await plugin.onLoad(ctx);
    const write = (path: string) => tools.get('write_file')!.handler({ path, content: 'approved result', expectedVersion: null }, context);
    for (const path of ['other.md', '../escape.md', 'delivery/../other.md', 'delivery/result.md:stream', 'delivery/result.md.']) {
      assert.equal((await write(path)).ok, false, path);
    }
    assert.equal(existsSync(join(root, 'other.md')), false);
    const written = await write('delivery/result.md');
    assert.equal(written.ok, true);
    const expectedVersion = (written.data as { version: string }).version;
    const edited = await tools.get('edit_file')!.handler({ path: 'delivery/result.md', edits: [{ oldText: 'approved', newText: 'reviewed' }], expectedVersion }, context);
    assert.equal(edited.ok, true);
    assert.equal(readFileSync(join(root, 'delivery/result.md'), 'utf8'), 'reviewed result');
    context.authorization!.readOnly = true;
    assert.equal((await write('delivery/result.md')).ok, false);
    context.authorization!.readOnly = false;
    rmSync(join(root, 'delivery'), { recursive: true });
    mkdirSync(join(root, 'other-tenant'));
    symlinkSync(join(root, 'other-tenant'), join(root, 'delivery'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await write('delivery/result.md')).ok, false);
    assert.equal(existsSync(join(root, 'other-tenant/result.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
