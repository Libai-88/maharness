/**
 * kernel/trace.ts —— 轨迹观测（黑箱解药）
 * append-only 结构：TraceSession(traceId) → Turn → Step。
 * 三态输出：① SSE 实时推送（trace.step 事件）② JSONL 审计落盘（异步批量）③ 内存环形缓冲。
 */
import { appendFileSync, closeSync, fstatSync, openSync, mkdirSync, readdirSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from './bus';
import type { StepHandle, TraceStats, TraceStep, TraceStepInit } from './types';

const RING_CAPACITY = 1000;
/** 批量落盘：队列达到该条数立即 flush */
const FLUSH_BATCH = 100;
/** 定时落盘：队列非空时最迟该间隔落一次盘 */
const FLUSH_INTERVAL_MS = 2_000;
/** 归档保留天数默认值（`trace.retainDays` 可覆盖；0 = 不清理） */
const RETAIN_DAYS_DEFAULT = 14;

/** 读文件末尾至多 maxLines 行（缺陷 C2）。
 *
 * 旧实现 `readFileSync(整个文件).split('\n').slice(-maxLines)`：20k 只是**解析**上限，
 * I/O 却是全文件同步读——归档按天只追加、无轮转，文件会随运行时间单调变大，
 * 于是 ring 未命中时的回退查询代价线性上升（实测单文件已 0.9MB，且当时 96%+ 是噪声）。
 * 这里从文件尾按块回读，只在凑够行数后解码那一段（主线程代价与文件大小解耦）。 */
function readTailLines(path: string, maxLines: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const CHUNK = 64 * 1024;
    let pos = size;
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    let collected = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines <= maxLines) {
      const take = Math.min(CHUNK, pos);
      pos -= take;
      readSync(fd, buf, 0, take, pos);
      const slice = buf.subarray(0, take);
      collected = Buffer.concat([slice, collected]);
      for (let i = 0; i < slice.length; i++) if (slice[i] === 0x0a) newlines++;
    }
    const lines = collected.toString('utf-8').split('\n');
    // 未读到文件头时，首行是被截断的半行 → 丢弃（宁可少一行，不返回坏 JSON）
    if (pos > 0) lines.shift();
    return lines.filter((l) => l.trim()).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 忽略 */ } }
  }
}

export class Trace {
  private ring: TraceStep[] = [];
  private tracesDir: string;
  /** 当前 JSONL 文件（按写入时日期惰性滚动：跨天后首条写入切新文件） */
  private jsonlPath = '';
  /** 落盘队列：步骤先入内存队列，定时/批量异步 flush（不再每步 appendFileSync 阻塞主循环） */
  private writeQueue: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** 落盘失败计数（stats 暴露）+ 首次失败告警一次（不再静默吞错也不再刷屏） */
  private writeFailures = 0;
  private warnedWriteFailure = false;
  /** step id：进程内单调计数器（防 32bit 随机截断碰撞串 span 树——旧 randomUUID().slice(0,8)
   *  生日碰撞下两条步骤同 id，parentId 下钻会挂错子树） */
  private stepSeq = 0;
  /** 进程随机前缀：区分多进程写同一 traces 目录时的 id 空间 */
  private readonly pidPrefix = `p${Math.random().toString(16).slice(2, 6)}`;
  private counter: TraceStats = {
    steps: 0, llmCalls: 0, toolCalls: 0, cacheHits: 0,
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0,
    writeFailures: 0,
  };
  /** 进程退出前兜底 flush（同步 appendFileSync 在 exit 钩子内可执行） */
  private readonly exitFlush = () => this.flush();

  constructor(private bus: EventBus, tracesDir: string, retainDays?: number) {
    this.tracesDir = tracesDir;
    if (typeof retainDays === 'number') this.retainDaysCfg = retainDays;
    try { mkdirSync(tracesDir, { recursive: true }); } catch { /* 忽略 */ }
    process.on('exit', this.exitFlush);
  }

  /** 归档保留天数（配置热更新入口；0 = 永不清理） */
  setRetainDays(days: number): void {
    this.retainDaysCfg = days;
  }

