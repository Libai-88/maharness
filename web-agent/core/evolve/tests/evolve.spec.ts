import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import evolve from '../index';

function load(root: string): { tools: Map<string, any>; service: any } {
  const tools = new Map<string, any>();
  let service: any;
  const ctx = {
    paths: { data: root, root },
    config: { get: (_key: string, fallback: unknown) => fallback },
    register(value: any) {
      if (value.kind === 'tool') tools.set(value.tool.name, value.tool);
      if (value.kind === 'service') service = value.service.instance;
    },
    inject() {
      return { value: undefined };
    },
    on() {
      return () => undefined;
    },
    bus: { emit() {} },
    logger: { info() {}, warn() {} },
  };
  evolve.onLoad(ctx as never);
  return { tools, service };
}

describe('自进化提案', () => {
  it('生成提案并从服务采纳为技能', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-evolve-'));
    try {
      const { tools, service } = load(root);
      const propose = tools.get('propose_skill');
      assert.ok(propose);
      const created = await propose.handler({
        name: 'weekly-report',
        description: '生成周报：先汇总事实，再按固定结构输出',
        body: '# weekly-report\n\n## 步骤\n\n1. 汇总事实。',
        reason: '用户强调以后都按这个结构',
      });
      assert.equal(created.ok, true, created.error);
      const proposal = readFileSync(join(root, 'skill-proposals', `${created.data.id}.md`), 'utf8');
      assert.match(proposal, /description: "生成周报/);
      const accepted = service.accept(created.data.id);
      assert.equal(accepted.ok, true, accepted.error);
      const skill = readFileSync(join(root, 'skills', 'weekly-report', 'SKILL.md'), 'utf8');
      assert.match(skill, /name: "weekly-report"/);
      assert.match(skill, /生成周报/);

      const traversal = service.accept('../../outside');
      assert.equal(traversal.ok, false);
      assert.match(String(traversal.error), /非法/);
      assert.equal(service.remove('../../outside').ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('提案按租户隔离，跨租户不可见也不可采纳', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-evolve-'));
    try {
      const { tools, service } = load(root);
      const propose = tools.get('propose_skill');
      const a = await propose.handler({ name: 'tenant-a-skill', description: 'A', body: 'A', reason: 'A' }, { tenantId: 'tenant-a' });
      const b = await propose.handler({ name: 'tenant-b-skill', description: 'B', body: 'B', reason: 'B' }, { tenantId: 'tenant-b' });
      assert.equal(a.ok, true, a.error);
      assert.equal(b.ok, true, b.error);
      assert.deepEqual(
        service.list('tenant-a').map((p: any) => p.name),
        ['tenant-a-skill'],
      );
      assert.deepEqual(
        service.list('tenant-b').map((p: any) => p.name),
        ['tenant-b-skill'],
      );
      const stolen = service.accept(b.data.id, 'tenant-a');
      assert.equal(stolen.ok, false);
      assert.match(String(stolen.error), /不属于当前租户/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
