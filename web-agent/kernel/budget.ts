/**
 * kernel/budget.ts —— 认知资源管理（harness 管理，不是 LLM 自觉）
 * LLM 不应该"学会"节约——harness 直接强制执行：
 *  1. 重工具配额：如 run_subagent 在时间窗口内的调用上限（"简单问题不需要召唤 3 个子代理"由 harness 保证）
 *  2. 任务画像：记录最近任务的类型/轮数/成本/成败，为自适应策略提供数据（agent skill graph 的起点）
 * 进程内状态（重启清零）——跨重启的持久策略数据后续可落盘。
 */

const TASK_PROFILE_MAX = 100;
const SUBAGENT_WINDOW_MS = 10 * 60_000;
const SUBAGENT_MAX_CALLS_PER_SESSION = 3;   // per-session 池：每会话窗口内上限
const SUBAGENT_MAX_CALLS_TOTAL_DEFAULT = 8; // 进程级总上限默认值（可经构造参数配置）

export interface TaskRecord {
  type: string;
  turns: number;
  cost: number;
  failed: boolean;
  ts: number;
}

export class Budget {
  /** per-session 池：sessionId → 窗口内调用记录（每会话独立计数，防单会话饿死全局） */
  private sessionCalls = new Map<string, { ts: number }[]>();
  /** 进程级总池：全部会话合计的窗口内调用记录 */
  private totalCalls: { ts: number }[] = [];
  private tasks: TaskRecord[] = [];

  constructor(private maxTotalCalls: number = SUBAGENT_MAX_CALLS_TOTAL_DEFAULT) {}

  private inWindow(calls: { ts: number }[]): { ts: number }[] {
    const now = Date.now();
    return calls.filter((c) => now - c.ts < SUBAGENT_WINDOW_MS);
  }

  /**
   * 原子配额消耗（check-and-consume 一步完成，消除 TOCTOU）：
   * 旧 API「先 subagentQuota() 检查、后 consumeSubagent() 记账」在两次调用之间
   * 可能有并发调用穿插，导致窗口内超额。本方法检查通过即记账，同一调用内完成。
   *  双层配额：per-session（默认 3 次/10 分钟）+ 进程级总上限（默认 8，构造可配）。
   */
  consumeSubagentQuota(sessionId: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    this.totalCalls = this.totalCalls.filter((c) => now - c.ts < SUBAGENT_WINDOW_MS);
    const sess = this.sessionCalls.get(sessionId)?.filter((c) => now - c.ts < SUBAGENT_WINDOW_MS) ?? [];
    const sessRemaining = SUBAGENT_MAX_CALLS_PER_SESSION - sess.length;
    const totalRemaining = this.maxTotalCalls - this.totalCalls.length;
    if (sessRemaining <= 0 || totalRemaining <= 0) {
      return { allowed: false, remaining: 0 };
    }
    // 检查通过，立即记账（原子完成）
    sess.push({ ts: now });
    this.sessionCalls.set(sessionId, sess);
    this.totalCalls.push({ ts: now });
    return { allowed: true, remaining: Math.min(sessRemaining, totalRemaining) - 1 };
  }

  /** 重工具配额检查（旧 API，保留兼容；仅反映进程级池，新调用方请用 consumeSubagentQuota） */
  subagentQuota(): { allowed: boolean; remaining: number; reason?: string } {
    this.totalCalls = this.inWindow(this.totalCalls);
    const remaining = this.maxTotalCalls - this.totalCalls.length;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        reason: `子代理配额已用尽（${SUBAGENT_WINDOW_MS / 60_000} 分钟内进程级最多 ${this.maxTotalCalls} 次）。harness 在管理认知资源：简单任务请直接执行；确需更多子代理请稍后再试。`,
      };
    }
    return { allowed: true, remaining };
  }

  /** 记录一次子代理调用（旧 API 的配额消耗；新调用方用 consumeSubagentQuota 一步完成） */
  consumeSubagent(): void {
    this.totalCalls.push({ ts: Date.now() });
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

/**
 * 第一性原理分配思考预算：认知资源按任务本质分配，而非一刀切。
 * 本质决定需求：
 *  - 代码任务：多步推理、易错、需要验证——给足思考空间（×1.5）；
 *  - 文件操作/检索：观察驱动，思考只是行动的序曲——少想多做（×0.75）；
 *  - 写作：组织与取舍——中等预算（×1.0）；
 *  - 问答：已知信息直接答——思考是浪费（×0.5），超限即触发降级；
 *  - 其他：默认（×1.0）。
 */
export function reasoningBudgetFor(taskType: string, base: number): number {
  const factor = taskType === '代码' ? 1.5
    : taskType === '文件操作' || taskType === '检索' ? 0.75
    : taskType === '问答' ? 0.5
    : 1.0;
  return Math.round(base * factor);
}

/** 任务类型分类：按最后 user 消息的关键词（harness 视角的任务画像） */
export function classifyTask(userText: string): string {
  const t = userText.slice(0, 80);
  if (/代码|bug|修复|重构|函数|实现|测试|报错|error/i.test(t)) return '代码';
  if (/文件|目录|读取|写入|删除|查看.*(文件|目录)|工作区/i.test(t)) return '文件操作';
  // 学术场景：文献类任务归检索（便宜模型），写作类归写作——modelRouting 可按类目配路由
  if (/搜索|查一下|找一下|资料|信息|新闻|文献|综述|检索式|查新/i.test(t)) return '检索';
  if (/周报|总结|报告|文档|说明|计划|方案|论文|投稿|摘要|审稿|参考文献/i.test(t)) return '写作';
  if (/介绍|是什么|怎么|为什么|解释/i.test(t)) return '问答';
  return '其他';
}
