import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AutomationService, URL_TRIGGER_MAX_BYTES, hashBoundedResponseBody, nextScheduleOccurrence, type AutomationTrigger } from '../automations';
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
      const event = store.runs.update(run, { status: 'cancelled' });
      for (const listener of listeners.get(id) ?? []) listener(event);
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
    root, store, service, runs,
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

  test('用户创建周期、文件和 URL 任务保持待确认，手动与一次性任务直接生效', () => {
    const f = setup();
    try {
      const schedule = f.service.create('default', { name: '日报', prompt: '整理日报', trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, 'user');
      const file = f.service.create('default', { name: '文件监控', prompt: '处理文件', trigger: { type: 'file', path: 'inbox/data.csv' } }, 'user');
      const url = f.service.create('default', { name: '网页监控', prompt: '检查网页', trigger: { type: 'url', url: 'https://example.com/report' } }, 'user');
      const manual = f.service.create('default', { name: '手动任务', prompt: '按需执行', trigger: { type: 'manual' } }, 'user');
      const once = f.service.create('default', { name: '单次提醒', prompt: '提醒我', trigger: { type: 'once', at: Date.now() + 3_600_000 } }, 'user');
      for (const item of [schedule, file, url]) {
        assert.equal(item.approval, 'pending');
        assert.equal(item.state, 'draft');
      }
      for (const item of [manual, once]) {
        assert.equal(item.approval, 'confirmed');
        assert.equal(item.state, 'active');
      }
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

  test('用户创建周期任务仍需确认，敏感字段变更后重新待确认', () => {
    const f = setup();
    try {
      const created = f.service.create('default', {
        name: '周报', prompt: '整理周报',
        trigger: { type: 'schedule', recurrence: 'weekly', dayOfWeek: 1, time: '09:00', timeZone: 'Asia/Shanghai' },
      }, 'user');
      assert.equal(created.approval, 'pending');
      assert.equal(created.state, 'draft');
      const active = f.service.confirm('default', created.id, created.revision);
      assert.equal(active.approval, 'confirmed');
      assert.equal(active.state, 'active');
      const changed = f.service.update('default', active.id, active.revision, { prompt: '整理新版周报' }, 'user');
      assert.equal(changed.approval, 'pending');
      assert.equal(changed.state, 'draft');
      assert.equal(changed.nextDueAt, undefined);
      assert.throws(() => f.service.pause('default', changed.id, changed.revision), /只有已启用的自动化可以暂停/);
      const confirmed = f.service.confirm('default', changed.id, changed.revision);
      assert.equal(confirmed.state, 'active');
      assert.throws(() => f.service.confirm('default', confirmed.id, confirmed.revision), /不在待确认状态/);
      assert.throws(() => f.service.resume('default', confirmed.id, confirmed.revision), /只有已暂停的自动化可以恢复/);
    } finally { f.store.close(); }
  });

  test('过期一次性自动化不能通过确认重新启用', () => {
    const f = setup();
    try {
      const created = f.service.create('default', {
        name: '一次性任务', prompt: '执行',
        trigger: { type: 'once', at: Date.UTC(2026, 2, 1, 13, 0, 0) },
      }, 'agent');
      const pending = f.service.update('default', created.id, created.revision, {
        trigger: { type: 'once', at: Date.UTC(2026, 2, 1, 11, 0, 0) },
      }, 'agent');
      assert.equal(pending.approval, 'pending');
      assert.throws(() => f.service.confirm('default', pending.id, pending.revision), /一次性任务时间已过/);

      const paused = f.service.create('default', {
        name: '暂停的单次任务', prompt: '执行',
        trigger: { type: 'once', at: Date.UTC(2026, 2, 1, 13, 0, 0) },
      }, 'user');
      const stopped = f.service.pause('default', paused.id, paused.revision);
      f.setNow(Date.UTC(2026, 2, 1, 14, 0, 0));
      assert.throws(() => f.service.resume('default', stopped.id, stopped.revision), /一次性任务时间已过/);
      assert.equal(f.service.get('default', stopped.id).state, 'paused');
    } finally { f.store.close(); }
  });

  test('显式不可用 Provider 不静默回退到其他模型', () => {
    const f = setup();
    try {
      assert.throws(() => f.service.create('default', { name: '任务', prompt: '执行', trigger: { type: 'manual' }, providerId: 'missing' }, 'user'), /当前不可用/);
    } finally { f.store.close(); }
  });

  test('没有可用 Provider 时不保存自动化', () => {
    const f = setup();
    try {
      f.store.setProviderEnabled('fixture', 0);
      assert.throws(
        () => f.service.create('default', { name: '任务', prompt: '执行', trigger: { type: 'manual' } }, 'user'),
        /请先在设置中启用模型供应商/,
      );
      assert.equal(f.service.list('default').length, 0);
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
    raw.exec('DROP TABLE scheduled_recovery_jobs_v3; DROP TABLE automation_occurrences_v3; DROP TABLE automation_trigger_baselines_v3; DROP TABLE automations_v3; PRAGMA user_version=8');
    raw.close();
    store = new Store(file);
    try {
      assert.equal(store.schemaVersion, 10);
      assert.equal(store.getSession(session.id, 'default')?.id, session.id);
      assert.doesNotThrow(() => store.automations.list('default'));
      assert.doesNotThrow(() => store.automations.occurrences('default'));
      assert.equal(store.automations.baseline('default', 'none'), undefined);
      assert.deepEqual(store.schedules.list('default'), []);
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

  test('删除运行会话后保留自动化历史且不阻断列表', () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '历史', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      const occurrence = f.service.runNow('default', item.id);
      f.finishRun(occurrence.runId!);
      const run = f.store.runs.get(occurrence.runId!, 'default')!;
      f.store.deleteSession(run.sessionId);
      const history = f.service.occurrences('default', item.id);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.run, undefined);
      assert.equal(history[0]?.runMissing, true);
      assert.doesNotThrow(() => f.service.list('default'));
    } finally { f.store.close(); }
  });

  test('中断的自动化 Run 恢复完成后历史状态随 Run 校正', () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '恢复', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      const occurrence = f.service.runNow('default', item.id);
      f.store.runs.update(f.store.runs.get(occurrence.runId!, 'default')!, { status: 'interrupted' });

      f.service.attach(f.runs);
      assert.equal(f.service.occurrences('default', item.id)[0]?.state, 'failed');

      f.store.runs.update(f.store.runs.get(occurrence.runId!, 'default')!, { status: 'completed' });
      assert.equal(f.service.occurrences('default', item.id)[0]?.state, 'completed');
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

  test('停止本次只取消归属该自动化的活动 Run，不影响自动化定义', () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '可停止任务', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      const occurrence = f.service.runNow('default', item.id);
      assert.ok(occurrence.runId);
      const other = f.service.create('default', { name: '其他任务', prompt: '运行', trigger: { type: 'manual' } }, 'user');
      assert.throws(() => f.service.cancelRun('default', other.id, occurrence.runId!), /该自动化下没有这条运行记录/);
      assert.equal(f.store.runs.get(occurrence.runId!, 'default')?.status, 'running');
      const stopped = f.service.cancelRun('default', item.id, occurrence.runId!);
      assert.equal(stopped.run.status, 'cancelled');
      assert.equal(f.service.occurrences('default', item.id)[0]?.state, 'cancelled');
      assert.equal(f.service.get('default', item.id).state, 'active');
      assert.equal(f.service.tools().some(tool => tool.name === 'automation_cancel_run'), true);
    } finally { f.store.close(); }
  });

  test('逾期超过 24 小时的计划只记录跳过，不创建 Run', async () => {
    const start = Date.UTC(2026, 2, 1, 0, 0, 0);
    const f = setup(start);
    try {
      f.store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
      const item = f.service.create('default', {
        name: '月报', prompt: '整理',
        trigger: { type: 'schedule', recurrence: 'monthly', dayOfMonth: 1, time: '01:00', timeZone: 'UTC', startAt: start + 3_600_000 },
      }, 'user');
      f.service.confirm('default', item.id, item.revision);
      f.setNow(start + 26 * 3_600_000);
      await f.service.tick(start + 26 * 3_600_000);
      const occurrence = f.store.automations.occurrences('default', item.id)[0];
      assert.equal(occurrence?.state, 'skipped'); assert.equal(occurrence?.runId, undefined);
      assert.equal(f.store.runs.list('default').length, 0);
    } finally { f.store.close(); }
  });

  test('一次 tick 合并多段漏跑，只补跑 24 小时内最新一次', async () => {
    const start = Date.UTC(2026, 2, 1, 12, 0, 0);
    const f = setup(start);
    try {
      const item = f.service.create('default', {
        name: '日报', prompt: '整理',
        trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'UTC' },
      }, 'user');
      f.service.confirm('default', item.id, item.revision);
      const now = Date.UTC(2026, 2, 5, 10, 0, 0);
      await f.service.tick(now);

      const history = f.store.automations.occurrences('default', item.id).sort((a, b) => a.dueAt - b.dueAt);
      assert.deepEqual(history.map(entry => entry.state), ['skipped', 'skipped', 'skipped', 'running']);
      assert.equal(history.at(-1)?.dueAt, Date.UTC(2026, 2, 5, 9, 0, 0));
      assert.equal(f.store.runs.list('default').length, 1);

      await f.service.tick(now);
      assert.equal(f.store.automations.occurrences('default', item.id).length, 4);
      assert.equal(f.store.runs.list('default').length, 1);
      assert.equal(f.service.get('default', item.id).nextDueAt, Date.UTC(2026, 2, 6, 9, 0, 0));
    } finally { f.store.close(); }
  });

  test('文件触发首轮只建立基线，内容变化只触发一次', async () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '文件', prompt: '处理', trigger: { type: 'file', path: 'inbox.csv' } }, 'user');
      f.service.confirm('default', item.id, item.revision);
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

  test('文件内容 A→B→A→B 能重新捕获第二次 B', async () => {
    const f = setup();
    try {
      const item = f.service.create('default', { name: '文件', prompt: '处理', trigger: { type: 'file', path: 'inbox.csv' } }, 'user');
      f.service.confirm('default', item.id, item.revision);
      const start = Date.now();
      writeFileSync(join(f.root, 'inbox.csv'), 'a');
      await f.service.tick(start);
      for (const [offset, value] of [2_000, 4_000, 6_000].entries()) {
        writeFileSync(join(f.root, 'inbox.csv'), ['b', 'a', 'b'][offset]);
        await f.service.tick(start + value);
      }
      const bHash = createHash('sha256').update('b').digest('hex');
      const bOccurrences = f.store.automations.occurrences('default', item.id)
        .filter(occurrence => occurrence.occurrenceKey.endsWith(`:${bHash}`));
      assert.equal(bOccurrences.length, 2);
      assert.equal(new Set(bOccurrences.map(occurrence => occurrence.occurrenceKey)).size, 2);
    } finally { f.store.close(); }
  });

  test('推进到期计划失败时事务回滚 occurrence 和 nextDueAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-automation-atomic-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    const store = new Store(file);
    const now = Date.UTC(2026, 2, 1, 12, 0, 0);
    store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
    const service = new AutomationService(store, () => root, () => now);
    const item = service.create('default', {
      name: '日报', prompt: '整理', trigger: { type: 'schedule', recurrence: 'daily', time: '09:00', timeZone: 'UTC' },
    }, 'user');
    const confirmed = service.confirm('default', item.id, item.revision);
    const raw = new Database(file);
    try {
      raw.exec(`CREATE TRIGGER fail_due_advance BEFORE UPDATE OF next_due_at ON automations_v3
        BEGIN SELECT RAISE(ABORT, 'forced advance failure'); END;`);
      assert.throws(
        () => store.automations.claimDue(confirmed, confirmed.nextDueAt! + 86_400_000, now),
        /forced advance failure/,
      );
      assert.equal(store.automations.occurrences('default', item.id).length, 0);
      assert.equal(service.get('default', item.id).nextDueAt, confirmed.nextDueAt);
    } finally {
      raw.close();
      store.close();
    }
  });

  test('重启后既有 occurrence 只推进计划且不会重复创建', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-automation-reopen-'));
    roots.push(root);
    const file = join(root, 'agent.db');
    const now = Date.UTC(2026, 2, 1, 12, 0, 0);
    let store = new Store(file);
    store.upsertProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://example.test/v1', apiKey: '', model: 'fixture-model' });
    let service = new AutomationService(store, () => root, () => now);
    const item = service.create('default', { name: '一次', prompt: '执行', trigger: { type: 'once', at: now + 1_000 } }, 'user');
    store.automations.beginOccurrence({
      automationId: item.id, tenantId: 'default', occurrenceKey: `once:${item.nextDueAt!}`,
      dueAt: item.nextDueAt!, reason: 'schedule', now,
    });
    assert.equal(store.automations.occurrences('default', item.id).length, 1);
    store.close();

    store = new Store(file);
    service = new AutomationService(store, () => root, () => now);
    try {
      await service.tick(item.nextDueAt);
      assert.equal(store.automations.occurrences('default', item.id).length, 1);
      assert.equal(service.get('default', item.id).nextDueAt, undefined);
      assert.equal(service.get('default', item.id).state, 'completed');
    } finally { store.close(); }
  });

  test('文件触发器拒绝生成目录大小写绕过和符号链接越界', async () => {
    const f = setup();
    try {
      assert.throws(
        () => f.service.create('default', { name: '生成目录', prompt: '处理', trigger: { type: 'file', path: 'OUTPUTS/report.csv' } }, 'user'),
        /不能指向生成或运行时目录/,
      );
      assert.throws(
        () => f.service.create('default', { name: '相对生成目录', prompt: '处理', trigger: { type: 'file', path: './outputs/report.csv' } }, 'user'),
        /不能指向生成或运行时目录/,
      );
      const outside = mkdtempSync(join(tmpdir(), 'mh-automation-outside-'));
      roots.push(outside);
      writeFileSync(join(outside, 'secret.txt'), 'outside');
      symlinkSync(outside, join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const item = f.service.create('default', {
        name: '链接监控', prompt: '处理', trigger: { type: 'file', path: 'escape/secret.txt' },
      }, 'user');
      f.service.confirm('default', item.id, item.revision);
      await f.service.tick(Date.UTC(2026, 2, 1, 12, 0, 1));
      assert.equal(f.service.get('default', item.id).triggerError, '文件触发器越出工作区');
      assert.equal(f.store.automations.baseline('default', item.id), undefined);
      assert.equal(f.store.automations.occurrences('default', item.id).length, 0);
    } finally { f.store.close(); }
  });

  test('URL 触发器在读取前和流式读取中都不超过 2 MB', async () => {
    const declared = new Response('small', { headers: { 'content-length': String(URL_TRIGGER_MAX_BYTES + 1) } });
    await assert.rejects(hashBoundedResponseBody(declared), /超过 2 MB/);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 3) { controller.close(); return; }
        controller.enqueue(new Uint8Array(URL_TRIGGER_MAX_BYTES / 2));
      },
    });
    await assert.rejects(hashBoundedResponseBody(new Response(body)), /超过 2 MB/);
    assert.equal(pulled < 4, true);
    assert.equal(await hashBoundedResponseBody(new Response('safe')), createHash('sha256').update('safe').digest('hex'));
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

  test('DST 跳时缺口中的不存在时间确定性顺延到下一次有效本地时间', () => {
    const next = nextScheduleOccurrence(
      trigger({ time: '02:30', timeZone: 'America/New_York' }),
      Date.UTC(2026, 2, 8, 6, 0),
    );
    assert.equal(new Date(next).toISOString(), '2026-03-08T07:30:00.000Z');
  });

  test('DST 回拨重复时间只运行当天第一次，不重复执行同一本地计划', () => {
    const first = nextScheduleOccurrence(
      trigger({ time: '01:30', timeZone: 'America/New_York' }),
      Date.UTC(2026, 10, 1, 4, 0),
    );
    assert.equal(new Date(first).toISOString(), '2026-11-01T05:30:00.000Z');
    const next = nextScheduleOccurrence(
      trigger({ time: '01:30', timeZone: 'America/New_York' }),
      first,
    );
    assert.equal(new Date(next).toISOString(), '2026-11-02T06:30:00.000Z');
  });
});
