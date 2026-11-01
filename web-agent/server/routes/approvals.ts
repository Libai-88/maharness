/**
 * server/routes/approvals.ts —— 审批（执行器级安全机制）
 *
 * 两条路径对称化（曾经的不对称是个真实的违和来源）：
 *   POST /api/approvals/:id  批准 / 拒绝
 *   GET  /api/approvals      挂起清单（含所属会话、"等了多久"、"何时自动作废"）
 * 主执行器的审批走会话 SSE，子代理/并行的审批走全局事件总线——两条都注册在同一块
 * 共享 ApprovalBoard 上，所以这里一份清单就能覆盖全部来源；前端首屏与刷新后据此
 * 把审批卡放回正确的聊天窗口，而不是"卡没了、服务端还在等，10 分钟后说你拒绝了它"。
 *
 * A6-1 收口（可代用户批准）：
 *  1) 变更类端点整体受 `x-maharness-token` 门管辖（server/index.ts 的 createApiTokenGuard，
 *     设了 MAHARNESS_API_TOKEN 就生效）——这是这道门真正的关闭方式。
 *  2) 本文件另加「一次性审批凭据」（approvalToken）：挂起清单被读取时，服务端为每条
 *     挂起审批铸一个随机凭据；POST 必须回带它，用过即作废（一次性的），重放一律 403。
 *     语义是「只有真的看见了这张审批卡的人，才能回答它」，把「盲猜/枚举 id 直接 POST」
 *     和「同一凭据重复使用」两条路收掉。
 *  **威胁模型边界（诚实版，别把它当鉴权）**：凭据本身是经 GET /api/approvals 下发的，
 *  本机任意进程也能调这个 GET 拿到它——所以 (2) 相对今天只是**抬高门槛**（从"知道 id 就行"
 *  变成"必须先列举、且凭据单次有效"），不能替代 (1)。要真正把代批路径关闭，需要
 *  MAHARNESS_API_TOKEN（进程外的显式授权），或把凭据改走「只有页面拿得到、本机进程拿不到」
 *  的通道（SSE 下发 + 前端回带，见下方 TODO）。
 *  默认行为：MAHARNESS_APPROVAL_TOKEN 未设 = 不强制凭据（既有前端不改动即可继续用）；
 *  但**请求只要带了凭据就必须正确**（不带不拦，带错必拒）——这样前端接线可以先于强制开关完成。
 */
import type { Express, Request } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getChatService, getRunner, type RouteDeps } from './shared';
import { auditAuthorizationDenial, auditAuthorizationGrant, decideCredentialAuthorization } from '../security-policy';

/** 一次性审批凭据的请求头名（也可以放 body 的 approvalToken 字段） */
export const APPROVAL_TOKEN_HEADER = 'x-maharness-approval-token';

/** 是否强制要求凭据：显式 env 开关，或 trusted/remote 部署模式（API-02）下自动强制 */
export function approvalTokenRequired(): boolean {
  if (process.env.MAHARNESS_APPROVAL_TOKEN === '1') return true;
  const mode = (process.env.MAHARNESS_MODE ?? 'local').trim().toLowerCase();
  return mode === 'trusted' || mode === 'remote';
}

interface IssuedToken {
  token: string;
  /** 铸出时的所属会话：凭据与「同一次挂起」绑定，会话不同视为不匹配 */
  sessionId?: string;
  createdAt: number;
  /** 与审批同生命周期（超时后不再接受） */
  expiresAt: number;
  /** 已使用（一次性）：保留一条墓碑记录，让重放得到明确 403 而不是「没带凭据」 */
  used: boolean;
}

/**
 * 审批凭据登记处（内存态，进程内单例）。
 * 不落库：审批本身就是 10 分钟内存挂起的东西，跨重启无意义（重启后审批已经没了）。
 */
export class ApprovalTokenRegistry {
  private map = new Map<string, IssuedToken>();

  /** 取（或铸）某条挂起审批的凭据；同一 id 重复列举返回同一枚，便于前端刷新 */
  issue(approvalId: string, sessionId: string | undefined, expiresAt: number): string {
    const now = Date.now();
    const cur = this.map.get(approvalId);
    if (cur && !cur.used && cur.expiresAt > now) return cur.token;
    const token = randomBytes(16).toString('hex');
    this.map.set(approvalId, { token, sessionId, createdAt: now, expiresAt, used: false });
    return token;
  }

