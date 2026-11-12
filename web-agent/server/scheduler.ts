/**
 * 会话到点续跑调度器。
 *
 * 只调度「已有 checkpoint 的会话 resume」，不注入任意新提示词——定时任务因此不会
 * 绕过租户/审批边界。持久化到 data/schedules.json；进程重启后恢复未完成作业。
 * 通过回环 HTTP 复用真实聊天路由，避免复制历史组装/Provider/工具执行逻辑。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './db';

export type ScheduleState = 'pending' | 'running' | 'done' | 'failed';

export interface ScheduleJob {
  id: string;
  sessionId: string;
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

  constructor(
    private readonly store: Store,
    private readonly opts: {
      file: string;
      baseUrl: string;
      token?: string;
      intervalMs?: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.jobs = loadJobs(opts.file);
  }

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

  schedule(input: { sessionId: string; tenantId: string; dueAt: number }): ScheduleJob {
    const now = this.now();
    const job: ScheduleJob = {
      id: `sch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      sessionId: input.sessionId,
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
      if (!this.store.loadCheckpoint(job.sessionId)) {
        job.state = 'failed';
        job.lastError = '会话没有可恢复的 checkpoint';
        return;
      }
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(`${this.opts.baseUrl}/api/sessions/${encodeURIComponent(job.sessionId)}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-maharness-tenant': job.tenantId,
          ...(this.opts.token ? { 'x-maharness-token': this.opts.token } : {}),
        },
        body: JSON.stringify({ resume: true }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      await res.text();
      if (res.ok) {
        job.state = 'done';
        job.lastError = undefined;
      } else if (res.status === 409) {
        this.retry(job, '会话仍在运行（409），稍后重试');
      } else if (res.status >= 500) {
        this.retry(job, `恢复失败（HTTP ${res.status}）`);
      } else {
        job.state = 'failed';
        job.lastError = `恢复被拒绝（HTTP ${res.status}）`;
      }
    } catch (error) {
      this.retry(job, error instanceof Error ? error.message : String(error));
    } finally {
      job.updatedAt = this.now();
      this.running.delete(job.id);
      this.prune();
      this.persist();
    }
  }

  private retry(job: ScheduleJob, reason: string): void {
    job.attempts++;
    job.lastError = reason;
    if (job.attempts >= 3) {
      job.state = 'failed';
      return;
    }
    job.state = 'pending';
    job.dueAt = this.now() + 30_000 * job.attempts;
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
