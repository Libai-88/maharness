/**
 * ui/src/hooks/useApprovals.ts —— 审批状态机（App.tsx 的第 33~34 号积木）
 *
 * 为什么抽出来：App.tsx 曾是 1000+ 行 / 27 个 useState 的单点，其中「审批」这一块
 * 内部自成闭环（挂起集合的三个来源 = 会话 SSE / 全局事件 / 清单兜底，加超时撤卡与回答），
 * 与流式渲染核心（rAF 合帧、retry 截断边界、断点续跑）互不相干。缺陷清单 F3 要求
 * 拆分 hooks；本 hook 是拆分收益最高又风险最低的一块——它不碰任何渲染热路径。
 *
 * 三个来源的合并口径（曾经各写一遍、行为不一致，这里收敛为一处）：
 *   1) 会话 SSE 的 approval_required —— 主执行器自己触发的审批；
 *   2) 全局事件的 approval.requested —— 子代理/并行的审批（父执行器阻塞在 handler 内，
 *      其事件无法经会话 SSE 流出），同一 id 会与来源 1 重复，需要**补字段而非整条替换**；
 *   3) GET /api/approvals —— 首屏/刷新后的兜底，用于把服务端仍在等的审批放回原位。
 *
 * 一次性凭据（A6-c）：随挂起一起下发、回答时回带。本 hook 只负责存（`ApprovalItem.approvalToken`）
 * 与传（respond 的第三参），判定逻辑全在服务端——前端不该有任何"能不能答"的本地规则。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { approvalsApi } from '../api';
import { sys } from '../voice';
import type { ApprovalItem } from '../types';

/** SSE / 清单给来的挂起字段（形状不一：SSE 可能缺 createdAt，清单必有 approvalToken） */
type PendingLike = Partial<Omit<ApprovalItem, 'id'>>;
/** 全局事件帧：内核事件约定字段名是 approvalId（不是 id），这里在入口统一改名 */
type BusPending = PendingLike & { approvalId: string };

export function useApprovals(opts: {
  /** 当前会话 id：用于决定「这条超时作废」的系统消息插到哪个窗口 */
  activeId: string | null;
  /** 往当前会话追加一条系统消息（超时作废时留一句人话） */
  pushSystemMessage: (id: string, text: string) => void;
}) {
  const { activeId, pushSystemMessage } = opts;
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);

  // 镜像 ref：respond 里同步读凭据（不进 useCallback 依赖，否则每次挂起/回答都会重建
  // 回调并破坏 ChatView 的 memo）——与 App.tsx 里 messagesRef 同一手法
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  // 镜像 ref：超时回调里判断"这条是不是当前会话的"（避免闭包捕获旧 activeId）
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // 已提示过"审批超时作废"的 id（否则每秒重复插系统消息）
  const expiredNotifiedRef = useRef(new Set<string>());

  /**
   * 合并一条挂起。已存在时**只补齐缺失字段**（凭据/时限），不整条替换——
   * 同一 id 会先后从三个来源到达（先 SSE 后清单、或反之），整条替换会把先到的
   * approvalToken 冲掉，导致回答时被判"凭据无效"。
   */
  const merge = useCallback((incoming: PendingLike & { id: string }) => {
    setApprovals((prev) => {
      const i = prev.findIndex((a) => a.id === incoming.id);
      if (i === -1) return [...prev, incoming as ApprovalItem];
      const cur = prev[i];
      const next = {
        ...cur,
        name: incoming.name ?? cur.name,
        summary: incoming.summary ?? cur.summary,
        sessionId: incoming.sessionId ?? cur.sessionId,
        createdAt: incoming.createdAt ?? cur.createdAt,
        expiresAt: incoming.expiresAt ?? cur.expiresAt,
        approvalToken: incoming.approvalToken ?? cur.approvalToken,
      };
      if (next === cur || (next.name === cur.name && next.summary === cur.summary
        && next.sessionId === cur.sessionId && next.createdAt === cur.createdAt
        && next.expiresAt === cur.expiresAt && next.approvalToken === cur.approvalToken)) return prev;
      const out = prev.slice();
      out[i] = next;
      return out;
    });
  }, []);

  /** 来源 1：会话 SSE */
  const onApprovalRequired = useCallback((id: string, name: string, summary: string, approvalToken?: string) => {
    if (!id) return;
    merge({ id, name, summary, approvalToken });
  }, [merge]);

  /** 来源 2：全局事件（子代理/并行）；同一 id 可能与来源 1 重复。
   *  事件帧的字段名是 approvalId（内核事件约定），内部统一用 id——在入口改名，
   *  而不是让调用方同时传两份 id。 */
  const onGlobalApproval = useCallback((d: BusPending) => {
    if (!d.approvalId) return;
    const { approvalId, ...rest } = d;
    merge({ ...rest, id: approvalId });
  }, [merge]);

  /** 来源 3：首屏/刷新/切会话后的兜底拉取（服务端仍是权威） */
  const reseed = useCallback(async () => {
    try {
      const r = await approvalsApi.list();
      const alive = new Set(r.pending.map((p) => p.id));
      setApprovals((prev) => {
        // 服务端已不认的（已批/已撤/超时）本地一并清掉，否则卡会永远停在界面上
        const kept = prev.filter((a) => alive.has(a.id));
        const byId = new Map(kept.map((a) => [a.id, a]));
        for (const p of r.pending) {
          const known = byId.get(p.id);
          byId.set(p.id, {
            id: p.id, name: p.name, summary: p.summary, sessionId: p.sessionId,
            createdAt: p.createdAt, expiresAt: p.expiresAt,
            // 本地没有凭据时才用清单补上（本地那份可能更新鲜）
            approvalToken: known?.approvalToken ?? p.approvalToken,
          });
        }
        return [...byId.values()];
      });
    } catch { /* 对话服务未就绪时忽略：不影响实时通道 */ }
  }, []);

  // 切会话/首屏重新拉取（挂起按会话过滤，服务端会返回该会话仍待回答的）
  useEffect(() => { void reseed(); }, [reseed, activeId]);

  // 到点自动撤卡：服务端 10 分钟后自动拒绝，本地到点把卡撤掉并留一句人话
  // （不让用户对着一张已经作废的卡继续点，然后纳闷为什么没反应）
  useEffect(() => {
    if (!approvals.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      const expired = approvals.filter((a) => a.expiresAt && a.expiresAt <= now);
      if (!expired.length) return;
      setApprovals((prev) => prev.filter((a) => !(a.expiresAt && a.expiresAt <= now)));
      for (const a of expired) {
        if (expiredNotifiedRef.current.has(a.id)) continue;
        expiredNotifiedRef.current.add(a.id);
        if (!a.sessionId || a.sessionId === activeIdRef.current) {
          pushSystemMessage(`ap-exp-${a.id}`, sys.approvalExpired(a.name));
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [approvals, pushSystemMessage]);

  /** 回答：带上该次挂起的一次性凭据（用过即作废，重放被服务端拒） */
  const respond = useCallback(async (id: string, approved: boolean) => {
    const token = approvalsRef.current.find((a) => a.id === id)?.approvalToken;
    try {
      await approvalsApi.respond(id, approved, token);
      toast.success(approved ? '已批准执行' : '已拒绝');
    } catch (err) {
      // 403 = 凭据错/重放，404 = 已过期：说清是哪一种，别只丢一句"无效"
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(/403|凭据/.test(msg) ? '这次审批的凭据已失效（它只能用一次），请等它重新挂起或让 agent 再请求一次' : msg);
    }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return { approvals, onApprovalRequired, onGlobalApproval, respond };
}