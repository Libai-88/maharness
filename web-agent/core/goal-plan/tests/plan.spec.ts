import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import goalPlan from '../index';
import { canTransition } from '../store';

type Tool = { name: string; handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> };

function loadTools(root: string): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  (goalPlan as unknown as { onLoad: (ctx: unknown) => void }).onLoad({
    register(value: { kind: string; tool?: Tool; api?: { router: unknown } }) {
      if (value.kind === 'tool' && value.tool) tools.set(value.tool.name, value.tool);
      if (value.kind === 'api' && value.api) (tools as unknown as { router?: unknown }).router = value.api.router;
    },
    paths: { data: root },
    bus: { emit() {} },
    logger: { info() {} },
  });
  return tools;
}

const tctx = { sessionId: 's', turn: 0, sandboxRoot: '.', cache: {}, trace: {} };

describe('计划步骤状态机', () => {
  test('计划查询端点按租户隔离会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plan-tenant-'));
    try {
      const tools = loadTools(root);
      const router = (tools as unknown as { router: (req: unknown, res: unknown) => Promise<void> }).router;
      const tenantA = { ...tctx, tenantId: 'tenant-a' };
      await tools.get('create_plan')!.handler({ objective: 'A plan', steps: ['one'] }, tenantA);
      const query = (tenantId: string) => new Promise<{ plan: unknown }>((resolve) => {
        void router({ method: 'GET', path: '/plan', query: { sessionId: 's' }, tenantId }, { json: resolve, status: () => ({ json: resolve }) });
      });
      assert.equal((await query('tenant-a')).plan !== null, true);
      assert.equal((await query('tenant-b')).plan, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('允许的迁移与非法迁移', () => {
    assert.equal(canTransition('pending', 'in_progress'), true);
    assert.equal(canTransition('pending', 'done'), true);
    assert.equal(canTransition('in_progress', 'blocked'), true);
    assert.equal(canTransition('blocked', 'in_progress'), true);
    assert.equal(canTransition('done', 'in_progress'), true);
    assert.equal(canTransition('done', 'blocked'), false);
    assert.equal(canTransition('blocked', 'done'), false);
  });

  test('update/complete 通过同一状态机，未完成步骤不能收尾', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-plan-'));
    try {
      const tools = loadTools(root);
      const created = await tools.get('create_plan')!.handler({ objective: '交付', steps: ['实现', '验证'] }, tctx);
      assert.equal(created.ok, true);

      const done = await tools.get('update_plan_progress')!.handler({ stepIndex: 0, status: 'done', note: '实现完成' }, tctx);
      assert.equal(done.ok, true);
      const illegal = await tools.get('update_plan_progress')!.handler({ stepIndex: 0, status: 'blocked' }, tctx);
      assert.equal(illegal.ok, false);
      assert.match(String(illegal.error), /非法步骤状态迁移/);

      const reopen = await tools.get('update_plan_progress')!.handler({ stepIndex: 0, status: 'in_progress', note: '需要返工' }, tctx);
      assert.equal(reopen.ok, true);
      const finishStep1 = await tools.get('update_plan_progress')!.handler({ stepIndex: 1, status: 'done' }, tctx);
      assert.equal(finishStep1.ok, true);
      const blockedComplete = await tools.get('complete_goal')!.handler({ summary: '完成' }, tctx);
      assert.equal(blockedComplete.ok, false);
      assert.match(String(blockedComplete.error), /步骤未完成/);

      assert.equal((await tools.get('update_plan_progress')!.handler({ stepIndex: 0, status: 'done' }, tctx)).ok, true);
      const completed = await tools.get('complete_goal')!.handler({ summary: '全部完成' }, tctx);
      assert.equal(completed.ok, true);
      assert.equal(completed.data?.completed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
