/** Task accounting and physical child execution capacity. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TASK_PROFILE_MAX = 100;
const SUBAGENT_MAX_ACTIVE_DEFAULT = 16;

export interface TaskRecord {
  type: string;
  turns: number;
  cost: number;
  failed: boolean;
  ts: number;
}

export interface BudgetReservation {
  shares: number[];
  reserved: number;
  settled: number;
  remaining: number;
  settle(index: number, actual: number): { reserved: number; actual: number; refund: number };
}

/** 并行预算的原子预留账本：先锁定份额，完成后按实际消耗结算并释放未用部分。 */
export function reserveBudget(total: number, count: number): BudgetReservation {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const n = Math.max(0, Math.floor(count));
  const each = n ? Math.floor((safeTotal / n) * 1e12) / 1e12 : 0;
  const shares = Array.from({ length: n }, () => each);
  if (n) shares[n - 1] += safeTotal - each * n;
  const settled = new Array(n).fill(false) as boolean[];
  let settledTotal = 0;
  let remaining = safeTotal;
  return {
    shares,
    reserved: safeTotal,
    get settled() {
      return settledTotal;
    },
    get remaining() {
      return remaining;
    },
    settle(index, actual) {
      if (index < 0 || index >= n || settled[index]) return { reserved: 0, actual: 0, refund: 0 };
      settled[index] = true;
      const reserved = shares[index];
      const used = Number.isFinite(actual) && actual > 0 ? actual : 0;
      const refund = Math.max(0, reserved - used);
      settledTotal += used;
      remaining = Math.max(0, remaining - used);
      return { reserved, actual: used, refund };
    },
  };
}

export class Budget {
  private activeSubagents = 0;
  private tasks: TaskRecord[] = [];
  /** 任务画像落盘路径（不传 = 纯内存，重启清零） */
  private persistFile = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(_legacyMaxTotalCalls?: number, persistFile?: string) {
    if (persistFile) {
      this.persistFile = persistFile;
      try {
        const raw = JSON.parse(readFileSync(persistFile, 'utf-8')) as { tasks?: TaskRecord[] };
        if (Array.isArray(raw.tasks)) this.tasks = raw.tasks.slice(-TASK_PROFILE_MAX);
      } catch {
        /* 无历史画像：首次启动或文件损坏，忽略 */
      }
    }
  }

  /** 防抖落盘（2s）：高频 recordTask 不逐条写盘 */
  private scheduleSave(): void {
    if (!this.persistFile) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.persistFile), { recursive: true });
        writeFileSync(this.persistFile, JSON.stringify({ version: 1, tasks: this.tasks }), 'utf-8');
      } catch {
        /* 写盘失败不影响对话主流程 */
      }
    }, 2000);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  /** Compatibility entry point: delegation is bounded by execution slots, never a time-window quota. */
  consumeSubagentQuota(_sessionId: string): { allowed: boolean; remaining: number; refund?: () => void } {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, refund() {} };
  }

  /** 跨 run_subagent、run_review 和 run_parallel 共享的进程级活动子任务上限。
   *  这是独立的活动并发边界，与窗口调用配额互不占用容量。 */
  reserveSubagentSlots(count: number): (() => void) | undefined {
    if (!Number.isInteger(count) || count < 1 || this.activeSubagents + count > SUBAGENT_MAX_ACTIVE_DEFAULT) return undefined;
    this.activeSubagents += count;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSubagents -= count;
    };
  }

  activeSubagentCount(): number {
    return this.activeSubagents;
  }

  subagentQuota(): { allowed: boolean; remaining: number; reason?: string } {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
  }

  consumeSubagent(): void {}

  /** 记录一次任务完成（任务画像：类型/轮数/成本/成败） */
  recordTask(record: TaskRecord): void {
    this.tasks.push(record);
    if (this.tasks.length > TASK_PROFILE_MAX) this.tasks.splice(0, this.tasks.length - TASK_PROFILE_MAX);
    this.scheduleSave();
  }

  /** 任务画像：按类型聚合（次数/平均轮数/平均成本/失败率） */
  taskProfile(): { type: string; count: number; avgTurns: number; avgCost: number; failRate: number }[] {
    const byType = new Map<string, TaskRecord[]>();
    for (const t of this.tasks) {
      const arr = byType.get(t.type) ?? [];
      arr.push(t);
      byType.set(t.type, arr);
    }
    return [...byType.entries()]
      .map(([type, list]) => ({
        type,
        count: list.length,
        avgTurns: Math.round((list.reduce((s, t) => s + t.turns, 0) / list.length) * 10) / 10,
        avgCost: Math.round((list.reduce((s, t) => s + t.cost, 0) / list.length) * 100000) / 100000,
        failRate: Math.round((list.filter((t) => t.failed).length / list.length) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  }
}

/** Compatibility helper: task labels never alter the configured reasoning allowance. */
export function reasoningBudgetFor(_taskType: string, base: number): number {
  return base;
}

/** 任务类型分类：按最后 user 消息的关键词（harness 视角的任务画像） */
export function classifyTask(userText: string): string {
  const t = userText.slice(0, 80);
  if (/代码|bug|修复|重构|函数|实现|测试|报错|error/i.test(t)) return '代码';
  if (/文件|目录|读取|写入|删除|查看.*(文件|目录)|工作区/i.test(t)) return '文件操作';
  // Labels are descriptive telemetry only.
  if (/搜索|查一下|找一下|资料|信息|新闻|文献|综述|检索式|查新/i.test(t)) return '检索';
  if (/周报|总结|报告|文档|说明|计划|方案|论文|投稿|摘要|审稿|参考文献/i.test(t)) return '写作';
  if (/介绍|是什么|怎么|为什么|解释/i.test(t)) return '问答';
  return '其他';
}
