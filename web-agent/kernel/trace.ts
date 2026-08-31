/**
 * kernel/trace.ts —— 轨迹观测（黑箱解药）
 * append-only 结构：TraceSession(traceId) → Turn → Step。
 * 三态输出：① SSE 实时推送（trace.step 事件）② JSONL 审计落盘（异步批量）③ 内存环形缓冲。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from './bus';
import type { StepHandle, TraceStats, TraceStep, TraceStepInit } from './types';

const RING_CAPACITY = 1000;
/** 批量落盘：队列达到该条数立即 flush */
const FLUSH_BATCH = 100;
/** 定时落盘：队列非空时最迟该间隔落一次盘 */
const FLUSH_INTERVAL_MS = 2_000;

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

  constructor(private bus: EventBus, tracesDir: string) {
    this.tracesDir = tracesDir;
    try { mkdirSync(tracesDir, { recursive: true }); } catch { /* 忽略 */ }
    process.on('exit', this.exitFlush);
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
  }

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
