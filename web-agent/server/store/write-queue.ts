/**
 * server/store/write-queue.ts —— 进程内单写者（ADR 0007 / v4 C2）
 *
 * better-sqlite3 是同步 API，同进程内本就不会真正并发；这里的价值不是"并发控制"，而是：
 * 1) 把"所有写事务串行"从隐式行为变成显式、可统计的事实（写次数、重入深度、重试次数、耗时）；
 * 2) SQLITE_BUSY（跨进程锁竞争，例如备份脚本、另一个实例）只重试一次，且只在事务未提交时重试；
 * 3) 重入（事务内再开事务）不再排队，避免自己把自己锁死。
 *
 * 只对 SQLITE_BUSY 重试：其它错误重试会重复执行已生效的副作用，比失败更危险。
 */
export interface WriteQueueStats {
  writes: number;
  retries: number;
  maxDepth: number;
  /** 最近一次写事务的墙钟耗时（毫秒） */
  lastMs: number;
  /** 累计墙钟耗时，用于观察"写入等待是否恶化" */
  totalMs: number;
  busy: boolean;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  return /database is locked|database table is locked/i.test(error instanceof Error ? error.message : '');
}

export class WriteQueue {
  private depth = 0;
  private writes = 0;
  private retries = 0;
  private maxDepth = 0;
  private lastMs = 0;
  private totalMs = 0;
  private busy = false;

  constructor(private readonly maxBusyRetries = 1) {}

  /** 在单写者内执行一段写事务；重入时直接执行（同一事务的延续）。 */
  run<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      this.maxDepth = Math.max(this.maxDepth, this.depth);
      try {
        return work();
      } finally {
        this.depth -= 1;
      }
    }
    this.depth = 1;
    this.writes += 1;
    this.maxDepth = Math.max(this.maxDepth, 1);
    const started = performance.now();
    let attempt = 0;
    this.busy = false;
    try {
      for (;;) {
        try {
          return work();
        } catch (error) {
          if (!isBusy(error) || attempt >= this.maxBusyRetries) throw error;
          attempt += 1;
          this.retries += 1;
          this.busy = true;
        }
      }
    } finally {
      this.lastMs = performance.now() - started;
      this.totalMs += this.lastMs;
      this.depth = 0;
    }
  }

  stats(): WriteQueueStats {
    return {
      writes: this.writes,
      retries: this.retries,
      maxDepth: this.maxDepth,
      lastMs: this.lastMs,
      totalMs: this.totalMs,
      busy: this.busy,
    };
  }
}

/** 进程默认的单写者：run 仓库与后续仓储共用同一份，统计才有意义。 */
export const defaultWriteQueue = new WriteQueue();
