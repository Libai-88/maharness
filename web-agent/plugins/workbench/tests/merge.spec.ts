import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capability, PluginContext, ToolDef } from '../../../kernel/types';
import { PersonalItems } from '../../../core/todo/items';
import { mergeData, mergeDiary, mergeMeta, type Note, type Project, type Task } from '../model';
import workbench from '../index';

const t = (id: string, updatedAt: number, extra: Partial<Task> = {}): Task =>
  ({ id, title: id, prio: 3, due: '', start: '', done: false, pid: '', createdAt: updatedAt, doneAt: null, rolls: 0, repeat: '', pomo: 0, subs: [], tags: [], link: '', note: '', status: 'todo', est: 0, updatedAt, ...extra });

describe('workbench 桥合并', () => {
  it('工作台兼容工具与桥接接口读取调用方租户的数据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-workbench-tenant-'));
    try {
      const items = new PersonalItems(root);
      items.create('default', { title: '默认租户' });
      items.create('team-a', { title: '团队事项' });
      const tools = new Map<string, ToolDef>();
      let api: Extract<Capability, { kind: 'api' }>['api'] | undefined;
      const ctx = {
        kernel: { plugins: { resolveService: () => items } },
        register: (capability: Capability) => {
          if (capability.kind === 'tool') tools.set(capability.tool.name, capability.tool);
          if (capability.kind === 'api') api = capability.api;
          return () => {};
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      } as unknown as PluginContext;
      workbench.onLoad(ctx);
      const result = await tools.get('workbench_today')!.handler({}, {
        tenantId: 'team-a', sessionId: 'session-a',
      } as never) as { ok: boolean; data?: { tasks: { title: string }[] } };
      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.tasks.map(item => item.title), ['团队事项']);
      let workspace: { revision: number; data: { tasks: { title: string }[] } } | undefined;
      api!.router({ method: 'GET', path: '/data', tenantId: 'team-a' } as never, {
        json: (value: typeof workspace) => { workspace = value; },
        status: () => ({ json: () => {} }),
      } as never);
      assert.deepEqual(workspace?.data.tasks.map(item => item.title), ['团队事项']);
      workspace!.data.tasks[0].title = '团队事项已更新';
      let saved: { data: { tasks: { title: string }[] } } | undefined;
      api!.router({
        method: 'PUT', path: '/data', tenantId: 'team-a',
        body: { data: workspace!.data, revision: workspace!.revision },
      } as never, {
        json: (value: typeof saved) => { saved = value; },
        status: () => ({ json: () => {} }),
      } as never);
      assert.deepEqual(saved?.data.tasks.map(item => item.title), ['团队事项已更新']);
      assert.deepEqual(items.list('default').map(item => item.title), ['默认租户']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('兼容工具可显式更新项目和笔记，拒绝过期版本并保持租户隔离', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-workbench-records-'));
    try {
      const items = new PersonalItems(root);
      const tools = new Map<string, ToolDef>();
      const ctx = {
        kernel: { plugins: { resolveService: () => items } },
        register: (capability: Capability) => {
          if (capability.kind === 'tool') tools.set(capability.tool.name, capability.tool);
          return () => {};
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      } as unknown as PluginContext;
      workbench.onLoad(ctx);
      const call = (name: string, args: Record<string, unknown>, tenantId = 'team-a') =>
        tools.get(name)!.handler(args, { tenantId, sessionId: 'session-a' } as never) as Promise<any>;

      const project = await call('workbench_add_project', { name: '发布计划', stage: '设计' });
      assert.equal(project.ok, true);
      const invalidProject = await call('workbench_add_project', { name: '项'.repeat(201) });
      assert.equal(invalidProject.failure.code, 'INVALID_WORKBENCH');
      assert.equal(invalidProject.failure.retryable, true);
      const emptyProject = await call('workbench_update_project', {
        id: project.data.id, updatedAt: project.data.updatedAt,
      });
      assert.equal(emptyProject.failure.code, 'INVALID_WORKBENCH');
      const staleProject = await call('workbench_update_project', {
        id: project.data.id, updatedAt: 1, stage: '发布',
      });
      assert.equal(staleProject.ok, false);
      assert.equal(staleProject.failure.code, 'VERSION_CONFLICT');
      const changedProject = await call('workbench_update_project', {
        id: project.data.id, updatedAt: project.data.updatedAt, stage: '发布', status: 'active',
      });
      assert.equal(changedProject.data.stage, '发布');

      const note = await call('workbench_add_note', { text: '初稿', tags: ['发布'] });
      assert.equal(note.ok, true);
      const invalidNote = await call('workbench_add_note', { text: '记'.repeat(1201) });
      assert.equal(invalidNote.failure.code, 'INVALID_WORKBENCH');
      assert.equal(invalidNote.failure.retryable, true);
      const emptyNote = await call('workbench_update_note', {
        id: note.data.id, updatedAt: note.data.updatedAt,
      });
      assert.equal(emptyNote.failure.code, 'INVALID_WORKBENCH');
      const changedNote = await call('workbench_update_note', {
        id: note.data.id, updatedAt: note.data.updatedAt, text: '终稿',
      });
      assert.equal(changedNote.data.text, '终稿');

      const visible = await call('workbench_today', {});
      assert.equal(visible.data.projects[0].stage, '发布');
      assert.equal(visible.data.notes[0].text, '终稿');
      assert.equal(visible.data.revision > 0, true);
      const otherTenant = await call('workbench_today', {}, 'team-b');
      assert.deepEqual(otherTenant.data.projects, []);
      assert.deepEqual(otherTenant.data.notes, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('LWW：updatedAt 大者胜出', () => {
    const local = { tasks: [t('a', 100, { title: '旧' })], notes: [], projects: [], tomb: {} };
    const remote = { tasks: [t('a', 200, { title: '新' })], notes: [], projects: [], tomb: {} };
    const m = mergeData(local, remote);
    assert.equal(m.tasks.length, 1);
    assert.equal(m.tasks[0].title, '新');
  });

  it('并集：单边独有记录保留', () => {
    const m = mergeData(
      { tasks: [t('a', 1)], notes: [], projects: [], tomb: {} },
      { tasks: [t('b', 1)], notes: [], projects: [], tomb: {} },
    );
    assert.deepEqual(m.tasks.map(x => x.id).sort(), ['a', 'b']);
  });

  it('墓碑：删除时间较新则消失，较旧则复活并清除墓碑', () => {
    const T0 = Date.now();
    const gone = mergeData(
      { tasks: [t('a', T0 - 5000)], notes: [], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [], tomb: { a: T0 } },
    );
    assert.equal(gone.tasks.length, 0);

    const revived = mergeData(
      { tasks: [t('a', T0 + 5000)], notes: [], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [], tomb: { a: T0 } },
    );
    assert.equal(revived.tasks.length, 1);
    assert.equal(revived.tomb.a, undefined);
  });

  it('墓碑：超过 90 天自动清理', () => {
    const ancient = Date.now() - 91 * 864e5;
    const m = mergeData(
      { tasks: [], notes: [], projects: [], tomb: { a: ancient } },
      { tasks: [], notes: [], projects: [], tomb: {} },
    );
    assert.equal(m.tomb.a, undefined);
  });

  it('_s 示例记录：仅一方存在示例时不把示例合并进真实数据', () => {
    const m = mergeData(
      { tasks: [t('real', 100)], notes: [], projects: [], tomb: {} },
      { tasks: [t('demo', 200, { _s: true })], notes: [], projects: [], tomb: {} },
    );
    assert.deepEqual(m.tasks.map(x => x.id), ['real']);
  });

  it('notes / projects 独立合并，互不串档', () => {
    const m = mergeData(
      { tasks: [], notes: [{ id: 'n1', text: 'x', tags: [], createdAt: 1, updatedAt: 5 } as Note], projects: [], tomb: {} },
      { tasks: [], notes: [], projects: [{ id: 'p1', name: 'P', stage: '', next: '', blocker: '', status: 'active', updatedAt: 5 } as Project], tomb: {} },
    );
    assert.equal(m.notes.length, 1);
    assert.equal(m.projects.length, 1);
    assert.equal(m.tasks.length, 0);
  });

  it('mergeDiary 按日期时间戳取新', () => {
    const r = mergeDiary({ '2026-09-01': '本地' }, { '2026-09-01': 100 }, { '2026-09-01': '远端' }, { '2026-09-01': 200 });
    assert.equal(r.diary['2026-09-01'], '远端');
    assert.equal(r.diaryTs['2026-09-01'], 200);
  });

  it('mergeMeta pomoLog 取每日最大值，sample 需双方同时存在', () => {
    const local = { meta: { pomoLog: { '2026-09-01': 5 }, sample: true } } as never;
    const remote = { meta: { pomoLog: { '2026-09-01': 3 }, sample: false } } as never;
    const m = mergeMeta(local, remote);
    assert.equal(m.pomoLog['2026-09-01'], 5);
    assert.equal(m.sample, false);
  });
});
