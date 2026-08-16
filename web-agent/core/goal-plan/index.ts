/**
 * core/goal-plan/index.ts —— Goal / Plan 模式插件
 * 多步目标管理：LLM 自行拆解步骤 → create_plan 建立计划 → 逐项执行
 * 并 update_plan_progress 推进 → complete_goal 收尾。
 * 计划状态实时通过 plan.updated 事件推送（前端显示计划卡片）。
 * H14 会话隔离：计划按 sessionId 存取（Map + LRU，上限 50），多会话互不串扰。
 */
import type { Plugin, ToolContext } from '../../kernel/types';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface PlanState {
  objective: string;
  steps: { title: string; status: StepStatus; note?: string }[];
  current: number;
  completed: boolean;
  createdAt: number;
}

// H14 会话隔离：sessionId → 计划（Map 插入序即 LRU 序；上限 50，最旧淘汰）
const MAX_SESSIONS = 50;
const plans = new Map<string, PlanState>();

/** 无 sessionId 时的兜底键（单会话/旧执行器兼容） */
function sessionKey(tctx: ToolContext): string {
  return tctx.sessionId ?? '_default';
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
  if (plans.size > MAX_SESSIONS) {
    const oldest = plans.keys().next().value; // Map 首键 = 最久未触
    if (oldest !== undefined) plans.delete(oldest);
  }
}

export default {
  id: 'goal-plan',
  name: '目标计划模式',
  version: '0.1.0',
  onLoad(ctx) {
    const notify = (key: string) => {
      const p = plans.get(key);
      if (!p) return;
      // 事件 data 保持 PlanState 形状（前端契约不变），附加 sessionId 供多会话区分
      const data = key === '_default' ? { ...p } : { ...p, sessionId: key };
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
          '工作纪律：',
          '1. 先把目标还原为「已知 / 未知 / 必须观察」，再拆解为可执行步骤（用 create_plan 建立计划）；',
          '2. 每完成/开始/受阻一步，用 update_plan_progress 更新状态并说明理由；',
          '3. 步骤依赖信息缺口时先调工具补齐事实再继续，绝不编造；',
          '4. 执行中发现更优路径，调整步骤并说明理由（计划不是枷锁）；',
          '5. 全部完成时用 complete_goal 收尾并给出交付总结；',
          '6. 任务完成或超出规划职责时，用 handoff_to(role=main) 交回主代理。',
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
        content: [
          '目标计划模式规则：',
          '1. 用户提出包含多个步骤的目标时，先用 create_plan 拆解步骤并建立计划；',
          '2. 单步任务不要建计划，直接执行；',
          '3. 按计划逐项执行，每完成/开始/受阻一步，用 update_plan_progress 更新状态；',
          '4. 计划步骤需要调整时，用 update_plan_progress 记录说明；',
          '5. 全部完成或需要收尾总结时，用 complete_goal 标记完成并给出总结；',
          '6. 计划不是枷锁：执行中发现更优路径可以调整步骤说明理由。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'create_plan',
        risk: 'low',
        costHint: 'low',
        description: '为多步目标创建执行计划。参数 steps 为拆解后的步骤标题列表（由你根据目标拆解）。返回计划摘要。',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: '目标描述' },
            steps: { type: 'array', items: { type: 'string' }, description: '步骤标题列表（3-10 步）' },
          },
          required: ['objective', 'steps'],
        },
        async handler(args: { objective?: string; steps?: string[] }, tctx: ToolContext) {
          const objective = String(args.objective ?? '').trim();
          const steps = Array.isArray(args.steps)
            ? args.steps.map((s) => String(s).trim()).filter(Boolean)
            : [];
          if (!objective || steps.length === 0) return { ok: false, error: '需要 objective 与至少一个 steps' };
          const key = sessionKey(tctx);
          putPlan(key, {
            objective,
            steps: steps.map((title) => ({ title, status: 'pending' as StepStatus })),
            current: 0,
            completed: false,
            createdAt: Date.now(),
          });
          notify(key);
          return {
            ok: true,
            data: {
              objective,
              total: steps.length,
              steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
              hint: '按步骤执行，每步用 update_plan_progress 更新状态。',
            },
          };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'update_plan_progress',
        risk: 'low',
        costHint: 'low',
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
          const status = ['pending', 'in_progress', 'done', 'blocked'].includes(String(args.status)) ? String(args.status) as StepStatus : 'pending';
          st.status = status;
          if (args.note) st.note = String(args.note);
          if (status === 'in_progress') p.current = idx;
          putPlan(key, p); // 就地变更后刷新 LRU 近期性
          notify(key);
          return { ok: true, data: { step: idx + 1, title: st.title, status } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'complete_goal',
        risk: 'low',
        costHint: 'low',
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
          p.completed = true;
          if (args.summary) p.steps[p.steps.length - 1]!.note = String(args.summary);
          putPlan(key, p);
          notify(key);
          return { ok: true, data: { completed: true, objective: p.objective } };
        },
      },
    });

    ctx.logger.info('工具就绪: create_plan / update_plan_progress / complete_goal');
  },
} satisfies Plugin;
