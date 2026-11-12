import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import visionPlugin from '../index';
import type { ToolContext, ToolDef } from '../../../kernel/types';

const root = mkdtempSync(join(tmpdir(), 'mh-vision-'));
const tools = new Map<string, ToolDef>();
const ctx = {
  paths: { data: join(root, 'data'), root },
  config: { get: (_key: string, fallback: unknown) => fallback },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  inject: (_key: string, _cb: unknown) => () => undefined,
  trace: { startStep: () => ({ finish: () => {}, fail: () => {} }) },
  register(cap: { kind: string; tool?: ToolDef }) { if (cap.kind === 'tool' && cap.tool) tools.set(cap.tool.name, cap.tool); },
};
(visionPlugin as unknown as { onLoad(ctx: unknown): void }).onLoad(ctx);
after(() => rmSync(root, { recursive: true, force: true }));

const tctx = (tenantId: string, sessionId: string): ToolContext => ({
  turn: 0, tenantId, sessionId, sandboxRoot: root,
} as ToolContext);

describe('vision tenant and path boundaries', () => {
  it('imageId 只能被登记它的租户/会话使用', async () => {
    writeFileSync(join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const read = await tools.get('read_image')!.handler({ path: 'a.png' }, tctx('tenant-a', 's-a'));
    assert.equal(read.ok, true);
    const imageId = (read.data as { imageId: string }).imageId;
    const foreign = await tools.get('analyze_image')!.handler({ imageId, question: 'describe' }, tctx('tenant-b', 's-b'));
    assert.equal(foreign.ok, false);
    assert.match(String(foreign.error), /找不到图片/);
  });

  it('直接路径分析复用敏感读拦截', async () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await tools.get('analyze_image')!.handler({ path: 'data/secret.png', question: 'x' }, tctx('default', 's'));
    assert.equal(result.ok, false);
    assert.match(String(result.error), /拒绝读取/);
  });
});
