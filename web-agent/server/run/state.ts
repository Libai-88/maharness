// server/run/state.ts —— Run 状态收敛的唯一真相（ADR 0008）
//
// 这里只做纯函数映射：不读库、不发事件、不看环境。状态谁都能改，但"改到什么"必须来自本文件，
// 否则排队/运行/等审批/中断/失败/取消之间的转移又会散落回执行器里靠读全文件推断。
import type { RunStatus } from '../../kernel/run';

/** 中止原因 → 终止状态：关停/用户暂停算中断，超时算失败，其余算取消。 */
export function statusAfterAbort(reason: unknown, closing: boolean): RunStatus {
  if (closing || reason === 'user_pause') return 'interrupted';
  if (reason === 'deadline_exceeded') return 'failed';
  return 'cancelled';
}

/** 循环自然结束（未被中止）时的终止状态：完成优先，不可恢复错误与轮数耗尽算失败。 */
export function terminalStatus(input: { completed: boolean; nonRecoverable: boolean; exhausted: boolean }): RunStatus {
  if (input.completed) return 'completed';
  if (input.nonRecoverable || input.exhausted) return 'failed';
  return 'interrupted';
}

/**
 * 单条事件对流内状态的影响：审批请求进 waiting_approval，其它事件把 waiting_approval 拉回 running。
 * 返回 undefined 表示状态不需要变。
 */
export function statusOnEvent(current: RunStatus, type: string): RunStatus | undefined {
  if (type === 'approval_required') return 'waiting_approval';
  if (current === 'waiting_approval') return 'running';
  return undefined;
}
