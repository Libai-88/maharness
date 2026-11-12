import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import blackboard from '../index';

type Tool = { name: string; handler: (args: Record<string, unknown>, ctx: { sessionId?: string; tenantId?: string }) => Promise<{ ok: boolean; data?: any; error?: string }> };

function loadTools(root: string): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const ctx = {
    paths: { data: root },
    register(entry: any) { if (entry.kind === 'tool') tools.set(entry.tool.name, entry.tool); },
    logger: { info() {}, warn() {}, error() {} },
  };
  (blackboard as any).onLoad(ctx);
  return tools;
}

describe('共享黑板', () => {
  it('按会话隔离写入、读取、列出和删除', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-blackboard-'));
    try {
      const tools = loadTools(root);
      const put = tools.get('blackboard_put')!;
      const get = tools.get('blackboard_get')!;
      const list = tools.get('blackboard_list')!;
      const del = tools.get('blackboard_delete')!;
      const a = { sessionId: 'session-a' };
      const b = { sessionId: 'session-b' };
      assert.equal((await put.handler({ key: 'plan', value: { steps: 3 } }, a)).ok, true);
      assert.equal((await put.handler({ key: 'plan', value: 'other' }, b)).ok, true);
      assert.deepEqual((await get.handler({ key: 'plan' }, a)).data.value, { steps: 3 });
      assert.equal((await get.handler({ key: 'plan' }, b)).data.value, 'other');
      assert.equal((await list.handler({}, a)).data.entries.length, 1);
      assert.equal((await del.handler({ key: 'plan' }, a)).ok, true);
      assert.equal((await get.handler({ key: 'plan' }, a)).ok, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('重启后从磁盘恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-blackboard-'));
    try {
      const tools = loadTools(root);
      await tools.get('blackboard_put')!.handler({ key: 'result', value: 'ready' }, { sessionId: 's' });
      const reloaded = loadTools(root);
      assert.equal((await reloaded.get('blackboard_get')!.handler({ key: 'result' }, { sessionId: 's' })).data.value, 'ready');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('拒绝超大值', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-blackboard-'));
    try {
      const tools = loadTools(root);
      const result = await tools.get('blackboard_put')!.handler({ key: 'big', value: 'x'.repeat(20_001) }, { sessionId: 's' });
      assert.equal(result.ok, false);
      assert.match(String(result.error), /过长/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('同会话名的不同租户互不可见', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-blackboard-'));
    try {
      const tools = loadTools(root);
      const put = tools.get('blackboard_put')!;
      const get = tools.get('blackboard_get')!;
      const a = { sessionId: 'shared-session', tenantId: 'tenant-a' };
      const b = { sessionId: 'shared-session', tenantId: 'tenant-b' };
      assert.equal((await put.handler({ key: 'result', value: 'A' }, a)).ok, true);
      assert.equal((await put.handler({ key: 'result', value: 'B' }, b)).ok, true);
      assert.equal((await get.handler({ key: 'result' }, a)).data.value, 'A');
      assert.equal((await get.handler({ key: 'result' }, b)).data.value, 'B');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
