/**
 * core/chat/approvals.ts —— 审批共享注册表
 * 子代理/并行任务各自创建独立 AgentRunner。若审批注册在 runner 实例私有 Map，
 * 服务端 /api/approvals/:id 只能查到主 runner 的条目——子代理审批静默挂起直到超时。
 * 全部 runner 共享同一 board：审批 ID 为全局唯一 UUID，任意 runner 注册、
 * 任意入口批准——审批可达性不再依赖"审批由哪个 runner 产生"。
 */

/** 审批等待超时（毫秒）：10 分钟未响应自动拒绝 */
export const APPROVAL_TIMEOUT = 10 * 60 * 1000;

export interface ApprovalInfo {
  name: string;
  summary: string;
  args?: unknown;
}

interface ApprovalRecord {
  resolve: (approved: boolean) => void;
  timer?: NodeJS.Timeout;
  info: ApprovalInfo;
}

export class ApprovalBoard {
  private map = new Map<string, ApprovalRecord>();

  constructor(private timeoutMs: number = APPROVAL_TIMEOUT) {}

  /** 注册审批：登记即启动超时计时（到时自动拒绝，resolve(false)） */
  register(id: string, info: ApprovalInfo, resolve: (approved: boolean) => void): void {
    const timer = setTimeout(() => {
      if (this.map.delete(id)) resolve(false);
    }, this.timeoutMs);
    timer.unref?.();
    this.map.set(id, { resolve, timer, info });
  }

  /** 批准/拒绝：命中返回 true 并解除挂起（含超时计时器清理）；未知 ID 返回 false */
  approve(id: string, approved: boolean): boolean {
    const rec = this.map.get(id);
    if (!rec) return false;
    this.map.delete(id);
    if (rec.timer) clearTimeout(rec.timer);
    rec.resolve(approved);
    return true;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): ApprovalInfo | undefined {
    return this.map.get(id)?.info;
  }

  list(): { id: string; info: ApprovalInfo }[] {
    return [...this.map.entries()].map(([id, rec]) => ({ id, info: rec.info }));
  }

  get size(): number {
    return this.map.size;
  }

  /** 清空全部挂起审批（拒绝）；测试隔离用独立 board 实例 */
  dispose(): void {
    for (const id of [...this.map.keys()]) this.approve(id, false);
  }
}

/** 进程级共享实例：主 runner 与子 runner 默认共用，服务端审批入口由此对子代理审批可达 */
export const globalApprovalBoard = new ApprovalBoard();