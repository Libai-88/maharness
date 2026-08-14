/**
 * core/goal-plan/index.ts —— Goal / Plan 模式插件
 * 多步目标管理：LLM 自行拆解步骤 → create_plan 建立计划 → 逐项执行
 * 并 update_plan_progress 推进 → complete_goal 收尾。
 * 计划状态实时通过 plan.updated 事件推送（前端显示计划卡片）。
 */
import type { Plugin } from '../../kernel/types';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface PlanState {
  objective: string;
  steps: { title: string; status: StepStatus; note?: string }[];
  current: number;
  completed: boolean;
  createdAt: number;
}

// 单用户本地工具：全局单计划（v1 够用）
const plan: { current: PlanState | null } = { current: null };

export default {
  id: 'goal-plan',
  name: '目标计划模式',
  version: '0.1.0',
  onLoad(ctx) {
    const notify = () => {
      ctx.bus.emit({ type: 'plan.updated', data: plan.current, ts: Date.now() });
    };

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
        description: '为多步目标创建执行计划。参数 steps 为拆解后的步骤标题列表（由你根据目标拆解）。返回计划摘要。',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: '目标描述' },
            steps: { type: 'array', items: { type: 'string' }, description: '步骤标题列表（3-10 步）' },
          },
          required: ['objective', 'steps'],
        },
        async handler(args: { objective?: string; steps?: string[] }) {
          const objective = String(args.objective ?? '').trim();
          const steps = Array.isArray(args.steps)
            ? args.steps.map((s) => String(s).trim()).filter(Boolean)
            : [];
          if (!objective || steps.length === 0) return { ok: false, error: '需要 objective 与至少一个 steps' };
          plan.current = {
            objective,
            steps: steps.map((title) => ({ title, status: 'pending' as StepStatus })),
            current: 0,
            completed: false,
            createdAt: Date.now(),
          };
          notify();
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
        async handler(args: { stepIndex?: number; status?: string; note?: string }) {
          if (!plan.current) return { ok: false, error: '还没有计划，请先 create_plan' };
          const idx = Number(args.stepIndex);
          const st = plan.current.steps[idx];
          if (!st) return { ok: false, error: `步骤不存在: ${idx}` };
          const status = ['pending', 'in_progress', 'done', 'blocked'].includes(String(args.status)) ? String(args.status) as StepStatus : 'pending';
          st.status = status;
          if (args.note) st.note = String(args.note);
          if (status === 'in_progress') plan.current.current = idx;
          notify();
          return { ok: true, data: { step: idx + 1, title: st.title, status } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'complete_goal',
        description: '标记目标计划完成，附最终总结。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '完成总结' },
          },
        },
        async handler(args: { summary?: string }) {
          if (!plan.current) return { ok: false, error: '还没有计划' };
          plan.current.completed = true;
          if (args.summary) plan.current.steps[plan.current.steps.length - 1]!.note = String(args.summary);
          notify();
          return { ok: true, data: { completed: true, objective: plan.current.objective } };
        },
      },
    });

    ctx.logger.info('工具就绪: create_plan / update_plan_progress / complete_goal');
  },
} satisfies Plugin;
