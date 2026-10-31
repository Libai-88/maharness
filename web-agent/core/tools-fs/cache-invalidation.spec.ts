import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../../kernel/cache';
import type { ToolContext, ToolDef } from '../../kernel/types';
import toolsFs from './index';

const root = mkdtempSync(join(tmpdir(), 'maharness-fs-cache-'));
mkdirSync(join(root, 'src'), { recursive: true });
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
const ctx = { sandboxRoot: root, sessionId: 'cache-test', traceId: 'cache-test', turn: 1, cache, trace } as ToolContext;

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  return await tool.handler(args, ctx) as unknown as Record<string, unknown>;
}

after(() => rmSync(root, { recursive: true, force: true }));

describe('文件工具缓存对工作区外部变化失效', () => {
  it('list_dir 与 glob 发现工具写入之外新增的文件', async () => {
    const firstList = await call('list_dir', { path: 'src' });
    const firstGlob = await call('glob', { path: 'src', pattern: '*.txt' });
    assert.deepEqual((firstList.data as { entries: unknown[] }).entries, []);
    assert.deepEqual((firstGlob.data as { matches: unknown[] }).matches, []);

    writeFileSync(join(root, 'src', 'external.txt'), 'created outside the tool');
    const nextList = await call('list_dir', { path: 'src' });
    const nextGlob = await call('glob', { path: 'src', pattern: '*.txt' });
    assert.equal((nextList.data as { entries: { name: string }[] }).entries[0]?.name, 'external.txt');
    assert.equal((nextGlob.data as { matches: { path: string }[] }).matches[0]?.path, 'external.txt');
  });

  it('read_file 与 grep 发现同尺寸原位内容修改', async () => {
    const file = join(root, 'src', 'mutable.txt');
    writeFileSync(file, 'needle');
    const firstRead = await call('read_file', { path: 'src/mutable.txt' });
    const firstGrep = await call('grep', { path: 'src', pattern: 'needle', literal: true });
    assert.equal((firstRead.data as { text: string }).text, 'needle');
    assert.equal((firstGrep.data as { matches: unknown[] }).matches.length, 1);

    writeFileSync(file, 'hidden');
    const nextRead = await call('read_file', { path: 'src/mutable.txt' });
    const nextGrep = await call('grep', { path: 'src', pattern: 'needle', literal: true });
    assert.equal((nextRead.data as { text: string }).text, 'hidden');
    assert.equal((nextGrep.data as { matches: unknown[] }).matches.length, 0);
  });
});
