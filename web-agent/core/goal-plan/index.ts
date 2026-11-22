/**
 * core/goal-plan/index.ts —— Goal / Plan 模式插件
 * 多步目标管理：LLM 自行拆解步骤 → create_plan 建立计划 → 逐项执行
 * 并 update_plan_progress 推进 → complete_goal 收尾。
 * 计划状态实时通过 plan.updated 事件推送（前端显示计划卡片）。
 * H14 会话隔离：计划按 sessionId 存取（Map + LRU，上限 50），多会话互不串扰。
 */
import type { Plugin, ToolContext } from '../../kernel/plugin-sdk';
import { join } from 'node:path';
import { canTransition, loadPlans, savePlans, MAX_PLANS, type PlanState, type PlanWorkItem, type StepStatus } from './store';

export type { PlanState, PlanWorkItem, StepStatus } from './store';

// H14 会话隔离：sessionId → 计划（Map 插入序即 LRU 序；上限 50，最旧淘汰）
const plans = new Map<string, PlanState>();
let plansFile: string | null = null;

function persistPlans(): void {
  if (plansFile) savePlans(plansFile, plans);
}

/** 租户 + 会话键；无 sessionId 时使用 _default 兜底（旧执行器兼容）。 */
function sessionKey(tctx: { tenantId?: string; sessionId?: string }): string {
  return `${tctx.tenantId ?? 'default'}\u0000${tctx.sessionId ?? '_default'}`;
}

export function currentPlanForSession(tenantId = 'default', sessionId = '_default'): PlanState | undefined {
  return getPlan(`${tenantId}\u0000${sessionId}`);
}

function splitKey(key: string): { tenantId: string; sessionId: string } {
  const index = key.indexOf('\u0000');
  return index < 0 ? { tenantId: 'default', sessionId: key } : { tenantId: key.slice(0, index), sessionId: key.slice(index + 1) };
}

/** 读取并刷新 LRU 近期性 */
function getPlan(key: string): PlanState | undefined {
  const p = plans.get(key);
  if (p === undefined) return undefined;
  plans.delete(key);
  plans.set(key, p);
  return p;
}

/** 写入并执行 LRU 淘汰 */
function putPlan(key: string, p: PlanState): void {
  plans.delete(key);
  plans.set(key, p);
  if (plans.size > MAX_PLANS) {
    const oldest = plans.keys().next().value; // Map 首键 = 最久未触
    if (oldest !== undefined) plans.delete(oldest);
  }
  persistPlans();
}

