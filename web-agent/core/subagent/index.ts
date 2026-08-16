/**
 * core/subagent/index.ts —— 子代理插件（LLM 第 6 项能力：sub-agents）
 * 底层逻辑：Agent 循环（决策→动作→观测）是独立的可组合单元。
 * 复杂任务可以由父代理拆分为多个子代理并行/分工执行，互不污染上下文，
 * 子代理独立产出结果后由父代理汇总审查——分担压力、互相审查。
 * 实现：复用 AgentRunner 开独立循环（独立 traceId/history/scratchpad），
 *       默认只读工具白名单（子代理不改世界，只侦查与计算），成本上限 maxTurns=6。
 */
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../chat/agent';
import type { Plugin, ProviderDef, ToolContext, ToolDef } from '../../kernel/types';

/** 只读白名单：子代理默认只能侦查世界，不能改变世界。
 *  M4 防递归：不含 run_subagent/run_parallel——子代理不得再开子代理
 *  （递归委派会造成不可控的成本与配额放大）。 */
const READ_ONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'web_search', 'list_skills', 'get_skill',
  'recall_facts', 'plugin_status',
]);

const SUB_SYSTEM_PROMPT = [
  '你是 maharness 的子代理（subagent），由主代理委派完成一个明确目标。',
  '工作纪律：',
  '1. 只做委派的目标，不扩散、不越权；完成后立即总结；',
  '2. 需要事实时先调用工具获取，绝不编造；',
  '3. 自查（互相审查机制）：总结前核对——目标是否达成？证据是否充分？输出是否完整？',
  '   发现不足就继续调用工具补足，直到可交付；',
  '4. 输出精炼：直接给出结论与关键证据，不要寒暄。',
].join('\n');

