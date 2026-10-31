import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import memory from '../index';

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }> };

function loadTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const ctx = {
    paths: { data: root },
    register(entry: any) { if (entry.kind === 'tool') tools.set(entry.tool.name, entry.tool); },
    on() { return () => undefined; },
    logger: { info() {}, warn() {}, error() {} },
  };
  (memory as any).onLoad(ctx);
  return tools;
}

describe('长期记忆插件运行时契约', () => {
  it('写入元数据、过滤过期、保留冲突关系并支持撤回与删除', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-memory-'));
    try {
      const tools = loadTools(root);
      const remember = tools.get('remember_fact')!;
      const recall = tools.get('recall_facts')!;
      const revoke = tools.get('revoke_fact')!;
      const forget = tools.get('forget_fact')!;
      const old = await remember.handler({ text: '旧项目结论', source: 'user', confidence: 0.9 });
      const fresh = await remember.handler({ text: '新项目结论', source: 'tool', confidence: 0.4, conflictsWith: [old.data.id] });
      const expiring = await remember.handler({ text: '过期结论', expiresAt: Date.now() - 1 });
      const recalled = await recall.handler({});
      assert.equal(recalled.data.facts.some((fact: any) => fact.id === expiring.data.id), false);
      const current = recalled.data.facts.find((fact: any) => fact.id === fresh.data.id);
      assert.equal(current.source, 'tool');
      assert.equal(current.confidence, 0.4);
      assert.deepEqual(current.conflictsWith, [old.data.id]);
      const revoked = await revoke.handler({ id: old.data.id });
      assert.equal(revoked.ok, true);
      assert.equal((await recall.handler({})).data.facts.some((fact: any) => fact.id === old.data.id), false);
      assert.equal((await forget.handler({ id: fresh.data.id })).ok, true);
      assert.equal((await recall.handler({})).data.facts.some((fact: any) => fact.id === fresh.data.id), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('拒绝凭据、私钥和敏感凭据路径，不写入长期记忆', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-memory-'));
    try {
      const tools = loadTools(root);
      const remember = tools.get('remember_fact')!;
      const recall = tools.get('recall_facts')!;
      for (const text of ['api_key=sk-live-secret', '-----BEGIN PRIVATE KEY-----', '读取 .env.production', '使用 .ssh/id_rsa']) {
        const result = await remember.handler({ text });
        assert.equal(result.ok, false);
      }
      assert.equal((await recall.handler({})).data.facts.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
