import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RunEvent, RunRecord } from '../../kernel/run';
import { Store } from '../db';
import { OrganizationService } from '../services/organization/service';
import type { AssignmentContract, OrganizationRole, SocietySchedule, SocietyTask } from '../organization-store';
import { Scheduler } from '../scheduler';
import { SocietyService } from '../services/society';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function setup(): { root: string; store: Store; file: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), 'mh-scheduler-'));
  roots.push(root);
  const store = new Store(join(root, 'agent.db'));
  const session = store.createSession('m');
  store.saveCheckpoint(session.id, 1, [{ role: 'user', content: 'continue' }], 'run-1');
  return { root, store, file: join(root, 'schedules.json'), sessionId: session.id };
}

describe('到点续跑调度器', () => {
  test('schema 9 旧库低于最低支持版本时拒绝打开', () => {
    const { root, store } = setup();
    store.close();
    const dbFile = join(root, 'agent.db');
    const raw = new Database(dbFile);
    raw.exec('DROP TABLE scheduled_recovery_jobs_v3; PRAGMA user_version=9');
    raw.close();
    assert.throws(() => new Store(dbFile), /低于最低支持的 15/);
    const untouched = new Database(dbFile, { readonly: true });
    try {
      assert.equal(untouched.pragma('user_version', { simple: true }), 9);
    } finally {
      untouched.close();
    }
  });

  test('旧 schedules.json 导入 SQLite 后归档源文件', () => {
    const { store, file, sessionId } = setup();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'legacy-job',
            sessionId,
            runId: 'run-1',
            tenantId: 'default',
            dueAt: 2_000,
            state: 'done',
            attempts: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
      'utf8',
    );
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    assert.equal(scheduler.list()[0]?.id, 'legacy-job');
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.migrated`), true);
    store.close();
  });

  test('显式定时恢复使用同一 RunService 并保留用户角色', async () => {
    const { store, file, sessionId } = setup();
    const calls: unknown[] = [];
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    scheduler.attach({
      get: () => ({ id: 'run', sessionId }) as never,
      resume: (...args) => {
        calls.push(args);
        return {} as never;
      },
    });
    const job = scheduler.schedule({ sessionId, runId: 'run', tenantId: 'default', principalRole: 'readonly', dueAt: 1_000 });
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(calls, [['run', 'default', 'readonly']]);
    assert.equal(scheduler.list()[0]?.state, 'done');
    assert.equal(scheduler.list()[0]?.id, job.id);
    store.close();
  });

  test('恢复失败不自动重放，旧 checkpoint 不能执行', async () => {
    const { store, file, sessionId } = setup();
    let calls = 0;
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    scheduler.attach({
      get: () => ({ id: 'run', sessionId }) as never,
      resume: () => {
        calls++;
        throw new Error('outcome unknown');
      },
    });
    scheduler.schedule({ sessionId, runId: 'run', tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(calls, 1);
    assert.equal(scheduler.list()[0]?.state, 'failed');
    scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    await scheduler.tick();
    assert.match(scheduler.list()[0]?.lastError ?? '', /checkpoint/);
    assert.equal(calls, 1);
    store.close();
  });

  test('服务重启后的定时任务需要用户手动恢复', async () => {
    const { store, file, sessionId } = setup();
    const first = new Scheduler(store, { file, now: () => 1_000 });
    first.schedule({ sessionId, runId: 'run', tenantId: 'default', dueAt: 2_000 });
    const restored = new Scheduler(store, { file, now: () => 3_000 });
    await restored.tick();
    assert.equal(restored.list()[0]?.state, 'failed');
    assert.match(restored.list()[0]?.lastError ?? '', /手动恢复/);
    store.close();
  });

  test('取消后不再执行', async () => {
    const { store, file, sessionId } = setup();
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    const job = scheduler.schedule({ sessionId, tenantId: 'default', dueAt: 1_000 });
    assert.equal(scheduler.cancel(job.id), true);
    await scheduler.tick();
    assert.equal(scheduler.list()[0]?.state, 'failed');
    store.close();
  });

  test('系统调度周期会推进无主 Agent 的社会任务', async () => {
    const { store, file } = setup();
    let ticks = 0;
    const scheduler = new Scheduler(store, { file, now: () => 1_000 });
    scheduler.attachSociety({
      tickAll: () => {
        ticks++;
        return { tenants: 0, decisions: [], queued: 0, waitingApproval: 0, failed: [] };
      },
    });
    await scheduler.tick();
    assert.equal(ticks, 1);
    store.close();
  });

  test('自动调度周期无需手动 tick 即可推进 queued 社会任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-scheduler-society-auto-'));
    roots.push(root);
    const store = new Store(join(root, 'agent.db'));
    const listeners = new Map<string, Set<(event: RunEvent) => void>>();
    const organization = new OrganizationService({
      store,
      runtimeAuthority: () => ({ workspace: process.cwd(), readOnly: false, profile: 'standard' }),
    });
    const runtime = {
      startSocietyAssignment(input: {
        task: SocietyTask;
        schedule: SocietySchedule;
        role: OrganizationRole;
        contract: AssignmentContract;
      }): RunRecord {
        const session = store.createSession('fixture-model', 'fixture', input.task.tenantId);
        const now = Date.now();
        const run: RunRecord = {
          id: randomUUID(),
          rootId: '',
          sessionId: session.id,
          tenantId: input.task.tenantId,
          depth: 0,
          objective: input.contract.branchObjective,
          providerId: 'fixture',
          model: 'fixture-model',
          status: 'running',
          cost: 0,
          tokensIn: 0,
          tokensOut: 0,
          createdAt: now,
          updatedAt: now,
          authorization: {
            workspace: process.cwd(),
            profile: 'standard',
            readOnly: false,
            revision: 0,
          },
          requestFingerprint: randomUUID(),
          budgetUsd: input.contract.budgetUsd,
          budgetTokens: input.contract.budgetTokens,
          budgetPolicy: 'enforce',
          origin: {
            kind: 'society',
            societyTaskId: input.task.id,
            scheduleId: input.schedule.id,
            assignmentContractId: input.contract.id,
          },
          workOrderId: input.contract.workOrderId,
          assignmentContractId: input.contract.id,
          organizationRoleId: input.role.id,
          teamCycleId: input.contract.teamCycleId,
        };
        run.rootId = run.id;
        organization.prepareSocietyRun(run, input.contract.id);
        store.runs.create(run);
        return store.runs.get(run.id, run.tenantId)!;
      },
      get(runId: string, tenantId: string): RunRecord {
        const run = store.runs.get(runId, tenantId);
        if (!run) throw new Error('RUN_NOT_FOUND');
        return run;
      },
      subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
        let current = listeners.get(runId);
        if (!current) {
          current = new Set();
          listeners.set(runId, current);
        }
        const target = current;
        target.add(listener);
        return () => {
          target.delete(listener);
        };
      },
      cancel(runId: string, tenantId: string): RunRecord {
        const run = store.runs.get(runId, tenantId)!;
        store.runs.update(run, { status: 'cancelled' });
        return store.runs.get(run.id, tenantId)!;
      },
    };
    const society = new SocietyService({ store, organization, runs: runtime });
    const scheduler = new Scheduler(store, {
      file: join(root, 'schedules.json'),
      intervalMs: 250,
    });
    try {
      scheduler.attachSociety(society);
      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const task = society.createTask({
        tenantId: 'default',
        objective: '自动调度一份会议纪要',
        valueUsd: 5,
        maxBudgetUsd: 0.08,
        departmentId: 'operations',
      });
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'queued');
      assert.equal(store.runs.list('default').length, 0);
      const deadline = Date.now() + 3_000;
      while (store.organization.getSocietyTask(task.id, 'default')?.status !== 'scheduled' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'scheduled');
      assert.equal(store.runs.list('default').length, 1);
    } finally {
      scheduler.stop();
      store.close();
    }
  });
});
