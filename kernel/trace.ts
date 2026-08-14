/**
 * kernel/trace.ts —— 轨迹观测（黑箱解药）
 * append-only 结构：TraceSession(traceId) → Turn → Step。
 * 三态输出：① SSE 实时推送（trace.step 事件）② JSONL 审计落盘 ③ 内存环形缓冲。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventBus } from './bus';
import type { StepHandle, TraceStats, TraceStep, TraceStepInit } from './types';

const RING_CAPACITY = 1000;

export class Trace {
  private ring: TraceStep[] = [];
  private jsonlPath: string;
  private counter: TraceStats = {
    steps: 0, llmCalls: 0, toolCalls: 0, cacheHits: 0,
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0,
  };

  constructor(private bus: EventBus, tracesDir: string) {
    this.jsonlPath = join(tracesDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    try { mkdirSync(tracesDir, { recursive: true }); } catch { /* 忽略 */ }
  }

  /** 开始一个 Step，返回收尾句柄 */
  startStep(init: TraceStepInit): StepHandle {
    const step: TraceStep = {
      ...init,
      id: randomUUID().slice(0, 8),
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
    // 落盘（append-only 审计）
    try { appendFileSync(this.jsonlPath, JSON.stringify(step) + '\n'); } catch { /* 忽略 */ }
    // 实时推送
    this.bus.emit(EventBus.event('trace.step', step, step.traceId));
  }

  /** 查询轨迹：按 traceId 过滤环形缓冲（最近 1000 条） */
  query(traceId?: string): TraceStep[] {
    return traceId ? this.ring.filter((s) => s.traceId === traceId) : [...this.ring];
  }

  stats(): TraceStats {
    return { ...this.counter };
  }

  statsSnapshot(): TraceStats {
    return this.stats();
  }
}
