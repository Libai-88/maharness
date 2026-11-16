import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AutomationService, nextScheduleOccurrence, type AutomationTrigger } from '../automations';
import { Store } from '../db';
import type { RunService } from '../run-service';
import type { RunEvent, RunRecord } from '../../kernel/run';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 可能延迟释放 */ }
  }
});

function setup(nowValue = Date.UTC(2026, 2, 1, 12, 0, 0)) {
  const root = mkdtempSync(join(tmpdir(), 'mh-automation-'));
  roots.push(root);
  const store = new Store(':memory:');
  store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
  let now = nowValue;
  let sequence = 0;
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  const runs = {
    create(session: { id: string; tenantId?: string }, input: { message: string; provider?: string; model?: string; origin?: RunRecord['origin'] }) {
      const id = `run-${++sequence}`;
      const record: RunRecord = {
        id, sessionId: session.id, tenantId: session.tenantId ?? 'default', rootId: id, depth: 0,
        objective: input.message, providerId: input.provider ?? 'fixture', model: input.model ?? 'fixture-model',
        status: 'running', createdAt: now, updatedAt: now, cost: 0, tokensIn: 0, tokensOut: 0,
        authorization: { workspace: root, profile: 'standard', readOnly: false, revision: 0 },
        ...(input.origin ? { origin: input.origin } : {}),
      };
      store.runs.create(record);
      return record;
    },
    get(id: string, tenantId: string) {
      const run = store.runs.get(id, tenantId);
      if (!run) throw new Error('任务不存在');
      return run;
    },
    cancel(id: string, tenantId: string) {
      const run = store.runs.get(id, tenantId)!;
      store.runs.update(run, { status: 'cancelled' });
      return run;
    },
    subscribe(id: string, listener: (event: RunEvent) => void) {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => { set.delete(listener); };
    },
  } satisfies Pick<RunService, 'create' | 'get' | 'cancel' | 'subscribe'>;
  const finishRun = (id: string, status: 'completed' | 'failed' = 'completed') => {
    const run = store.runs.get(id, 'default')!;
    const event = store.runs.update(run, { status });
    for (const listener of listeners.get(id) ?? []) listener(event);
  };
  const service = new AutomationService(store, () => root, () => now, { filePollMs: 1_000, urlPollMs: 30_000 });
  service.attach(runs);
  return {
    root, store, service,
    setNow(value: number) { now = value; },
    finishRun,
  };
}

