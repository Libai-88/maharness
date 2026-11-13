import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../index';
import type { Capability, PluginContext, ToolContext, ToolDef } from '../../../kernel/types';

test('file writes and edits reject stale versions and preserve concurrent content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-file-version-'));
  const tools = new Map<string, ToolDef>();
  const cache = { makeKey: () => '', l2Get: () => ({ hit: false }), l2Set: () => {}, l2DeleteNamespace: () => {} };
  const context = { sandboxRoot: root, turn: 0, cache, approved: true } as unknown as ToolContext;
  const ctx = { paths: { root }, config: { get: (_key: string, fallback: unknown) => fallback }, register: (cap: Capability) => { if (cap.kind === 'tool') tools.set(cap.tool.name, cap.tool); }, logger: { info: () => {} } } as unknown as PluginContext;
  try {
    await plugin.onLoad(ctx);
    writeFileSync(join(root, 'file.txt'), 'original');
    const read = await tools.get('read_file')!.handler({ path: 'file.txt' }, context);
    const version = (read.data as { version: string }).version; assert.match(version, /^[0-9a-f]{64}$/);
    writeFileSync(join(root, 'file.txt'), 'concurrent');
    for (const [tool, args] of [['write_file', { content: 'overwrite' }], ['edit_file', { edits: [{ oldText: 'concurrent', newText: 'overwrite' }] }]] as const) {
      const result = await tools.get(tool)!.handler({ path: 'file.txt', expectedVersion: version, ...args }, context);
      assert.equal(result.failure?.code, 'FILE_VERSION_CONFLICT');
      assert.equal(result.failure?.outcome, 'not_started');
      assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'concurrent');
    }
    const existing = await tools.get('write_file')!.handler({ path: 'file.txt', expectedVersion: null, content: 'overwrite' }, context);
    assert.equal(existing.ok, false);
    const created = await tools.get('write_file')!.handler({ path: 'new.txt', expectedVersion: null, content: 'created' }, context);
    assert.equal(created.ok, true);
    assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'created');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
