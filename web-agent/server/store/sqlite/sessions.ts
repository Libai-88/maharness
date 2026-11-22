/** server/store/sqlite/sessions.ts —— 会话与消息聚合根的 SQL（ADR 0007 / v4 C2） */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { LLMRole, Message, Session, ToolCall } from '../../../kernel/types';
import type { SessionPort } from '../ports';

export interface SessionRepoDeps {
  /** 删除前必须确认会话没有活动 Run（判定留在 Store，仓库不解释运行态） */
  assertIdle(sessionId: string): void;
}

export class SqliteSessionRepo implements SessionPort {
  constructor(
    private readonly db: Database.Database,
    private readonly deps: SessionRepoDeps,
  ) {}

  countSessions(tenantId = 'default'): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?').get(tenantId) as { n: number }).n;
  }

  listSessions(tenantId = 'default'): Session[] {
    // lastMsg/lastRole：只取 user/assistant 真正说出口的话（排除带 tool_calls 的过程轮与空正文）
    const rows = this.db
      .prepare(`SELECT s.id, s.title, s.model, s.provider, s.mode, s.plan_pending AS planPending, s.role, s.tenant_id AS tenantId,
                       s.archived, s.pinned, s.created_at AS createdAt, s.updated_at AS updatedAt,
                       (SELECT SUBSTR(m.content, 1, 120) FROM messages m
                         WHERE m.session_id = s.id AND m.role IN ('user','assistant')
                           AND m.content IS NOT NULL AND m.content <> ''
                           AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastMsg,
                       (SELECT m.role FROM messages m
                         WHERE m.session_id = s.id AND m.role IN ('user','assistant')
                           AND m.content IS NOT NULL AND m.content <> ''
                           AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastRole
                FROM sessions s WHERE s.tenant_id = ? ORDER BY s.pinned DESC, s.updated_at DESC`)
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      model: r.model as string,
      provider: (r.provider as string) ?? '',
      mode: (r.mode as string) ?? 'normal',
      planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
      tenantId: (r.tenantId as string) ?? 'default',
      archived: (r.archived as number) ?? 0,
      pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      lastMsg: (r.lastMsg as string) ?? '',
      lastRole: (r.lastRole as 'user' | 'assistant' | undefined) ?? undefined,
    }));
  }

  getSession(id: string, tenantId?: string): Session | undefined {
    const sql = `SELECT id, title, model, provider, mode, plan_pending AS planPending, role, tenant_id AS tenantId,
                        archived, pinned, created_at AS createdAt, updated_at AS updatedAt
                 FROM sessions WHERE id = ?${tenantId ? ' AND tenant_id = ?' : ''}`;
    const r = (tenantId ? this.db.prepare(sql).get(id, tenantId) : this.db.prepare(sql).get(id)) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      title: r.title as string,
      model: r.model as string,
      provider: (r.provider as string) ?? '',
      mode: (r.mode as string) ?? 'normal',
      planPending: (r.planPending as number) ?? 0,
      role: (r.role as string) || undefined,
      tenantId: (r.tenantId as string) ?? 'default',
      archived: (r.archived as number) ?? 0,
      pinned: (r.pinned as number) ?? 0,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
    };
  }

  createSession(model: string, provider = '', tenantId = 'default'): Session {
    const s: Session = {
      id: randomUUID(),
      title: '新会话',
      model,
      provider,
      mode: 'normal',
      planPending: 0,
      archived: 0,
      pinned: 0,
      tenantId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, model, provider, mode, plan_pending, archived, pinned, tenant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(s.id, s.title, s.model, s.provider, s.mode, s.planPending, s.archived, s.pinned, tenantId, s.createdAt, s.updatedAt);
    return s;
  }

  updateSession(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'model' | 'provider' | 'mode' | 'planPending' | 'role' | 'archived' | 'pinned'>>,
  ): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare(
        'UPDATE sessions SET title = ?, model = ?, provider = ?, mode = ?, plan_pending = ?, role = ?, archived = ?, pinned = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        patch.title ?? cur.title,
        patch.model ?? cur.model,
        patch.provider ?? cur.provider,
        patch.mode ?? cur.mode,
        patch.planPending ?? cur.planPending,
        // role 允许显式清空（'' = 交回主代理）：不能用 ??（空串是合法值）
        patch.role !== undefined ? patch.role : (cur.role ?? ''),
        patch.archived ?? cur.archived,
        patch.pinned ?? cur.pinned,
        Date.now(),
        id,
      );
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteSessions(ids: string[], tenantId?: string): number {
    if (ids.length === 0) return 0;
    const allowed = tenantId ? ids.filter((id) => !!this.getSession(id, tenantId)) : ids;
    if (allowed.length === 0) return 0;
    const delMsg = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const delCp = this.db.prepare('DELETE FROM agent_checkpoints WHERE session_id = ?');
    const delSess = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) this.deps.assertIdle(id);
      for (const id of list) {
        const runs = this.db.prepare('SELECT id FROM runs_v2 WHERE session_id=?').all(id) as { id: string }[];
        for (const run of runs) {
          for (const table of [
            'run_history_v2',
            'run_model_inputs_v2',
            'run_tool_calls_v2',
            'run_events_v2',
            'run_checkpoints_v2',
            'run_messages_v2',
            'run_materials_v1',
          ])
            this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
          this.db.prepare('DELETE FROM run_budget_reservations_v2 WHERE run_id=? OR parent_id=?').run(run.id, run.id);
          this.db.prepare('DELETE FROM agent_tool_effects WHERE run_id=?').run(run.id);
        }
        this.db.prepare('DELETE FROM runs_v2 WHERE session_id=?').run(id);
        delMsg.run(id);
        delCp.run(id);
        delSess.run(id);
      }
    });
    tx(allowed);
    return allowed.length;
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      // rowid 次排序：同毫秒消息顺序固定，保证历史字节一致（L3 前缀缓存依赖前缀稳定）
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as LLMRole,
      content: r.content as string | null,
      reasoning: (r.reasoning as string | null) ?? undefined,
      toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls as string) as ToolCall[]) : undefined,
      toolCallId: (r.tool_call_id as string) ?? undefined,
      tokensIn: r.tokens_in as number,
      tokensOut: r.tokens_out as number,
      cost: r.cost as number,
      traceId: (r.trace_id as string) ?? undefined,
      taskVerification: r.task_verification ? (JSON.parse(r.task_verification as string) as Message['taskVerification']) : undefined,
      createdAt: r.created_at as number,
    }));
  }

  addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
    const msg: Message = { ...m, id: randomUUID(), createdAt: Date.now() };
    this.db
      .prepare(`INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tokens_in, tokens_out, cost, trace_id, task_verification, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.reasoning ?? null,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.tokensIn ?? 0,
        msg.tokensOut ?? 0,
        msg.cost ?? 0,
        msg.traceId ?? null,
        msg.taskVerification ? JSON.stringify(msg.taskVerification) : null,
        msg.createdAt,
      );
    return msg;
  }

  /** 消息结算回填：assistant 消息先入库保证历史字节一致，run 结束后再补 tokens/cost/reasoning */
  updateMessageStats(
    id: string,
    patch: { reasoning?: string; tokensIn?: number; tokensOut?: number; cost?: number; traceId?: string },
  ): void {
    this.db
      .prepare('UPDATE messages SET reasoning=?, tokens_in=?, tokens_out=?, cost=?, trace_id=? WHERE id=?')
      .run(patch.reasoning ?? null, patch.tokensIn ?? 0, patch.tokensOut ?? 0, patch.cost ?? 0, patch.traceId ?? null, id);
  }
}
