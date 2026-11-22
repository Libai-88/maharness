import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoop } from '../../kernel/loop';
import { RUN_TERMINAL, type RunRecord } from '../../kernel/run';
import type { ProviderDef } from '../../kernel/types';
import { Store } from '../db';
import { OrganizationService } from '../services/organization/service';
import { RunService } from '../run-service';
import { Scheduler } from '../scheduler';
import { SocietyService } from '../services/society';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function releasedOrAborted(release: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(true);
    signal?.addEventListener('abort', onAbort, { once: true });
    void release.then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    });
  });
}

function terminal(service: RunService, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const current = service.get(runId, 'default');
    if (RUN_TERMINAL.has(current.status)) {
      resolve();
      return;
    }
    const unsubscribe = service.subscribe(runId, (event) => {
      if (event.type === 'state' && RUN_TERMINAL.has(event.data.status as RunRecord['status'])) {
        unsubscribe();
        resolve();
      }
    });
  });
}

test('society restart resumes the same interrupted Run through real services', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-society-restart-'));
  const workspace = join(root, 'workspace');
  const database = join(root, 'agent.db');
  mkdirSync(workspace, { recursive: true });

  const provider: ProviderDef = {
    id: 'restart-provider',
    label: 'Restart provider',
    defaultModel: 'restart-model',
    prices: { in: 0, out: 0 },
    async *chat() {},
  };
  const firstEntered = deferred();
  const resumedEntered = deferred();
  const finishResumed = deferred();
  let calls = 0;
  const loop: AgentLoop = {
    approveApproval: () => false,
    async *run(options) {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await abortSignal(options.signal);
        return;
      }
      if (calls === 2) {
        resumedEntered.resolve();
        const aborted = await releasedOrAborted(finishResumed.promise, options.signal);
        if (aborted) return;
        yield {
          type: 'assistant_done',
          content: 'resumed society delivery',
          reasoning: '',
          usage: { input: 4, output: 2 },
          cost: 0,
        };
        return;
      }
      throw new Error(`unexpected loop invocation ${calls}`);
    },
  };

  const environment = (store: Store, organization: OrganizationService) => ({
    store,
    organization,
    runner: () => loop,
    workspace: () => workspace,
    projectRoot: workspace,
    provider: () => ({ id: provider.id, model: provider.defaultModel }),
    prepare: () => ({ provider, model: provider.defaultModel, messages: [], traceId: '' }),
  });
  const authority = () => ({
    workspace,
    readOnly: false,
    profile: 'standard' as const,
  });

  let store: Store | undefined;
  let firstRuns: RunService | undefined;
  let restartedRuns: RunService | undefined;
  try {
    store = new Store(database);
    store.upsertProvider({
      id: provider.id,
      label: provider.label,
      baseUrl: 'http://unused.invalid',
      apiKey: '',
      model: provider.defaultModel,
      priceIn: 0,
      priceOut: 0,
      enabled: 1,
    });
    const organization = new OrganizationService({ store, runtimeAuthority: authority });
    firstRuns = new RunService(environment(store, organization));
    const society = new SocietyService({ store, organization });
    society.attachRunService(firstRuns);

    const task = society.createTask({
      tenantId: 'default',
      objective: 'Prove a society Run survives runtime restart',
      acceptance: ['Return the resumed delivery'],
      valueUsd: 5,
      maxBudgetUsd: 0.08,
      departmentId: 'operations',
    });
    const schedule = society.tick('default').decisions.find((item) => item.taskId === task.id);
    assert.ok(schedule, 'society task was not scheduled');
    const runId = schedule.runIds[0];
    const contractId = schedule.contractIds[0];
    const roleId = schedule.roleIds[0];
    assert.ok(runId, 'society schedule did not start a Run');
    assert.ok(contractId, 'society Run has no assignment contract');
    assert.ok(roleId, 'society schedule did not select a role');
    assert.equal(
      organization.roleHistory(roleId, 'default').versions.length,
      1,
      'runtime workspace/session binding must not create a governance version',
    );

    await firstEntered.promise;
    assert.equal(firstRuns.get(runId, 'default').status, 'running');
    assert.equal(store.organization.getContract(contractId, 'default')?.status, 'active');

    await firstRuns.shutdown();
    assert.equal(firstRuns.get(runId, 'default').status, 'interrupted');
    assert.equal(store.organization.getContract(contractId, 'default')?.status, 'active');

    store.close();
    store = undefined;
    store = new Store(database);
    const restartedOrganization = new OrganizationService({ store, runtimeAuthority: authority });
    restartedRuns = new RunService(environment(store, restartedOrganization));
    const restartedSociety = new SocietyService({ store, organization: restartedOrganization });
    restartedSociety.attachRunService(restartedRuns);
    assert.equal(
      restartedOrganization.roleHistory(roleId, 'default').versions.length,
      1,
      'restart must preserve the governance version history',
    );

    const scheduler = new Scheduler(store, { file: join(root, 'schedules.db'), now: () => Date.now() });
    scheduler.attachSociety(restartedSociety);
    await scheduler.tick();
    await resumedEntered.promise;

    const resumed = restartedRuns.get(runId, 'default');
    assert.equal(resumed.id, runId);
    assert.equal(resumed.status, 'running');
    assert.equal(store.organization.getContract(contractId, 'default')?.status, 'active');
    const resumedSchedule = store.organization.getSocietySchedule(schedule.id, 'default');
    assert.equal(resumedSchedule?.status, 'active');
    assert.deepEqual(resumedSchedule?.selection, schedule.selection);
    assert.equal(store.organization.getSocietyTask(task.id, 'default')?.status, 'scheduled');
    assert.deepEqual(
      store.runs.list('default').map((run) => run.id),
      [runId],
    );

    const completed = terminal(restartedRuns, runId);
    finishResumed.resolve();
    await completed;
    assert.equal(restartedRuns.get(runId, 'default').status, 'completed');
    const accepted = restartedSociety.releaseTask(task.id, 'default', 'completed', '人工核对恢复后的交付与来源');
    assert.equal(accepted.task.status, 'completed');
    assert.equal(
      store.organization
        .roleMemories('default', roleId, 20)
        .some((memory) => memory.kind === 'submission' && memory.scheduleId === schedule.id),
      true,
    );
    assert.equal(
      store.organization
        .roleMemories('default', roleId, 20)
        .some((memory) => memory.kind === 'delivery' && memory.scheduleId === schedule.id),
      true,
    );

    await restartedRuns.shutdown();
    restartedRuns = undefined;
    store.close();
    store = new Store(database);
    const reloadedSociety = new SocietyService({ store });
    const persistedLife = reloadedSociety.roleLife('default', roleId);
    assert.deepEqual(store.organization.getSocietySchedule(schedule.id, 'default')?.selection, schedule.selection);
    assert.equal(
      persistedLife.memories.some((memory) => memory.kind === 'submission' && memory.scheduleId === schedule.id),
      true,
    );
    assert.equal(
      persistedLife.memories.some((memory) => memory.kind === 'delivery' && memory.scheduleId === schedule.id),
      true,
    );
  } finally {
    finishResumed.resolve();
    await restartedRuns?.shutdown();
    await firstRuns?.shutdown();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