  /** 开始一个 Step，返回收尾句柄 */
  startStep(init: TraceStepInit): StepHandle {
    const step: TraceStep = {
      ...init,
      id: `${this.pidPrefix}-${++this.stepSeq}`,
      status: 'running',
      ts: Date.now(),
    };
    this.ring.push(step);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
    this.counter.steps++;
    if (init.type === 'llm_call') this.counter.llmCalls++;
    if (init.type === 'tool_call') this.counter.toolCalls++;
    if (init.type === 'cache_hit') this.counter.cacheHits++;
    // 实时推送"开始"帧：只发 settle 的话，面板里一个步骤要等它**做完**才出现——
    // 长工具（子代理/命令/联网抓取）执行期间轨迹面板是静止的，用户看不出"现在卡在哪一步"。
    // 前端按 step.id 做 upsert（running 帧先占位，settle 帧原地覆盖成终态）。
    this.bus.emit(EventBus.event('trace.step', { ...step }, step.traceId));
    return {
      id: step.id,
      finish: (extra) => this.settle(step, 'done', undefined, extra),
      fail: (error, extra) => this.settle(step, 'error', error, extra),
      cancel: () => this.settle(step, 'cancelled', undefined),
    };
  }

  private settle(step: TraceStep, status: TraceStep['status'], error?: string, extra?: Partial<TraceStep>) {
    step.status = status;
    step.endTs = Date.now();
    step.durationMs = step.endTs - step.ts;
    if (error) step.error = error;
    if (extra) Object.assign(step, extra);
    // 汇总统计
    this.counter.totalTokensIn += step.tokensIn ?? 0;
    this.counter.totalTokensOut += step.tokensOut ?? 0;
    this.counter.totalCost += step.cost ?? 0;
    // 落盘（append-only 审计）：入异步队列，批量/定时 flush
    this.enqueue(String(JSON.stringify(step)));
    // 实时推送
    this.bus.emit(EventBus.event('trace.step', step, step.traceId));
  }