export default {
  id: 'subagent',
  name: '子代理',
  version: '0.1.0',
  onLoad(ctx) {
    // 反应性共效应（coeffect）：声明依赖 chat 服务——提供者激活/停用/换主时自动更新引用。
    // 依赖不可用 → 优雅降级（返回明确错误而非悬空引用）；提供者恢复 → 自动可用，无需重启。
    let chatSvc: { providers: ProviderDef[] } | undefined;
    const chatDep = ctx.inject('service:chat', (v) => {
      chatSvc = v as { providers: ProviderDef[] } | undefined;
    });
    chatSvc = chatDep.value as { providers: ProviderDef[] } | undefined;

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'run_subagent',
        risk: 'low',
        costHint: 'high',
        limits: '子代理最多 6 轮；成本 ≈ 多次 LLM 调用，简单问题不要召唤',
        output: '{answer, toolCalls, tokensIn, tokensOut, cost, traceId}',
        // 输出结构的机器校验（JSONSchema 子集）：声明后执行器对结果做运行时校验，
        // 不符即标注回填 + 入 Trace（structured output 的机器侧）
        outputSchema: {
          type: 'object',
          required: ['answer', 'toolCalls', 'tokensIn', 'tokensOut', 'cost', 'traceId'],
          properties: {
            answer: { type: 'string' },
            toolCalls: { type: 'integer', minimum: 0 },
            tokensIn: { type: 'integer', minimum: 0 },
            tokensOut: { type: 'integer', minimum: 0 },
            cost: { type: 'number', minimum: 0 },
            traceId: { type: 'string' },
          },
        },
        timeoutMs: 240_000, // 子代理内部多轮，独立超时 4 分钟
        description: '委派一个子代理独立完成目标（复用完整 Agent 循环，独立上下文）。' +
          '用于：任务可拆分为多个独立部分时并行分工；或需要独立视角交叉审查自己的产出。' +
          '默认只读工具（侦查/搜索/记忆）；tools="all" 可放开全部工具（含写操作，慎用）。',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: '子代理目标（一句话，明确可交付）' },
            tools: { type: 'string', enum: ['read', 'all'], description: '工具白名单：read=只读（默认），all=全部工具' },
          },
          required: ['objective'],
        },
        async handler(args: { objective?: string; tools?: string }, tctx: ToolContext) {
          const objective = String(args.objective ?? '').trim();
          if (!objective) return { ok: false, error: '缺少 objective' };
          if (objective.length > 800) return { ok: false, error: 'objective 过长（≤800 字符）' };

          // 认知资源管理（harness 强制，不是 LLM 自觉）：
          // M4 原子配额：consumeSubagentQuota 检查+消耗一步完成（并发调用不会超发）
          const quota = ctx.kernel.budget.consumeSubagentQuota(tctx.sessionId ?? '');
          if (!quota.allowed) {
            return { ok: false, error: `子代理配额已用尽（10 分钟窗口内限额，剩余 ${quota.remaining}）。harness 在管理认知资源：简单任务请直接执行；确需委派请稍后再试。` };
          }

          // 复用主代理的 provider 配置（chat 服务第一个启用的 provider；反应性注入保持新鲜）
          const provider = chatSvc?.providers?.[0];
          if (!provider) return { ok: false, error: 'chat 服务不可用（未配置 LLM Provider 或对话引擎未加载），无法委派子代理' };

          const allTools = ctx.kernel.plugins.capabilities('tool').map((c) => c.tool);
          const tools: ToolDef[] = args.tools === 'all'
            ? allTools
            : allTools.filter((t) => READ_ONLY_TOOLS.has(t.name));

          const runner = new AgentRunner(ctx.kernel, ctx.bus);
          const traceId = `sub-${randomUUID().slice(0, 8)}`;
          let answer = '';
          let usage = { input: 0, output: 0 };
          let cost = 0;
          let toolCalls = 0;
          let error: string | undefined;
          // H3 中断/预算透传：主循环 abort 即刻传导给子循环；主循环剩余预算（执行器在
          // ToolContext 上局部扩展的 remainingBudget 字段，kernel 契约尚未声明）作为
          // 子代理成本硬上限——子代理开销受主任务预算约束，不会绕开熔断
          const remainingBudget = (tctx as ToolContext & { remainingBudget?: number }).remainingBudget;
          try {
            for await (const ev of runner.run({
              provider,
              model: provider.defaultModel,
              messages: [{ role: 'user', content: objective }],
              systemPrompt: SUB_SYSTEM_PROMPT,
              tools,
              traceId,
              maxTurns: 6, // M4：与 limits 文案统一（最多 6 轮）
              parentStepId: tctx.stepId, // span 树：子代理全部步骤挂到 run_subagent 工具步骤下
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
          if (error) return { ok: false, error: `子代理失败: ${error}` };
          return {
            ok: true,
            data: {
              answer: answer.trim(),
              toolCalls,
              tokensIn: usage.input,
              tokensOut: usage.output,
              cost,
              traceId,
              // C5 成本回传：主循环执行器把它并入 totalCost/熔断核算（见 agent.ts C5 段）
              subagentCost: { cost, tokensIn: usage.input, tokensOut: usage.output },
            },
          };
        },
      },
    });

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'subagent-rules',
        name: '子代理使用规则',
        description: '引导 LLM 在合适的场景委派子代理',
        priority: 6,
        content: [
          '子代理使用规则：',
          '1. 任务包含多个相互独立的部分时，可委派 run_subagent 并行分工（一次一个，逐步委派）；',
          '2. 对重要结论可用子代理独立复核（新视角交叉审查）；',
          '3. 子代理只读世界（默认），需要写操作时自行完成或明确传 tools="all"；',
          '4. 子代理结果需要核对时，用 read_file 验证其引用的内容再采信。',
        ].join('\n'),
      },
    });

    ctx.logger.info('工具就绪: run_subagent（子代理：独立循环 + 只读白名单 + 自我审查）');
  },
} satisfies Plugin;
