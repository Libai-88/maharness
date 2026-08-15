/**
 * kernel/budget.ts —— 认知资源管理（harness 管理，不是 LLM 自觉）
 * LLM 不应该"学会"节约——harness 直接强制执行：
 *  1. 重工具配额：如 run_subagent 在时间窗口内的调用上限（"简单问题不需要召唤 3 个子代理"由 harness 保证）
 *  2. 任务画像：记录最近任务的类型/轮数/成本/成败，为自适应策略提供数据（agent skill graph 的起点）
 * 进程内状态（重启清零）——跨重启的持久策略数据后续可落盘。
 */

const TASK_PROFILE_MAX = 100;
const SUBAGENT_WINDOW_MS = 10 * 60_000;
const SUBAGENT_MAX_CALLS = 3;

export interface TaskRecord {
  type: string;
  turns: number;
  cost: number;
  failed: boolean;
  ts: number;
}

export class Budget {
  private subagentCalls: { ts: number }[] = [];
  private tasks: TaskRecord[] = [];

  /** 重工具配额检查：窗口内调用次数超限则拒绝（返回剩余配额或超限原因） */
  subagentQuota(): { allowed: boolean; remaining: number; reason?: string } {
    const now = Date.now();
    this.subagentCalls = this.subagentCalls.filter((c) => now - c.ts < SUBAGENT_WINDOW_MS);
    const remaining = SUBAGENT_MAX_CALLS - this.subagentCalls.length;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        reason: `子代理配额已用尽（${SUBAGENT_WINDOW_MS / 60_000} 分钟内最多 ${SUBAGENT_MAX_CALLS} 次）。harness 在管理认知资源：简单任务请直接执行；确需更多子代理请稍后再试。`,
      };
    }
    return { allowed: true, remaining };
  }

  /** 记录一次子代理调用（配额消耗） */
  consumeSubagent(): void {
    this.subagentCalls.push({ ts: Date.now() });
  }

  /** 记录一次任务完成（任务画像：类型/轮数/成本/成败） */
  recordTask(record: TaskRecord): void {
    this.tasks.push(record);
    if (this.tasks.length > TASK_PROFILE_MAX) this.tasks.splice(0, this.tasks.length - TASK_PROFILE_MAX);
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

/** 任务类型分类：按最后 user 消息的关键词（harness 视角的任务画像） */
export function classifyTask(userText: string): string {
  const t = userText.slice(0, 80);
  if (/代码|bug|修复|重构|函数|实现|测试|报错|error/i.test(t)) return '代码';
  if (/文件|目录|读取|写入|删除|查看.*(文件|目录)|工作区/i.test(t)) return '文件操作';
  if (/搜索|查一下|找一下|资料|信息|新闻/i.test(t)) return '检索';
  if (/周报|总结|报告|文档|说明|计划|方案/i.test(t)) return '写作';
  if (/介绍|是什么|怎么|为什么|解释/i.test(t)) return '问答';
  return '其他';
}