describe('自动化定义、确认与版本边界', () => {
  test('自动化工具公开预设触发器 schema，并接受 ISO 一次性时间', async () => {
    const f = setup();
    try {
      const tool = f.service.tools().find(item => item.name === 'automation_create');
      assert.ok(tool);
      const triggerSchema = (tool!.parameters.properties as Record<string, {
        enum?: string[];
        properties?: Record<string, { enum?: string[] }>;
      }>).trigger;
      assert.deepEqual(triggerSchema.properties?.type?.enum, ['manual', 'once', 'schedule', 'file', 'url']);
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const result = await tool!.handler({
        name: 'ISO 预约',
        prompt: '整理资料',
        trigger: { type: 'once', at },
      }, { tenantId: 'default', providerId: 'fixture', model: 'fixture-model' } as never);
      assert.equal(result.ok, true);
      const created = f.service.list('default').find(item => item.name === 'ISO 预约');
      assert.equal(created?.approval, 'confirmed');
      assert.deepEqual(created?.trigger, { type: 'once', at: Date.parse(at) });
    } finally { f.store.close(); }
  });

  test('自动化工具接受常见 cron/字段别名并转换为预设触发结构', async () => {
    const f = setup();
    try {
      const create = f.service.tools().find(item => item.name === 'automation_create')!;
      const result = await create.handler({
        name: '周一提醒',
        prompt: '整理资料',
        trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Asia/Shanghai' },
      }, { tenantId: 'default', providerId: 'fixture', model: 'fixture-model' } as never);
      assert.equal(result.ok, true);
      const scheduled = f.service.list('default').find(item => item.name === '周一提醒')!;
      assert.deepEqual(scheduled.trigger, {
        type: 'schedule', recurrence: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', dayOfWeek: 1,
      });
      assert.equal(scheduled.approval, 'pending');

      const file = await create.handler({
        name: '文件提醒',
        prompt: '整理资料',
        trigger: { type: 'file', filePath: 'inbox/data.csv' },
      }, { tenantId: 'default', providerId: 'fixture', model: 'fixture-model' } as never);
      assert.equal(file.ok, true);
      assert.equal(f.service.list('default').find(item => item.name === '文件提醒')?.trigger.type, 'file');
    } finally { f.store.close(); }
  });

  test('自动化校验失败返回可操作提示并声明可重试', async () => {
    const f = setup();
    try {
      const create = f.service.tools().find(item => item.name === 'automation_create')!;
      const result = await create.handler({
        name: '错误时间',
        prompt: '整理资料',
        trigger: { type: 'once', at: 'not-a-date' },
      }, { tenantId: 'default' } as never);
      assert.equal(result.ok, false);
      assert.equal(result.failure?.code, 'INVALID_TRIGGER');
      assert.equal(result.failure?.retryable, true);
      assert.match((result.data as { hint: string }).hint, /type:"once"/);
    } finally { f.store.close(); }
  });

  test('自动化工具按公开契约归一化字符串月日与 Unix 秒时间', async () => {
    const f = setup();
    try {
      const create = f.service.tools().find(item => item.name === 'automation_create')!;
      const monthly = await create.handler({
        name: '月度提醒',
        prompt: '整理资料',
        trigger: { type: 'schedule', recurrence: 'monthly', dayOfMonth: '15', time: '09:00', timeZone: 'Asia/Shanghai' },
      }, { tenantId: 'default' } as never);
      assert.equal(monthly.ok, true);
      const scheduled = f.service.list('default').find(item => item.name === '月度提醒')!;
      assert.equal(scheduled.trigger.type === 'schedule' && scheduled.trigger.dayOfMonth, 15);

      const seconds = Math.trunc((Date.now() + 3_600_000) / 1000);
      const once = await create.handler({
        name: '一次性提醒',
        prompt: '提醒我',
        trigger: { type: 'once', at: seconds },
      }, { tenantId: 'default' } as never);
      assert.equal(once.ok, true);
      const oneOff = f.service.list('default').find(item => item.name === '一次性提醒')!;
      assert.equal(oneOff.trigger.type === 'once' && oneOff.trigger.at, seconds * 1000);
    } finally { f.store.close(); }
  });

  test('automation_update 公开 patch 契约而不是无约束对象', () => {
    const f = setup();
    try {
      const tool = f.service.tools().find(item => item.name === 'automation_update')!;
      const patch = (tool.parameters.properties as Record<string, any>).patch;
      assert.equal(patch.additionalProperties, false);
      assert.ok(patch.properties.prompt);
      assert.ok(patch.properties.trigger.properties.timeZone);
      assert.ok(patch.properties.materials.items);
      assert.deepEqual(tool.discovery?.pluginId, 'server.automations');
    } finally { f.store.close(); }
  });

  test('模型创建一次性任务直接生效，周期和文件任务保持待确认', () => {
    const f = setup();
    try {
      const once = f.service.create('default', { name: '单次提醒', prompt: '提醒我开会', trigger: { type: 'once', at: Date.now() + 3_600_000 } }, 'agent');
      const schedule = f.service.create('default', { name: '日报', prompt: '整理日报', trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, 'agent');
      const file = f.service.create('default', { name: '文件监控', prompt: '处理文件', trigger: { type: 'file', path: 'inbox/data.csv' } }, 'agent');
      assert.equal(once.approval, 'confirmed'); assert.equal(once.state, 'active');
      assert.equal(schedule.approval, 'pending'); assert.equal(schedule.state, 'draft'); assert.equal(schedule.nextDueAt, undefined);
      assert.equal(file.approval, 'pending'); assert.equal(file.state, 'draft');
    } finally { f.store.close(); }
  });

  test('修改敏感字段后重新待确认，过期 revision 拒绝覆盖', () => {
    const f = setup();
    try {
      const created = f.service.create('default', { name: '周报', prompt: '整理周报', trigger: { type: 'schedule', recurrence: 'weekly', dayOfWeek: 1, time: '09:00', timeZone: 'Asia/Shanghai' } }, 'user');
      const changed = f.service.update('default', created.id, created.revision, { trigger: { type: 'schedule', recurrence: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } }, 'agent');
      assert.equal(changed.approval, 'pending'); assert.equal(changed.state, 'draft'); assert.equal(changed.nextDueAt, undefined);
      assert.throws(() => f.service.update('default', created.id, created.revision, { prompt: '越过版本' }, 'agent'), /自动化已变化/);
    } finally { f.store.close(); }
  });

  test('显式不可用 Provider 不静默回退到其他模型', () => {
    const f = setup();
    try {
      assert.throws(() => f.service.create('default', { name: '任务', prompt: '执行', trigger: { type: 'manual' }, providerId: 'missing' }, 'user'), /当前不可用/);
    } finally { f.store.close(); }
  });

  test('定义和服务重启后仍可读取', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-automation-restart-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    let store = new Store(file);
    store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
    const service = new AutomationService(store, () => root);
    const created = service.create('default', { name: '持久任务', prompt: '继续处理', trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, 'agent');
    store.close();
    store = new Store(file);
    try {
      const loaded = new AutomationService(store, () => root).get('default', created.id);
      assert.equal(loaded.name, '持久任务'); assert.equal(loaded.approval, 'pending');
    } finally { store.close(); }
  });

  test('schema 8 迁移到 9 保留会话并建立自动化、发生记录和触发基线表', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-automation-migration-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    let store = new Store(file);
    const session = store.createSession('fixture-model', 'fixture');
    store.close();
    const raw = new Database(file);
    raw.exec('DROP TABLE automation_occurrences_v3; DROP TABLE automation_trigger_baselines_v3; DROP TABLE automations_v3; PRAGMA user_version=8');
    raw.close();
    store = new Store(file);
    try {
      assert.equal(store.schemaVersion, 9);
      assert.equal(store.getSession(session.id, 'default')?.id, session.id);
      assert.doesNotThrow(() => store.automations.list('default'));
      assert.doesNotThrow(() => store.automations.occurrences('default'));
      assert.equal(store.automations.baseline('default', 'none'), undefined);
    } finally { store.close(); }
  });
});

