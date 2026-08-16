/**
 * server/client-tracker.ts —— 前端页面存活跟踪（「页面关闭 → 后端自动停止」的信号源）
 *
 * 第一性原理：页面关闭的本质 = 前端与后端唯一的常驻连接（/api/events SSE）断开。
 * 不能用 HTTP 轮询做信号——浏览器对后台标签页的 setInterval 节流（最小 60s），
 * 页面开着但被切走时轮询会停；而 SSE 连接由浏览器网络层维护，不受 JS 节流影响。
 *
 * 语义：
 *  - onConnect/onDisconnect：SSE 连接登记/注销（多标签页 = 多连接，任一存活即页面存活）
 *  - idleMs：所有连接断开后的空闲时长。>0 说明前端页面已彻底关闭
 *    （刷新页面/网络抖动时 EventSource 会自动重连，宽限期由调用方控制）
 */
export class ClientTracker {
  private clients = new Set<unknown>();
  private disconnectedAt: number | null = null;

  /** SSE 连接建立：登记并清零空闲计时（页面回来了） */
  onConnect(res: unknown): void {
    this.clients.add(res);
    this.disconnectedAt = null;
  }

  /** SSE 连接断开：注销；全部断开时记录断连时刻 */
  onDisconnect(res: unknown): void {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.disconnectedAt === null) {
      this.disconnectedAt = Date.now();
    }
  }

  /** 活跃连接数（多标签页叠加） */
  get size(): number {
    return this.clients.size;
  }

  /** 自「最后一个页面关闭」起的空闲毫秒数；仍有页面连接时为 0 */
  idleMs(): number {
    if (this.clients.size > 0 || this.disconnectedAt === null) return 0;
    return Date.now() - this.disconnectedAt;
  }

  /** 是否允许自动停止：无页面连接且无活跃 run（M3——「页面关了但任务还在跑」
   *  不是停止时机）。活跃 run 期间由 index 的自动停止 tick 调用 resetIdle()
   *  持续推迟基准，run 结束后重新起算宽限期；多标签页宽限期语义不变。 */
  resetIdle(): void {
    if (this.clients.size === 0) this.disconnectedAt = Date.now();
  }
}