export default {
  id: 'goal-plan',
  name: '目标计划模式',
  version: '0.1.0',
  onLoad(ctx) {
    plans.clear();
    plansFile = join(ctx.paths.data, 'plans.json');
    for (const [key, plan] of loadPlans(plansFile)) {
      const normalized = key.includes('\u0000') ? key : `default\u0000${key}`;
      plans.set(normalized, plan);
    }

    const notify = (key: string) => {
      const p = plans.get(key);
      if (!p) return;
      const { tenantId, sessionId } = splitKey(key);
      // 事件 data 保持 PlanState 形状（前端契约不变），附加会话与租户标识
      const data = { ...p, sessionId, tenantId };
      ctx.bus.emit({ type: 'plan.updated', data, ts: Date.now() });
    };

    // ---- 角色：计划专家（handoff 移交目标，跨插件协作演示——角色=插件） ----
    // 主代理判断任务需要严谨步骤编排时，handoff_to(role=planner) 移交，
    // 后续对话由计划专家的提示词纪律接管（热切换，无需重启）。
    ctx.register({
      kind: 'role',
      role: {
        id: 'planner',
        name: '计划专家',
        description: '多步任务规划专家：拆解目标、制定执行计划、跟踪进度。适合需要严谨步骤编排的复杂任务（重构/迁移/多阶段交付）。',
        systemPrompt: [
          '你是 maharness 的计划专家（planner），接管了任务的规划与推进。',
          '用 create_plan 建立可执行步骤，用 update_plan_progress 跟踪状态；发现更优路径可调整计划。',
          '全部完成时用 complete_goal 收尾；规划职责结束时用 handoff_to(role=main) 交回主代理。',
        ].join('\n'),
        tools: 'all',
      },
    });

    // L2 插件自述：引导 LLM 使用计划模式
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'goal-plan-rules',
        name: '目标计划模式规则',
        description: '引导 LLM 对多步目标使用计划管理',
        priority: 5,
        content: ['目标计划模式规则：', '多步目标可用 create_plan 跟踪步骤；单步任务直接执行；计划可随实际进展调整。'].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ['workspace.read', 'workspace.write'],
        name: 'create_plan',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object',
          required: ['objective', 'total', 'steps'],
          properties: {
            objective: { type: 'string' },
            total: { type: 'integer' },
            steps: { type: 'string' },
            workItems: { type: 'array' },
            hint: { type: 'string' },
          },
        },
        description:
          '为多步目标创建执行计划。可使用 steps 记录顺序，也可用 workItems 明确产物、验收、依赖、证据和 token 预估。结构化工作项不会自行授权团队。',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: '目标描述' },
            steps: { type: 'array', items: { type: 'string' }, description: '步骤标题列表（3-10 步）' },
            workItems: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                required: ['id', 'objective', 'expectedArtifacts', 'acceptance'],
                properties: {
                  id: { type: 'string' },
                  objective: { type: 'string' },
                  expectedArtifacts: { type: 'array', items: { type: 'string' } },
                  acceptance: { type: 'array', items: { type: 'string' } },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  evidenceRefs: { type: 'array', items: { type: 'string' } },
                  estimatedTokens: { type: 'integer', minimum: 0 },
                },
                additionalProperties: false,
              },
            },
          },
          required: ['objective'],
        },
        async handler(args: { objective?: string; steps?: string[]; workItems?: PlanWorkItem[] }, tctx: ToolContext) {
          const objective = String(args.objective ?? '').trim();
          const steps = Array.isArray(args.steps) ? args.steps.map((s) => String(s).trim()).filter(Boolean) : [];
          const workItems = Array.isArray(args.workItems)
            ? args.workItems.flatMap((item) => {
                if (!item || typeof item !== 'object') return [];
                const id = String(item.id ?? '').trim();
                const title = String(item.objective ?? '').trim();
                if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !title) return [];
                return [
                  {
                    id,
                    objective: title,
                    expectedArtifacts: Array.isArray(item.expectedArtifacts) ? item.expectedArtifacts.map(String).filter(Boolean) : [],
                    acceptance: Array.isArray(item.acceptance) ? item.acceptance.map(String).filter(Boolean) : [],
                    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String).filter(Boolean) : [],
                    evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(String).filter(Boolean) : [],
                    estimatedTokens: Math.max(0, Math.trunc(Number(item.estimatedTokens) || 0)),
                  },
                ];
              })
            : [];
          if (!objective || (!steps.length && !workItems.length))
            return { ok: false, error: '需要 objective 与至少一个 steps 或 workItems' };
          const titles = steps.length ? steps : workItems.map((item) => item.objective);
          if (titles.length > 10) return { ok: false, error: '计划最多 10 项' };
          const ids = new Set(workItems.map((item) => item.id));
          if (ids.size !== workItems.length || workItems.some((item) => item.dependsOn.some((id) => !ids.has(id))))
            return { ok: false, error: 'workItems 的 id 必须唯一，依赖必须引用已有工作项' };
          const key = sessionKey(tctx);
          putPlan(key, {
            objective,
            steps: titles.map((title) => ({ title, status: 'pending' as StepStatus })),
            ...(workItems.length ? { workItems } : {}),
            current: 0,
            completed: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          notify(key);
          return {
            ok: true,
            data: {
              objective,
              total: titles.length,
              steps: titles.map((s, i) => `${i + 1}. ${s}`).join('\n'),
              ...(workItems.length ? { workItems } : {}),
              hint: '按步骤执行，每步用 update_plan_progress 更新状态。',
            },
          };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ['workspace.read', 'workspace.write'],
        name: 'update_plan_progress',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object',
          required: ['step', 'title', 'status', 'current'],
          properties: { step: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string' }, current: { type: 'integer' } },
        },
        description: '更新计划的步骤状态：done（完成）/ in_progress（进行中）/ blocked（受阻）。可附说明。',
        parameters: {
          type: 'object',
          properties: {
            stepIndex: { type: 'number', description: '步骤序号（从 0 开始）' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: '新状态' },
            note: { type: 'string', description: '说明（完成摘要/受阻原因/调整理由）' },
          },
          required: ['stepIndex', 'status'],
        },
        async handler(args: { stepIndex?: number; status?: string; note?: string }, tctx: ToolContext) {
          const key = sessionKey(tctx);
          const p = getPlan(key);
          if (!p) return { ok: false, error: '还没有计划，请先 create_plan' };
          const idx = Number(args.stepIndex);
          const st = p.steps[idx];
          if (!st) return { ok: false, error: `步骤不存在: ${idx}` };
          const status = ['pending', 'in_progress', 'done', 'blocked'].includes(String(args.status))
            ? (String(args.status) as StepStatus)
            : 'pending';
          if (!canTransition(st.status, status)) {
            return { ok: false, error: `非法步骤状态迁移: ${st.status} → ${status}（步骤 ${idx + 1}）` };
          }
          st.status = status;
          if (args.note) st.note = String(args.note);
          if (status === 'blocked' && args.note) st.blockedReason = String(args.note);
          else if (status !== 'blocked') delete st.blockedReason;
          st.updatedAt = Date.now();
          p.completed = false;
          if (status === 'in_progress') p.current = idx;
          else if (status === 'done') {
            const next = p.steps.findIndex((step) => step.status !== 'done');
            p.current = next >= 0 ? next : p.steps.length - 1;
          }
          p.updatedAt = Date.now();
          putPlan(key, p); // 就地变更后刷新 LRU 近期性
          notify(key);
          return { ok: true, data: { step: idx + 1, title: st.title, status, current: p.current } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ['workspace.read', 'workspace.write'],
        name: 'complete_goal',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object',
          required: ['completed', 'objective'],
          properties: { completed: { type: 'boolean' }, objective: { type: 'string' } },
        },
        description: '标记目标计划完成，附最终总结。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '完成总结' },
          },
        },
        async handler(args: { summary?: string }, tctx: ToolContext) {
          const key = sessionKey(tctx);
          const p = getPlan(key);
          if (!p) return { ok: false, error: '还没有计划' };
          const unfinished = p.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.status !== 'done');
          if (unfinished.length) {
            return {
              ok: false,
              error: `还有 ${unfinished.length} 个步骤未完成：${unfinished
                .slice(0, 6)
                .map(({ step, index }) => `${index + 1}. ${step.title} (${step.status})`)
                .join('；')}${unfinished.length > 6 ? '；…' : ''}`,
            };
          }
          p.completed = true;
          p.updatedAt = Date.now();
          if (args.summary) p.steps[p.steps.length - 1]!.note = String(args.summary);
          putPlan(key, p);
          notify(key);
          return { ok: true, data: { completed: true, objective: p.objective } };
        },
      },
    });

    // ---- 计划查询端点：GET /api/plugins/goal-plan/plan?sessionId=xxx ----
    // 为什么必须有：计划只活在内存 Map 里、只经 plan.updated 事件推送——刷新页面后
    // 计划卡要等下一次事件（可能整场对话都不再发生）才回来，而 todo 插件是有板子可查的。
    // 计划是插件自己的状态，读取端点也就该由插件自己挂（与 todo 的 board 能力同构）。
    ctx.register({
      kind: 'api',
      api: {
        mount: 'plan',
        responses: {
          'GET /plan': { type: 'object', required: ['plan'], properties: { plan: { type: ['object', 'null'] } } },
        },
        router: (async (
          req: { method?: string; path?: string; query?: Record<string, unknown>; tenantId?: string },
          res: {
            json: (v: unknown) => void;
            status: (n: number) => { json: (v: unknown) => void };
          },
        ) => {
          const raw = (req.path ?? '/').replace(/\/+$/, '') || '/';
          if (req.method && req.method !== 'GET') return res.status(405).json({ error: '仅支持 GET' });
          if (raw !== '/' && raw !== '/plan') return res.status(404).json({ error: '未知路径' });
          const sessionId = String(req.query?.sessionId ?? '').trim();
          if (!sessionId) return res.json({ plan: null });
          const key = `${req.tenantId ?? 'default'}\u0000${sessionId}`;
          res.json({ plan: getPlan(key) ?? null });
        }) as never,
      },
    });

    ctx.logger.info('工具就绪: create_plan / update_plan_progress / complete_goal（查询端点 /api/plugins/goal-plan/plan?sessionId=）');
  },
} satisfies Plugin;