  /**
   * 校验并消费凭据。返回三种结果，路由据此给不同状态码：
   *   ok      凭据匹配且未使用 → 当场作废（一次性）
   *   expired 凭据所属挂起已超时 → 让调用方继续走「已过期」分支
   *   invalid 凭据错误/已使用（重放）/会话不匹配
   */
  verify(approvalId: string, provided: string): 'ok' | 'invalid' | 'expired' {
    const rec = this.map.get(approvalId);
    if (!rec) return 'invalid'; // 没列举过就直接 POST：无凭据可依
    if (rec.used) return 'invalid'; // 重放
    if (rec.expiresAt <= Date.now()) return 'expired';
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(rec.token, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';
    rec.used = true;
    return 'ok';
  }

  /** 挂起集合变化后剪枝（防内存随会话数缓增：审批本身超时，墓碑也一并清） */
  prune(liveIds: Set<string>): void {
    const now = Date.now();
    for (const [id, rec] of this.map) {
      if (!liveIds.has(id) || rec.expiresAt <= now) this.map.delete(id);
    }
  }

  size(): number { return this.map.size; }
}

/** 进程级单例（与全局 ApprovalBoard 同一量级的生命周期） */
export const approvalTokens = new ApprovalTokenRegistry();

/** 从请求里掏凭据（body 字段优先，其次专用头） */
function providedApprovalToken(req: Request): string {
  const fromBody = (req.body as { approvalToken?: unknown } | undefined)?.approvalToken;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();
  const h = req.headers[APPROVAL_TOKEN_HEADER];
  const one = Array.isArray(h) ? h[0] : h;
  return typeof one === 'string' ? one.trim() : '';
}

let warnedLooseMode = false;

export function registerApprovalRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.get('/api/approvals', (req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json({ pending: [] });
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const now = Date.now();
    const list = chat.listApprovals(sessionId);
    const pending = list.map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      args: a.args,
      sessionId: a.sessionId,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      // 前端直接可用的两个读数（等服务端算不如给现成的）
      waitedMs: Math.max(0, now - a.createdAt),
      expiresInMs: Math.max(0, a.expiresAt - now),
      // A6-1：本次挂起的回答凭据（一次性）。前端接线 = 存下它并在 POST 里回带。
      approvalToken: approvalTokens.issue(a.id, a.sessionId, a.expiresAt),
    }));
    approvalTokens.prune(new Set(chat.listApprovals().map((a) => a.id)));
    res.json({ pending });
  });

  app.post('/api/approvals/:id', (req, res) => {
    const approved = req.body?.approved === true;
    const id = req.params.id;
    const provided = providedApprovalToken(req);
    // TODO(A6-1 闭环，需要 ui/ 与 SSE 侧配合，交由维护者拍板)：
    //   现在凭据只经 GET /api/approvals 下发。要让它成为「只有页面上那个人拿得到」的通道，
    //   需要在 approval_required / approval.requested 事件帧里一并下发 approvalToken
    //   （server/routes/chat.ts:362、server/routes/events.ts:53，均不在本次改动范围内），
    //   并让 ui/src/api.ts 的 approvalsApi.respond 回带它。完成后把 MAHARNESS_APPROVAL_TOKEN=1
    //   设为默认即可彻底关闭「本机进程代批」。
    const verdict = provided ? approvalTokens.verify(id, provided) : undefined;
    const decision = decideCredentialAuthorization({
      enabled: approvalTokenRequired(),
      supplied: !!provided,
      // 只有明确通过校验的凭据才有效；过期凭据必须和错值/重放一样拒绝。
      valid: verdict === 'ok',
    });
    if (!decision.allowed) {
      if (decision.reason === 'invalid') {
        auditAuthorizationDenial(kernel, {
          subject: 'anonymous', capability: 'approval:respond',
          object: '/api/approvals/:id', reason: 'approval-token-invalid',
        }, deps.store);
        return res.status(403).json({ error: '审批凭据无效或已使用（一次性凭据不可重放）' });
      }
      auditAuthorizationDenial(kernel, {
        subject: 'anonymous', capability: 'approval:respond',
        object: '/api/approvals/:id', reason: 'approval-token-required',
      }, deps.store);
      return res.status(401).json({
        error: `未授权：回答审批必须携带一次性凭据（先 GET /api/approvals 取 approvalToken，`
          + `回带于 ${APPROVAL_TOKEN_HEADER} 头或 body.approvalToken）`,
      });
    }
    if (provided && verdict === 'ok') auditAuthorizationGrant(kernel, {
      subject: 'approval-token', capability: 'approval:respond', object: '/api/approvals/:id',
    }, deps.store);
    // expired：交给挂起判定；已过期的审批会按既有语义被拒绝并清理。
    if (!provided && !approvalTokenRequired() && !warnedLooseMode) {
      warnedLooseMode = true;
      // 只提示一次：默认宽松模式是给既有前端留的兼容位，别让它变成「以为已经关闭了」
      console.warn('[approvals] 未启用 MAHARNESS_API_TOKEN/MAHARNESS_APPROVAL_TOKEN：'
        + '本机任意进程仍可回答审批（A6-1 未彻底关闭，详见 server/routes/approvals.ts 注释）');
    }
    // 审批走执行循环服务（service:runner）的共享审批板入口——与 chat 服务解耦：
    // 循环被别的插件接管时，审批语义（含子代理/并行的审批）仍由接管者负责兑现。
    const runner = getRunner(kernel);
    if (!runner) return res.status(500).json({ error: '执行循环服务未加载' });
    const ok = runner.approveApproval(id, approved);
    if (!ok) return res.status(404).json({ error: '这个请求已经过期了' });
    // 挂起条目已被回答：凭据墓碑随后由 prune 清掉（这里不立刻删，保留一次性语义）
    res.json({ ok: true, approved });
  });
}