describe('自动化计划与触发', () => {
  test('occurrence 幂等，重复键只创建一次', () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '手动', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      const input = { automationId: item.id, tenantId: 'default', occurrenceKey: 'same-key', dueAt: 1_000, now: 1_000 };
      assert.ok(f.store.automations.beginOccurrence(input));
      assert.equal(f.store.automations.beginOccurrence(input), undefined);
      assert.equal(f.store.automations.occurrences('default', item.id).length, 1);
    } finally { f.store.close(); }
  });

  test('同一自动化已有活动运行时，新触发标记跳过', () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '单实例', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      const session = f.store.createSession('fixture-model', 'fixture');
      f.store.runs.create({
        id: 'existing-run', sessionId: session.id, tenantId: 'default', rootId: 'existing-run', depth: 0,
        objective: '已有任务', providerId: 'fixture', model: 'fixture-model', status: 'running',
        createdAt: Date.now(), updatedAt: Date.now(), cost: 0, tokensIn: 0, tokensOut: 0,
        authorization: { workspace: f.root, profile: 'standard', readOnly: false, revision: 0 },
      });
      f.store.automations.update({ ...item, executionSessionId: session.id, revision: item.revision + 1, updatedAt: Date.now() }, item.revision);
      const occurrence = f.service.runNow('default', item.id);
      assert.equal(occurrence.state, 'skipped');
      assert.equal(f.store.runs.get('existing-run', 'default')?.status, 'running');
    } finally { f.store.close(); }
  });

  test('逾期超过 24 小时的计划只记录跳过，不创建 Run', async () => {
    const start = Date.UTC(2026, 2, 1, 0, 0, 0);
    const f = setup(start);
    try {
      f.store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
      const item = f.service.create('default', { name: '日报', prompt: '整理', trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'UTC', startAt: start + 3_600_000 } }, 'user');
      f.setNow(start + 26 * 3_600_000);
      await f.service.tick(start + 26 * 3_600_000);
      const occurrence = f.store.automations.occurrences('default', item.id)[0];
      assert.equal(occurrence?.state, 'skipped'); assert.equal(occurrence?.runId, undefined);
      assert.equal(f.store.runs.list('default').length, 0);
    } finally { f.store.close(); }
  });

  test('文件触发首轮只建立基线，内容变化只触发一次', async () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '文件', prompt: '处理', trigger: { type: 'file', path: 'inbox.csv' } }, 'user');
      writeFileSync(join(f.root, 'inbox.csv'), 'a');
      await f.service.tick(Date.now());
      assert.equal(f.store.automations.occurrences('default', item.id).length, 0);
      assert.ok(f.store.automations.baseline('default', item.id)?.value);
      writeFileSync(join(f.root, 'inbox.csv'), 'b');
      const later = Date.now() + 2_000;
      await f.service.tick(later);
      await f.service.tick(later + 2_000);
      assert.equal(f.store.automations.occurrences('default', item.id).length, 1);
    } finally { f.store.close(); }
  });
});

describe('周期计算', () => {
  const trigger = (overrides: Partial<Extract<AutomationTrigger, { type: 'schedule' }>>): Extract<AutomationTrigger, { type: 'schedule' }> => ({
    type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'UTC', ...overrides,
  });

  test('每月 31 日在短月份落到月末', () => {
    const next = nextScheduleOccurrence(trigger({ recurrence: 'monthly', dayOfMonth: 31 }), Date.UTC(2026, 0, 31, 10, 0));
    assert.equal(new Date(next).toISOString(), '2026-02-28T09:00:00.000Z');
  });

  test('IANA 时区跨 DST 仍按本地 09:00 计算', () => {
    const next = nextScheduleOccurrence(trigger({ timeZone: 'America/New_York' }), Date.UTC(2026, 2, 8, 5, 0));
    assert.equal(new Date(next).toISOString(), '2026-03-08T13:00:00.000Z');
  });
});
