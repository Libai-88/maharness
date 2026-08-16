/**
 * core/parallel/index.ts —— 多会话并行插件
 * 第一性原理：Agent 循环（决策→动作→观测）是独立的可组合单元——多个独立任务
 * 不需要排队等待，并发委派多个子代理循环并行执行（各自独立 traceId/history），
 * Promise.allSettled 全量汇总结论，父代理审查汇总。
 * 与 run_subagent 的分工：run_subagent = 单个委派（可穿插主线）；run_parallel =
 * 批量并行委派（多个独立子任务一次并发跑完，适合"拆分为 N 个独立部分"的任务）。
 */
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../chat/agent';
import type { Plugin, ProviderDef, ToolContext, ToolDef } from '../../kernel/types';

/** 只读白名单：并行子代理默认只能侦查世界，不能改变世界（与 subagent 一致） */
const READ_ONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'web_search', 'list_skills', 'get_skill',
  'recall_facts', 'plugin_status',
]);

/** 单次并行任务的最大子任务数（认知资源配额：并行不等于无限） */
const MAX_PARALLEL = 4;

const PARALLEL_SYSTEM_PROMPT = [
  '你是 maharness 的并行子代理（parallel subagent），由主代理在批量并行任务中委派，负责其中独立的一项。',
  '工作纪律：',
  '1. 只完成委派给你的这一项目标，不扩散、不越权；完成后立即给出结论；',
  '2. 需要事实时先调用工具获取，绝不编造；',
  '3. 输出精炼：直接给出结论与关键证据，不要寒暄。',
].join('\n');

