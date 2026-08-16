/**
 * core/chat/result-store.ts —— 工具结果存储（观察缓存）
 *
 * 对标：长工具输出（大文件/长列表）回填历史会让上下文膨胀，截断又让 LLM 无法重读。
 * maharness 最优解：**结果存起来、历史只放摘要与引用**——
 *  - 回填：超过阈值的结果存入结果存储（按会话隔离），history 只保留摘要 + 引用 id；
 *  - 重读：recall_tool_result 按 id 取回完整内容（零副作用——不重算、不重查）；
 *  - 生命周期：进程内（会话是进程内的，页面关了任务即止）；每会话 LRU 容量兜底。
 *
 * 与 L2 缓存的分工：L2 = 「同参数同状态的重算不花钱」（跨请求复用）；
 * 结果存储 = 「本会话已观察过的事实不占上下文」（本会话内可重读）。
 * 与截断告知的分工：v1 截断后 LLM 只能「用工具定向读取」（可能重算/副作用）；
 * v2 截断后 LLM 用 recall_tool_result 直接重读已观察的原文（纯读）。
 */
import type { ToolContext } from '../../kernel/types';

interface ResultEntry {
  content: string;
  ts: number;
}

const MAX_ENTRIES_PER_SESSION = 50; // LRU：每会话最多保留 50 条结果

export class ResultStore {
  private sessions = new Map<string, Map<string, ResultEntry>>();

  put(sessionKey: string, callId: string, content: string): void {
    let session = this.sessions.get(sessionKey);
    if (!session) { session = new Map(); this.sessions.set(sessionKey, session); }
    session.set(callId, { content, ts: Date.now() });
    // LRU 淘汰最旧条目（防内存膨胀）
    if (session.size > MAX_ENTRIES_PER_SESSION) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [k, e] of session) {
        if (e.ts < oldest) { oldest = e.ts; oldestKey = k; }
      }
      if (oldestKey !== undefined) session.delete(oldestKey);
    }
  }

  get(sessionKey: string, callId: string): string | undefined {
    return this.sessions.get(sessionKey)?.get(callId)?.content;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  size(sessionKey: string): number {
    return this.sessions.get(sessionKey)?.size ?? 0;
  }
}

/** chat 插件内单例：执行器回填与 recall_tool_result 工具共享同一存储 */
export const resultStore = new ResultStore();

/** 会话隔离键：优先会话 ID；无会话（子代理/独立循环）用 traceId 天然隔离 */
export function sessionKeyOf(ctx: Pick<ToolContext, 'sessionId' | 'traceId'>): string {
  return ctx.sessionId ?? ctx.traceId ?? 'global';
}
