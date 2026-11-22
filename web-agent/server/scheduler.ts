/** User-authorized scheduled recovery uses the durable task runtime. */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { Store } from './db';
import type { RunService } from './run-service';
import type { AutomationService } from './automations';
import type { SocietyService } from './services/society';
import type { ScheduleJob } from './schedule-store';

export type { ScheduleJob, ScheduleState } from './schedule-store';

interface ScheduleFile {
  version: 1;
  jobs: ScheduleJob[];
}

const MAX_JOBS = 200;

function loadLegacyJobs(file?: string): ScheduleJob[] {
  try {
    if (!file || !existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ScheduleFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs
      .filter((job) => job && typeof job.id === 'string' && typeof job.sessionId === 'string')
      .map((job) => ({
        ...job,
        tenantId: job.tenantId || 'default',
        state: ['pending', 'running', 'done', 'failed'].includes(job.state) ? job.state : 'failed',
      }));
  } catch {
    return [];
  }
}

function archiveLegacyJobs(file?: string): void {
  if (!file || !existsSync(file)) return;
  try {
    renameSync(file, `${file}.migrated`);
  } catch {
    /* The database import is idempotent; a stale source file is harmless. */
  }
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly running = new Set<string>();
  private service?: Pick<RunService, 'get' | 'resume'>;
  private automations?: AutomationService;
  private society?: Pick<SocietyService, 'tickAll'>;

  constructor(
    private readonly store: Store,
    private readonly opts: {
      file: string;
      intervalMs?: number;
      now?: () => number;
    },
  ) {
    const legacy = loadLegacyJobs(opts.file);
    for (const job of legacy) store.schedules.insert(job);
    if (legacy.length) archiveLegacyJobs(opts.file);
    store.schedules.failInterrupted(this.now(), '服务已重启，请核对任务后手动恢复');
  }
  attach(service: Pick<RunService, 'get' | 'resume'>): void {
    this.service = service;
  }
  attachAutomations(service: AutomationService): void {
    this.automations = service;
  }
  attachSociety(service: Pick<SocietyService, 'tickAll'>): void {
    this.society = service;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const interval = Math.max(250, this.opts.intervalMs ?? 5_000);
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, interval);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(tenantId?: string): ScheduleJob[] {
    return this.store.schedules.list(tenantId);
  }

  schedule(input: {
    sessionId: string;
    tenantId: string;
    dueAt: number;
    runId?: string;
    principalRole?: ScheduleJob['principalRole'];
  }): ScheduleJob {
    const now = this.now();
    const job: ScheduleJob = {
      id: `sch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      sessionId: input.sessionId,
      runId: input.runId,
      principalRole: input.principalRole,
      tenantId: input.tenantId,
      dueAt: Math.max(now, Math.trunc(input.dueAt)),
      state: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.schedules.insert(job);
    this.prune();
    return job;
  }

  cancel(id: string, tenantId?: string): boolean {
    const job = this.store.schedules.get(id, tenantId);
    if (!job || job.state === 'running' || job.state === 'done') return false;
    job.state = 'failed';
    job.lastError = 'cancelled';
    job.updatedAt = this.now();
    this.store.schedules.update(job);
    return true;
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    await this.automations?.tick(now);
    this.society?.tickAll();
    const due = this.store.schedules.list().filter((job) => job.state === 'pending' && job.dueAt <= now && !this.running.has(job.id));
    await Promise.all(due.map((job) => this.run(job)));
  }

  private async run(job: ScheduleJob): Promise<void> {
    this.running.add(job.id);
    job.state = 'running';
    job.updatedAt = this.now();
    this.store.schedules.update(job);
    try {
      if (!this.store.getSession(job.sessionId, job.tenantId)) {
        job.state = 'failed';
        job.lastError = '会话不存在或租户不匹配';
        return;
      }
      if (!job.runId) {
        job.state = 'failed';
        job.lastError = '旧 checkpoint 仅供查看，请确认已发生的操作后发起新任务';
        return;
      }
      if (!this.service) throw new Error('任务运行服务不可用');
      const run = this.service.get(job.runId, job.tenantId);
      if (run.sessionId !== job.sessionId || run.parentId) throw new Error('任务不属于该会话或为子任务');
      this.service.resume(run.id, job.tenantId, job.principalRole);
      job.state = 'done';
      job.lastError = undefined;
    } catch (error) {
      // Recovery can start side effects: an ambiguous failure must never be retried automatically.
      job.state = 'failed';
      job.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = this.now();
      this.running.delete(job.id);
      this.prune();
      this.store.schedules.update(job);
    }
  }

  private prune(): void {
    this.store.schedules.prune(MAX_JOBS);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