export default {
  id: 'parallel',
  name: '多会话并行',
  version: '0.1.0',
  onLoad(ctx) {
    // 反应性共效应（coeffect）：声明依赖 chat 服务——提供者激活/停用/换主时自动更新引用。
    // 依赖不可用 → 优雅降级（返回明确错误而非悬空引用）；提供者恢复 → 自动可用，无需重启。
    let chatSvc: { providers: ProviderDef[] } | undefined;
    const chatDep = ctx.inject('service:chat', (v) => {
      chatSvc = v as { providers: ProviderDef[] } | undefined;
    });
    chatSvc = chatDep.value as { providers: ProviderDef[] } | undefined;

    // ---- 并行进度事件（前端实时观测：并行任务开始/结束） ----
    const emit = (phase: 'start' | 'done' | 'fail', taskId: string, objective: string, detail?: unknown) => {
      ctx.bus.emit({ type: 'parallel.progress', data: { phase, taskId, objective, detail }, ts: Date.now() });
    };

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'run_parallel',
        risk: 'low',
        costHint: 'high',
        limits: `一次最多 ${MAX_PARALLEL} 个并行子任务；受子代理配额约束；成本 ≈ 多次 LLM 调用，简单问题不要使用`,
        output: '{results: [{taskId, objective, ok, answer, toolCalls, tokensIn, tokensOut, cost, traceId, error?}], completed, failed}',
        timeoutMs: 240_000, // 并行子代理内部多轮，独立超时 4 分钟
        description: '将任务拆分为多个相互独立的部分，并发委派多个子代理并行执行（互不污染上下文，独立产出后统一汇总）。' +
          '用于：任务包含 N 个完全独立的子问题（如分别调研多个主题、分别分析多个文件）；' +
          '或需要多个独立视角并行产出再交叉审查。结果按委派顺序返回，失败项带 error 不阻塞其余。' +
          '注意：子任务之间不能有依赖（依赖关系请串行，用 run_subagent 逐个执行）。',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: '并行子任务列表（2-4 个，各自独立、互不依赖）',
              items: {
                type: 'object',
                properties: {
                  objective: { type: 'string', description: '该子任务的目标（一句话，明确可交付）' },
                  tools: { type: 'string', enum: ['read', 'all'], description: '工具白名单：read=只读（默认），all=全部工具' },
                },
                required: ['objective'],
              },
            },
          },
          required: ['tasks'],
        },
        async handler(args: { tasks?: { objective?: string; tools?: string }[] }, tctx: ToolContext) {
          const tasks = Array.isArray(args.tasks)
            ? args.tasks.map((t) => ({ objective: String(t.objective ?? '').trim(), tools: t.tools }))
            : [];
          if (tasks.length < 2) return { ok: false, error: '并行任务需要至少 2 个独立子任务（1 个请用 run_subagent）' };
          if (tasks.length > MAX_PARALLEL) return { ok: false, error: `并行子任务最多 ${MAX_PARALLEL} 个（收到 ${tasks.length}）` };
          for (const t of tasks) {
            if (!t.objective) return { ok: false, error: '存在空的 objective' };
            if (t.objective.length > 800) return { ok: false, error: 'objective 过长（≤800 字符）' };
          }

          // 认知资源管理：每个并行子任务消耗 1 次子代理配额（并行 = 多份认知资源同时运行）
          // M4 原子配额：consumeSubagentQuota 逐个消耗（检查+消耗原子完成，并发不超发）；
          // 不足即在申请时拒绝——不会出现"先检查后消耗"窗口内被并发抢空的超发
          for (let i = 0; i < tasks.length; i++) {
            const quota = ctx.kernel.budget.consumeSubagentQuota(tctx.sessionId ?? '');
            if (!quota.allowed) {
              return { ok: false, error: `子代理配额不足：第 ${i + 1}/${tasks.length} 个并行子任务申请配额被拒（剩余 ${quota.remaining}，10 分钟窗口内限额）。请减少并行数量或稍后再试。` };
            }
          }

          // 复用主代理的 provider 配置（chat 服务第一个启用的 provider；反应性注入保持新鲜）
          const provider = chatSvc?.providers?.[0];
          if (!provider) return { ok: false, error: 'chat 服务不可用（未配置 LLM Provider 或对话引擎未加载），无法并行委派' };

          const allTools = ctx.kernel.plugins.capabilities('tool').map((c) => c.tool);
          const toolsFor = (t: { tools?: string }): ToolDef[] => t.tools === 'all'
            ? allTools
            : allTools.filter((x) => READ_ONLY_TOOLS.has(x.name));

          // ---- 并发执行：每个子任务独立 AgentRunner 循环，Promise.allSettled 汇总 ----
          // H3 中断/预算透传：主循环 abort 与剩余预算传导给每个并行子循环
          //（remainingBudget 为执行器在 ToolContext 上的局部扩展字段，kernel 契约尚未声明）
          const remainingBudget = (tctx as ToolContext & { remainingBudget?: number }).remainingBudget;
          const results = await Promise.allSettled(tasks.map(async (t, i) => {
            const taskId = `par-${randomUUID().slice(0, 6)}`;
            const traceId = `par-${randomUUID().slice(0, 8)}`;
            emit('start', taskId, t.objective, { index: i });
            const runner = new AgentRunner(ctx.kernel, ctx.bus);
            let answer = '';
            let usage = { input: 0, output: 0 };
            let cost = 0;
            let toolCalls = 0;
            let error: string | undefined;
            try {
              for await (const ev of runner.run({
                provider,
                model: provider.defaultModel,
                messages: [{ role: 'user', content: t.objective }],
                systemPrompt: PARALLEL_SYSTEM_PROMPT,
                tools: toolsFor(t),
                traceId,
                maxTurns: 6, // M4：与子代理轮数上限统一（最多 6 轮）
                parentStepId: tctx.stepId, // span 树：并行子任务全部步骤挂到 run_parallel 工具步骤下
                signal: tctx.signal,
                costBudget: remainingBudget,
              })) {
                if (ev.type === 'delta') answer += ev.text;
                else if (ev.type === 'tool_result') toolCalls++;
                else if (ev.type === 'assistant_done') { usage = ev.usage; cost = ev.cost; }
                else if (ev.type === 'error') error = ev.error;
              }
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
            }
            if (error) {
              emit('fail', taskId, t.objective, { error });
              return {
                taskId, objective: t.objective, ok: false,
                error: `并行子任务失败: ${error}`, toolCalls, tokensIn: 0, tokensOut: 0, cost: 0, traceId,
              };
            }
            emit('done', taskId, t.objective, { toolCalls, tokensIn: usage.input, tokensOut: usage.output, cost });
            return {
              taskId, objective: t.objective, ok: true,
              answer: answer.trim(), toolCalls,
              tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
            };
          }));

          const completed = results.map((r) => r.status === 'fulfilled' ? r.value : {
            taskId: 'par-unknown', objective: '?', ok: false, error: '内部异常',
          });
          // C5 成本回传：聚合全部子任务的开销，主循环执行器并入 totalCost/熔断核算
          const subagentCost = {
            cost: completed.reduce((s, r) => s + ((r as { cost?: number }).cost ?? 0), 0),
            tokensIn: completed.reduce((s, r) => s + ((r as { tokensIn?: number }).tokensIn ?? 0), 0),
            tokensOut: completed.reduce((s, r) => s + ((r as { tokensOut?: number }).tokensOut ?? 0), 0),
          };
          return {
            ok: true,
            data: {
              results: completed,
              completed: completed.filter((r) => r.ok).length,
              failed: completed.filter((r) => !r.ok).length,
              summary: completed.map((r, i) => `${i + 1}. ${r.objective} → ${r.ok ? '完成' : '失败'}`).join('\n'),
              subagentCost,
            },
          };
        },
      },
    });

    // ---- L2 人设：引导 LLM 在合适的场景使用并行 ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'parallel-rules',
        name: '并行执行规则',
        description: '引导 LLM 对可分解的独立任务使用并行委派',
        priority: 6,
        content: [
          '并行执行规则：',
          '1. 任务包含多个相互独立的部分（如分别调研多个主题/分别分析多个文件/多路独立验证）时，优先用 run_parallel 一次并发委派，而不是逐个 run_subagent 排队；',
          '2. 并行子任务之间必须互不依赖（依赖关系请串行）；',
          '3. 一次并行 2-4 个，受配额限制；全部返回后统一汇总、交叉审查；',
          '4. 结果包含各自 traceId，需要核对时用 read_file 验证其引用的内容再采信。',
        ].join('\n'),
      },
    });

    ctx.logger.info('工具就绪: run_parallel（多会话并行：并发子代理 + 独立轨迹 + 统一汇总）');
  },
} satisfies Plugin;