  /** 入队并按需触发 flush（批量满即时刷；否则启动/复用定时器） */
  private enqueue(line: string): void {
    this.writeQueue.push(line);
    if (this.writeQueue.length >= FLUSH_BATCH) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_INTERVAL_MS);
      // 落盘节流定时器不钉住事件循环（缺陷 C2）：兜底已经有 process.on('exit') 与
      // Kernel.stop() 里的显式 flush()，脚本退出前不会丢队列。
      this.flushTimer.unref?.();
    }
  }

  /** 落盘当前队列（同步写但批量摊薄：一次 append 一整块）。
   *  失败：计数 + 首次告警一次（数据丢弃，审计尽力而为——不无限回队重试防内存膨胀）。 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.writeQueue.length) return;
    const chunk = this.writeQueue.join('\n') + '\n';
    this.writeQueue = [];
    // 惰性日期滚动：以写入时刻为准（旧实现构造时定死文件名，跨天进程会一直写昨天的文件）
    const today = new Date().toISOString().slice(0, 10);
    this.jsonlPath = this.jsonlPath || join(this.tracesDir, `${today}.jsonl`);
    const path = this.jsonlPath.endsWith(`${today}.jsonl`)
      ? this.jsonlPath
      : (this.jsonlPath = join(this.tracesDir, `${today}.jsonl`));
    try {
      appendFileSync(path, chunk);
    } catch (err) {
      this.writeFailures++;
      this.counter.writeFailures = this.writeFailures;
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        console.warn('[trace] JSONL 落盘失败（后续失败仅计数，见 stats().writeFailures）:', err instanceof Error ? err.message : String(err));
      }
    }
    // 跨天才尝试清理（每天至多一次 readdir/rmSync，不在热路径上）
    if (today !== this.lastPruneDay) {
      this.lastPruneDay = today;
      this.pruneOld();
    }
  }

  /** 归档保留期清理（缺陷 C2：此前按天只追加、无任何轮转/上限，磁盘单调增长）。
   *  `trace.retainDays` 可配（默认 14，0 = 永不清理），由 Kernel 注入并随配置热更新。
   *  文件名即日期（YYYY-MM-DD.jsonl），按日期字典序判定，不看 mtime——
   *  避免复制/迁移的文件被误删。 */
  pruneOld(): void {
    const retainDays = this.retainDaysCfg;
    if (!(retainDays > 0)) return;
    let files: string[];
    try {
      files = readdirSync(this.tracesDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    } catch { return; }
    // 不按「文件数 ≤ 保留天数」提前返回：文件少不代表都新（只有两个百年前的归档时
    // 同样必须清理）。判定只看日期，代价是一次 readdir，且每天至多跑一次。
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString().slice(0, 10);
    for (const f of files) {
      const day = f.slice(0, 10);
      if (day >= cutoff) continue;
      try {
        rmSync(join(this.tracesDir, f), { force: true });
      } catch (err) {
        console.warn(`[trace] 归档清理失败（${f}）:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 归档保留天数（`trace.retainDays`，由 Kernel 注入并随配置热更新；0 = 永不清理） */
  private retainDaysCfg = RETAIN_DAYS_DEFAULT;
  /** 上次清理所在日期（跨天才扫一次目录，不在热路径上） */
  private lastPruneDay = '';

  /** 查询轨迹：按 traceId / 步骤类型 / 名称 / 父步骤 过滤环形缓冲（最近 1000 条；可观察性的检索面）
   *  parentId：span 树下钻——查某步骤的全部子步骤（如 run_subagent 工具步骤下的子代理内部步骤） */
  query(traceId?: string, filter?: { type?: string; name?: string; parentId?: string; limit?: number }): TraceStep[] {
    let out = traceId ? this.ring.filter((s) => s.traceId === traceId) : [...this.ring];
    if (filter?.type) out = out.filter((s) => s.type === filter.type);
    if (filter?.name) out = out.filter((s) => s.name === filter.name);
    if (filter?.parentId) out = out.filter((s) => s.parentId === filter.parentId);
    if (filter?.limit && filter.limit > 0) out = out.slice(-filter.limit);
    return out;
  }

  /** 归档查询：ring 未命中时回退 JSONL 审计文件（跨重启/跨日期的历史可检索）。
   *  只扫最近 maxFiles 个日志文件、每文件最近 maxLines 行（本机工具量级足够）。 */
  queryArchive(traceId?: string, filter: { type?: string; name?: string; parentId?: string; limit?: number } = {},
    opts: { maxFiles?: number; maxLinesPerFile?: number } = {}): TraceStep[] {
    const maxFiles = opts.maxFiles ?? 14;
    const maxLines = opts.maxLinesPerFile ?? 20_000;
    let files: string[] = [];
    try {
      files = readdirSync(this.tracesDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-maxFiles);
    } catch { return []; }
    const out: TraceStep[] = [];
    for (const file of files) {
      try {
        const lines = readTailLines(join(this.tracesDir, file), maxLines);
        for (const line of lines) {
          let step: TraceStep;
          try {
            step = JSON.parse(line) as TraceStep;
          } catch { continue; }
          if (!step || typeof step !== 'object' || !step.id || typeof step.ts !== 'number') continue;
          if (traceId && step.traceId !== traceId) continue;
          if (filter.type && step.type !== filter.type) continue;
          if (filter.name && step.name !== filter.name) continue;
          if (filter.parentId && step.parentId !== filter.parentId) continue;
          out.push(step);
        }
      } catch { /* 单文件读取失败跳过 */ }
    }
    if (filter.limit && filter.limit > 0) return out.slice(-filter.limit);
    return out;
  }

  stats(): TraceStats {
    return { ...this.counter };
  }

  statsSnapshot(): TraceStats {
    return this.stats();
  }

  /** 释放进程级资源（移除 exit 监听器）。嵌入式多次 start/stop（测试/多实例）场景
   *  防 listener 累积——调用前应已 flush（Kernel.stop 顺序：flush 后 dispose） */
  dispose(): void {
    process.removeListener('exit', this.exitFlush);
  }
}
