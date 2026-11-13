/** User-authorized scheduled recovery uses the durable task runtime. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './db';
import type { RunService } from './run-service';

export type ScheduleState = 'pending' | 'running' | 'done' | 'failed';

export interface ScheduleJob {
  id: string;
  sessionId: string;
  runId?: string;
  principalRole?: 'admin' | 'member' | 'readonly';
  tenantId: string;
  dueAt: number;
  state: ScheduleState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

interface ScheduleFile {
  version: 1;
  jobs: ScheduleJob[];
}

const MAX_JOBS = 200;

function loadJobs(file: string): ScheduleJob[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ScheduleFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.filter((job) => job && typeof job.id === 'string' && typeof job.sessionId === 'string');
  } catch { return []; }
}

function saveJobs(file: string, jobs: ScheduleJob[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs: jobs.slice(0, MAX_JOBS) }, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch { /* 调度持久化失败不阻断主服务；下一次 tick 仍会尝试内存态作业 */ }
}

export class Scheduler {
  private jobs: ScheduleJob[];
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly running = new Set<string>();
  private service?: Pick<RunService, 'get' | 'resume'>;

  constructor(
    private readonly store: Store,
    private readonly opts: {
      file: string;
      intervalMs?: number;
      now?: () => number;
    },
  ) {
    this.jobs = loadJobs(opts.file);
    for (const job of this.jobs) if (job.state === 'pending' || job.state === 'running') {
      job.state = 'failed'; job.lastError = '服务已重启，请核对任务后手动恢复';
    }
  }
  attach(service: Pick<RunService, 'get' | 'resume'>): void { this.service = service; }

  start(): void {
    if (this.timer || this.stopped) return;
    const interval = Math.max(250, this.opts.intervalMs ?? 5_000);
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, interval);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(tenantId?: string): ScheduleJob[] {
    return this.jobs
      .filter((job) => !tenantId || job.tenantId === tenantId)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  schedule(input: { sessionId: string; tenantId: string; dueAt: number; runId?: string; principalRole?: ScheduleJob['principalRole'] }): ScheduleJob {
    const now = this.now();
    const job: ScheduleJob = {
      id: `sch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      sessionId: input.sessionId,
      runId: input.runId, principalRole: input.principalRole,
      tenantId: input.tenantId,
      dueAt: Math.max(now, Math.trunc(input.dueAt)),
      state: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.unshift(job);
    this.prune();
    this.persist();
    return job;
  }

  cancel(id: string, tenantId?: string): boolean {
    const job = this.jobs.find((item) => item.id === id && (!tenantId || item.tenantId === tenantId));
    if (!job || job.state === 'running' || job.state === 'done') return false;
    job.state = 'failed';
    job.lastError = 'cancelled';
    job.updatedAt = this.now();
    this.persist();
    return true;
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = this.jobs.filter((job) => job.state === 'pending' && job.dueAt <= now && !this.running.has(job.id));
    await Promise.all(due.map((job) => this.run(job)));
  }

  private async run(job: ScheduleJob): Promise<void> {
    this.running.add(job.id);
    job.state = 'running';
    job.updatedAt = this.now();
    this.persist();
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
      job.state = 'done'; job.lastError = undefined;
    } catch (error) {
      // Recovery can start side effects: an ambiguous failure must never be retried automatically.
      job.state = 'failed'; job.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = this.now();
      this.running.delete(job.id);
      this.prune();
      this.persist();
    }
  }

  private prune(): void {
    if (this.jobs.length <= MAX_JOBS) return;
    const active = this.jobs.filter((job) => job.state === 'pending' || job.state === 'running');
    const finished = this.jobs
      .filter((job) => job.state === 'done' || job.state === 'failed')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, MAX_JOBS - active.length));
    this.jobs = [...active, ...finished];
  }

  private persist(): void {
    saveJobs(this.opts.file, this.jobs);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
