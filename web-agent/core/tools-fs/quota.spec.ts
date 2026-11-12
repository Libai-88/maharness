import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../../kernel/cache';
import type { ToolContext, ToolDef } from '../../kernel/types';
import toolsFs from './index';

const root = mkdtempSync(join(tmpdir(), 'maharness-fs-quota-'));
const tools = new Map<string, ToolDef>();
const pluginContext = {
  paths: { root },
  config: { get: (_key: string, fallback: unknown) => fallback },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  register: (capability: { kind: string; tool?: ToolDef }) => {
    if (capability.kind === 'tool' && capability.tool) tools.set(capability.tool.name, capability.tool);
  },
};
(toolsFs as unknown as { onLoad(ctx: unknown): void }).onLoad(pluginContext);

const cache = new Cache();
const trace = { startStep: () => ({ finish: () => {} }) } as unknown as ToolContext['trace'];
const ctx = {
  sandboxRoot: root, sessionId: 'quota-test', traceId: 'quota-test', turn: 1, cache, trace,
  quota: {
    assertWritable(bytes: number) { if (bytes > 10) throw new Error(`quota exceeded: ${bytes}`); },
    invalidate() {},
  },
} as ToolContext;

after(() => rmSync(root, { recursive: true, force: true }));

describe('文件工具租户存储配额', () => {
  it('超限写入不落盘，额度内写入成功', async () => {
    const tool = tools.get('write_file');
    assert.ok(tool);
    const blocked = await tool.handler({ path: 'blocked.txt', content: 'x'.repeat(20) }, ctx);
    assert.equal(blocked.ok, false);
    assert.match(String(blocked.error), /quota exceeded/);
    assert.equal(existsSync(join(root, 'blocked.txt')), false);
    const allowed = await tool.handler({ path: 'allowed.txt', content: '12345' }, ctx);
    assert.equal(allowed.ok, true);
    assert.equal(existsSync(join(root, 'allowed.txt')), true);
  });
});
