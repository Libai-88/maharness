/**
 * core/parallel/index.ts —— 多会话并行插件
 * 第一性原理：Agent 循环（决策→动作→观测）是独立的可组合单元——多个独立任务
 * 不需要排队等待，并发委派多个子代理循环并行执行（各自独立 traceId/history），
 * Promise.allSettled 全量汇总结论，父代理审查汇总。
 * 与 run_subagent 的分工：run_subagent = 单个委派（可穿插主线）；run_parallel =
 * 批量并行委派（多个独立子任务一次并发跑完，适合"拆分为 N 个独立部分"的任务）。
 */
import { randomUUID } from 'node:crypto';
import { makeRunner } from '../../kernel/types';
import { reserveBudget } from '../../kernel/budget';
import type { Plugin, ProviderDef, ToolContext, ToolDef } from '../../kernel/types';

/** 只读白名单：并行子代理默认只能侦查世界，不能改变世界（与 subagent 一致） */
const READ_ONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'glob', 'grep', 'web_search', 'web_fetch',
  'list_skills', 'get_skill', 'get_skill_file', 'recall_facts', 'list_memory_blocks',
  'plugin_status', 'mcp_status', 'todo_list',
]);
/** 委派类工具永远不交给并行子代理，避免 tools:"all" 打开递归委派。 */
const DELEGATION_TOOLS = new Set(['run_subagent', 'run_parallel', 'run_review']);

/** 单次并行任务的最大子任务数（认知资源配额：并行不等于无限） */
const MAX_PARALLEL = 8;
const MAX_PARALLEL_ACTIVE = MAX_PARALLEL * 2;

export interface ParallelTaskResult {
  taskId: string;
  objective: string;
  ok: boolean;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  cancelled?: boolean;
  [key: string]: unknown;
}

export interface ParallelAggregate {
  results: ParallelTaskResult[];
  completed: number;
  failed: number;
  cancelled: number;
  status: 'completed' | 'partial' | 'failed';
  subagentCost: { cost: number; tokensIn: number; tokensOut: number };
}

export interface ParallelTaskSpec {
  plugins?: string[];
  id?: string;
  objective: string;
  tools?: string;
  dependsOn?: string[];
  publish?: boolean;
}

export interface NormalizedParallelTask {
  plugins?: string[];
  id: string;
  objective: string;
  tools?: string;
  dependsOn: string[];
  publish: boolean;
  index: number;
}

/** 工具层成功语义：编排请求本身可能正常返回，但全失败不能伪装成成功工具结果。 */
export function parallelToolSucceeded(aggregate: Pick<ParallelAggregate, 'status'>): boolean {
  return aggregate.status !== 'failed';
}

/** 校验任务标识与依赖，返回按原顺序归一化的任务；失败时给出可直接修正的中文原因。 */
export function normalizeParallelTasks(input: ParallelTaskSpec[]): { tasks?: NormalizedParallelTask[]; error?: string } {
  if (input.length < 2) return { error: '并行任务需要至少 2 个子任务（1 个请用 run_subagent）' };
  if (input.length > MAX_PARALLEL) return { error: `并行子任务最多 ${MAX_PARALLEL} 个（收到 ${input.length}）` };
  const tasks: NormalizedParallelTask[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const task = input[index]!;
    const objective = String(task.objective ?? '').trim();
    if (!objective) return { error: `任务 ${index + 1} 缺少 objective` };
    if (objective.length > 800) return { error: `任务 ${index + 1} 的 objective 过长（≤800 字符）` };
    const id = String(task.id ?? `task-${index + 1}`).trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return { error: `任务 id 非法: ${id}（仅字母/数字/下划线/连字符，≤32 字符）` };
    if (ids.has(id)) return { error: `任务 id 重复: ${id}` };
    ids.add(id);
    const dependsOn = Array.isArray(task.dependsOn)
      ? [...new Set(task.dependsOn.map((dependency) => String(dependency).trim()).filter(Boolean))]
      : [];
    tasks.push({ id, objective, plugins: task.plugins, tools: task.tools, dependsOn, publish: task.publish !== false, index });
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) return { error: `任务 ${task.id} 依赖不存在的任务: ${dependency}` };
    }
  }
  const waves = planParallelWaves(tasks);
  if (!waves) return { error: '任务依赖存在环，无法调度' };
  return { tasks };
}

/** 按依赖层级分批；同批任务互不依赖，可安全并发。返回 null 表示存在环。 */
export function planParallelWaves(tasks: { id: string; dependsOn?: string[] }[]): string[][] | null {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => !remaining.has(dependency)))
      .map(([id]) => id);
    if (ready.length === 0) return null;
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  return waves;
}

/** 将已完成依赖的结论注入下游任务；完整对话上下文不共享。 */
export function composeDependencyContext(
  task: Pick<NormalizedParallelTask, 'objective' | 'dependsOn'>,
  results: ReadonlyMap<string, Pick<ParallelTaskResult, 'objective' | 'ok'> & { answer?: unknown }>,
): string {
  const sections: string[] = [];
  for (const dependency of task.dependsOn) {
    const result = results.get(dependency);
    if (!result?.ok) continue;
    const answer = String(result.answer ?? '').trim().slice(0, 3_000);
    if (!answer) continue;
    sections.push(`### ${dependency}\n目标：${result.objective}\n结论：${answer}`);
  }
  if (!sections.length) return task.objective;
  const context = sections.join('\n\n').slice(0, 8_000);
  return `${task.objective}\n\n【上游依赖结论（由并行子代理产出，仅作输入；需自行核对）】\n${context}`;
}

/** 纯聚合函数：所有子任务都结算，失败/取消不丢失已产生的成本。 */
export function aggregateParallelResults(results: ParallelTaskResult[]): ParallelAggregate {
  const completed = results.filter((r) => r.ok).length;
  const failed = results.length - completed;
  return {
    results,
    completed,
    failed,
    cancelled: results.filter((r) => r.cancelled === true).length,
    status: completed === results.length ? 'completed' : completed > 0 ? 'partial' : 'failed',
    subagentCost: {
      cost: results.reduce((sum, r) => sum + (Number.isFinite(r.cost) ? (r.cost ?? 0) : 0), 0),
      tokensIn: results.reduce((sum, r) => sum + (Number.isFinite(r.tokensIn) ? (r.tokensIn ?? 0) : 0), 0),
      tokensOut: results.reduce((sum, r) => sum + (Number.isFinite(r.tokensOut) ? (r.tokensOut ?? 0) : 0), 0),
    },
  };
}

const PARALLEL_SYSTEM_PROMPT = [
  '你是 maharness 的并行子代理（parallel subagent），由主代理在批量并行任务中委派，负责其中独立的一项。',
  '工作纪律：',
  '1. 只完成委派给你的这一项目标，不扩散、不越权；完成后立即给出结论；',
  '2. 需要事实时先调用工具获取，绝不编造；',
  '3. 输出精炼：直接给出结论与关键证据，不要寒暄。',
].join('\n');

/** 共享预算均分（floor、余数归最后一项）：总消耗 ≤ 主任务剩余预算。
 *  若把同一份预算拷贝 N 份，并行子任务各自熔断在"同一剩余额"上，总额最多超发 ~N 倍。 */
export function splitBudget(budget: number | undefined, n: number): (number | undefined)[] {
  if (budget === undefined || n <= 0) return Array.from({ length: n }, () => undefined);
  if (Number.isInteger(budget)) {
    const each = Math.floor(budget / n);
    const shares = Array.from({ length: n }, () => each);
    shares[n - 1] = each + (budget - each * n);
    return shares;
  }
  return reserveBudget(budget, n).shares;
}

export default {
  id: 'parallel',
  name: '多会话并行',
  version: '0.1.0',
  onLoad(ctx) {
    // 反应性共效应（coeffect）：声明依赖 chat 服务——提供者激活/停用/换主时自动更新引用。
    // 依赖不可用 → 优雅降级（返回明确错误而非悬空引用）；提供者恢复 → 自动可用，无需重启。
    let chatSvc: {
      providers: ProviderDef[];
      routeForTask?: (taskText: string, routing: Record<string, string>, providers: ProviderDef[]) => { provider: ProviderDef; model: string } | undefined;
    } | undefined;
    const chatDep = ctx.inject('service:chat', (v) => {
      chatSvc = v as { providers: ProviderDef[] } | undefined;
    });
    let rulesText = '';
    ctx.inject('service:rules', (v) => {
      rulesText = (v as { promptBlock?: () => string } | undefined)?.promptBlock?.() ?? '';
    });
    const withUserRules = (base: string): string =>
      rulesText ? `${base}\n\n【用户规则（与主会话一致，必须遵守）】\n${rulesText}` : base;
    chatSvc = chatDep.value as typeof chatSvc;

    // ---- 并行进度事件（前端实时观测：并行任务开始/结束） ----
    // 带上 sessionId 与总数：前端据此把进度挂到正确的会话/正确的那张"小队"气泡上，
    // 并显示 2/4 这样的分母（没有分母的进度条等于没有进度）。
    const emit = (phase: 'start' | 'done' | 'fail', taskId: string, objective: string, detail?: unknown, extra?: { sessionId?: string; total?: number; index?: number }) => {
      ctx.bus.emit({ type: 'parallel.progress', data: { phase, taskId, objective, detail, ...(extra ?? {}) }, ts: Date.now() });
    };

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["network","delegate"],
        name: 'run_parallel',
        delegates: true,
        risk: 'low',
        costHint: 'high',
        sideEffect: 'external',
        limits: `一次最多 ${MAX_PARALLEL} 个并行子任务；成本 ≈ 多次 LLM 调用`,
        output: '{results: [{taskId, objective, ok, answer, toolCalls, tokensIn, tokensOut, cost, traceId, error?, cancelled?}], completed, failed, cancelled, status}',
        outputSchema: {
          type: 'object', required: ['results', 'completed', 'failed', 'cancelled', 'status'],
          properties: {
            results: { type: 'array' }, completed: { type: 'integer' }, failed: { type: 'integer' },
            cancelled: { type: 'integer' }, status: { type: 'string' }, summary: { type: 'string' },
            batchId: { type: 'string' }, blackboardPrefix: { type: 'string' },
          },
        },
        timeoutMs: 240_000, // 并行子代理内部多轮，独立超时 4 分钟
        description: '将任务拆分为多个子任务，按依赖关系分批并发委派子代理执行（互不污染上下文，独立产出后统一汇总）。' +
          '无 dependsOn 的任务同批并行；有 dependsOn 的任务等待上游完成后启动，并只接收上游的结构化结论。' +
          '用于：多个独立子问题、分阶段研究/分析、多个视角并行产出再交叉审查。结果按委派顺序返回，失败项带 error 不阻塞无关分支。',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: '并行子任务列表（2-8 个）',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '可选任务标识（字母/数字/下划线/连字符，≤32）；供 dependsOn 引用' },
                  objective: { type: 'string', description: '该子任务的目标（一句话，明确可交付）' },
                  tools: { type: 'string', enum: ['read', 'all'], description: '工具白名单：read=只读（默认），all=全部工具' },
                  plugins: { type: 'array', items: { type: 'string' }, description: '显式继承的父任务活动插件 ID' },
                  dependsOn: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '可选：依赖的任务 id；上游全部成功后本任务才启动，并接收其结论文本',
                  },
                  publish: { type: 'boolean', description: '是否把成功结论写入会话共享黑板（默认 true）' },
                },
                required: ['objective'],
              },
            },
          },
          required: ['tasks'],
        },
        async handler(args: { tasks?: ParallelTaskSpec[] }, tctx: ToolContext) {
          const normalized = normalizeParallelTasks(Array.isArray(args.tasks) ? args.tasks : []);
          if (!normalized.tasks) return { ok: false, error: normalized.error };
          const tasks = normalized.tasks;
          const waves = planParallelWaves(tasks);
          if (!waves) return { ok: false, error: '任务依赖存在环，无法调度' };
          if (tctx.delegate) {
            const byId = new Map<string, ParallelTaskResult>();
            const shares = splitBudget(tctx.remainingBudget, tasks.length);
            for (const wave of waves) {
              const results = await Promise.all(wave.map(async id => {
                const task = tasks.find(candidate => candidate.id === id)!;
                if (task.dependsOn.some(dependency => !byId.get(dependency)?.ok)) return { taskId: id, objective: task.objective, ok: false, error: '依赖任务未成功', cost: 0 };
                try {
                  const result = await tctx.delegate!({ objective: composeDependencyContext(task, byId), tools: task.tools === 'all' ? 'all' : 'read', instructions: PARALLEL_SYSTEM_PROMPT, maxTurns: 12, budgetUsd: shares[task.index], plugins: task.plugins }, tctx.signal);
                  return { ...result, taskId: id, objective: task.objective, ok: !result.error };
                } catch (error) { return { taskId: id, objective: task.objective, ok: false, error: error instanceof Error ? error.message : String(error), cost: 0 }; }
              }));
              results.forEach(result => byId.set(result.taskId, result));
            }
            const aggregate = aggregateParallelResults(tasks.map(task => byId.get(task.id)!));
            return { ok: parallelToolSucceeded(aggregate), data: aggregate };
          }

          // 复用主代理的 provider 配置（chat 服务第一个启用的 provider；反应性注入保持新鲜）
          const fallbackProvider = chatSvc?.providers?.[0];
          if (!fallbackProvider) return { ok: false, error: 'chat 服务不可用（未配置 LLM Provider 或对话引擎未加载），无法并行委派' };
          const routing = ctx.config.get<Record<string, string>>('agent.modelRouting', {});

          // 前置校验：循环服务必须可用（B2——不可用就白扣配额；子任务里仍逐个经
          // makeRunner 取用，保持「替换循环即全局一致」的语义）
          if (!makeRunner(ctx.kernel, ctx.bus)) {
            return { ok: false, error: '执行循环服务（service:runner）不可用——对话引擎插件未加载，无法并行委派' };
          }

          // 一次 run_parallel 只扣一次配额；成本仍由预算均分与子循环轮数上限约束。
          const quota = ctx.kernel.budget.consumeSubagentQuota(tctx.sessionId ?? '');
          if (!quota.allowed) {
            return { ok: false, error: `子代理配额不足（10 分钟窗口内限额，剩余 ${quota.remaining}）。请减少委派频率或稍后再试。` };
          }
          const allTools = ctx.kernel.plugins.capabilities('tool')
            .map((c) => c.tool)
            .filter((tool) => !DELEGATION_TOOLS.has(tool.name));
          const toolsFor = (t: { tools?: string }): ToolDef[] => t.tools === 'all'
            ? allTools
            : allTools.filter((x) => READ_ONLY_TOOLS.has(x.name));

          let blackboard: {
            put(sessionId: string, key: string, value: unknown, tags?: string[], tenantId?: string): unknown;
          } | undefined;
          const blackboardDep = ctx.inject('service:blackboard', (value) => {
            blackboard = value as typeof blackboard;
          });
          blackboard = blackboardDep.value as typeof blackboard;

          const releaseSlots = ctx.kernel.budget.reserveSubagentSlots(tasks.length);
          if (!releaseSlots) {
            quota.refund?.();
            return { ok: false, error: `并行资源繁忙：当前最多同时运行 ${MAX_PARALLEL_ACTIVE} 个子任务；本批次未启动，配额已退还。` };
          }

          // ---- 并发执行：每个子任务独立 AgentRunner 循环，Promise.allSettled 汇总 ----
          // H3 中断/预算透传：主循环 abort 与剩余预算传导给每个并行子循环
          //（remainingBudget 为执行器在 ToolContext 上的局部扩展字段，kernel 契约尚未声明）
          const remainingBudget = (tctx as ToolContext & { remainingBudget?: number }).remainingBudget;
          // 共享预算均分（floor、余数归最后一项）：总消耗 ≤ 主任务剩余预算。
          // 若把同一份预算拷贝 N 份，并行子任务各自熔断在"同一剩余额"上，总额最多超发 ~N 倍。
          const reservation = remainingBudget === undefined ? undefined : reserveBudget(remainingBudget, tasks.length);
          const budgetShares = reservation?.shares ?? splitBudget(undefined, tasks.length);
          const batchId = randomUUID().slice(0, 8);
          const batchKey = `parallel:${batchId}`;
          const results: (ParallelTaskResult | undefined)[] = new Array(tasks.length);
          const byId = new Map<string, ParallelTaskResult>();

          const publishResult = (task: NormalizedParallelTask, result: ParallelTaskResult): void => {
            if (!task.publish || !result.ok || !blackboard) return;
            try {
              blackboard.put(tctx.sessionId ?? '_default', `${batchKey}:${task.id}`, {
                objective: task.objective,
                answer: String(result.answer ?? '').slice(0, 12_000),
                traceId: result.traceId,
                dependsOn: task.dependsOn,
              }, ['parallel', batchId, ...task.dependsOn], tctx.tenantId);
            } catch { /* 黑板不可写不影响任务结果 */ }
          };

          const runOne = async (task: NormalizedParallelTask): Promise<ParallelTaskResult> => {
            const failedDependency = task.dependsOn
              .map((dependency) => byId.get(dependency))
              .find((dependency) => !dependency?.ok);
            if (failedDependency) {
              const result: ParallelTaskResult = {
                taskId: task.id, objective: task.objective, ok: false,
                error: `依赖任务未成功: ${failedDependency.taskId}${failedDependency.error ? `（${failedDependency.error}）` : ''}`,
                cancelled: failedDependency.cancelled === true,
                dependsOn: task.dependsOn, toolCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0,
                traceId: '',
              };
              emit('fail', task.id, task.objective, { error: result.error, cancelled: result.cancelled }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
              return result;
            }

            const traceId = `par-${randomUUID().slice(0, 8)}`;
            const route = chatSvc?.routeForTask?.(task.objective, routing, chatSvc.providers);
            const provider = route?.provider ?? fallbackProvider;
            const model = route?.model ?? provider.defaultModel;
            emit('start', task.id, task.objective, { index: task.index, dependsOn: task.dependsOn }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
            // 循环经服务解析取得（service:runner）：与顶层/子代理同一实现，替换循环即全局一致
            const runner = makeRunner(ctx.kernel, ctx.bus);
            if (!runner) {
              emit('fail', task.id, task.objective, { error: 'service:runner 不可用' }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
              return {
                taskId: task.id, objective: task.objective, ok: false, dependsOn: task.dependsOn,
                error: '执行循环服务（service:runner）不可用——对话引擎插件未加载', toolCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0, traceId,
              };
            }
            let answer = '';
            let usage = { input: 0, output: 0 };
            let cost = 0;
            let toolCalls = 0;
            let error: string | undefined;
            let cancelled = false;
            try {
              for await (const ev of runner.run({
                provider,
                model,
                messages: [{ role: 'user', content: composeDependencyContext(task, byId) }],
                systemPrompt: withUserRules(PARALLEL_SYSTEM_PROMPT),
                tools: toolsFor(task),
                traceId,
                maxTurns: 12,
                parentStepId: tctx.stepId, // span 树：并行子任务全部步骤挂到 run_parallel 工具步骤下
                signal: tctx.signal,
                sessionId: tctx.sessionId,
                tenantId: tctx.tenantId,
                principalRole: tctx.principal?.role,
                sandboxRoot: tctx.sandboxRoot,
                costBudget: budgetShares[task.index],
              })) {
                if (ev.type === 'delta') answer += ev.text;
                else if (ev.type === 'tool_result') toolCalls++;
                else if (ev.type === 'assistant_done') { usage = ev.usage; cost = ev.cost; }
                else if (ev.type === 'approval_required') {
                  // 并行子任务审批可达性：审批注册在共享 ApprovalBoard（/api/approvals/:id
                  // 经主 runner 可达）；事件经全局事件总线广播给 UI——父执行器阻塞在
                  // 本 handler 内，事件无法经其 yield 流透传，必须走带外通道。
                  ctx.bus.emit({
                    type: 'approval.requested',
                    traceId,
                    ts: Date.now(),
                    data: { approvalId: ev.approvalId, name: ev.name, summary: ev.summary, sessionId: tctx.sessionId },
                  });
                }
                else if (ev.type === 'error') { error = ev.error; cancelled = ev.kind === 'aborted'; }
              }
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
              cancelled = tctx.signal?.aborted === true;
            }
            if (error) {
              emit('fail', task.id, task.objective, { error, cancelled, cost }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
              return {
                taskId: task.id, objective: task.objective, ok: false, dependsOn: task.dependsOn,
                error: `并行子任务失败: ${error}`, cancelled, toolCalls, tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
              };
            }
            emit('done', task.id, task.objective, { toolCalls, tokensIn: usage.input, tokensOut: usage.output, cost }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
            return {
              taskId: task.id, objective: task.objective, ok: true, dependsOn: task.dependsOn,
              answer: answer.trim(), toolCalls,
              tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
            };
          };

          try {
            for (const wave of waves) {
              const waveTasks = wave.map((id) => tasks.find((task) => task.id === id)!).filter(Boolean);
              const settled = await Promise.all(waveTasks.map(async (task) => {
                try {
                  return { task, result: await runOne(task) };
                } catch (err) {
                  const result: ParallelTaskResult = {
                    taskId: task.id, objective: task.objective, ok: false, dependsOn: task.dependsOn,
                    error: `内部异常: ${err instanceof Error ? err.message : String(err)}`,
                    toolCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0, traceId: '',
                  };
                  emit('fail', task.id, task.objective, { error: result.error }, { sessionId: tctx.sessionId, total: tasks.length, index: task.index });
                  return { task, result };
                }
              }));
              for (const { task, result } of settled) {
                results[task.index] = result;
                byId.set(task.id, result);
                publishResult(task, result);
              }
            }
          } finally {
            releaseSlots();
          }

          const completed = results.map((result, index) => result ?? {
            taskId: tasks[index]!.id, objective: tasks[index]!.objective, ok: false, error: '任务未执行',
            dependsOn: tasks[index]!.dependsOn,
          });
          if (reservation) completed.forEach((result, index) => {
            reservation.settle(index, Number((result as { cost?: number }).cost ?? 0));
          });
          // C5 成本回传：聚合全部子任务的开销，主循环执行器并入 totalCost/熔断核算
          const aggregate = aggregateParallelResults(completed as ParallelTaskResult[]);
          return {
            ok: parallelToolSucceeded(aggregate),
            data: {
              ...aggregate,
              batchId,
              blackboardPrefix: blackboard ? batchKey : undefined,
              summary: aggregate.results.map((r, i) => {
                const dependency = Array.isArray(r.dependsOn) && r.dependsOn.length ? ` [依赖 ${r.dependsOn.join(', ')}]` : '';
                return `${i + 1}.${dependency} ${r.objective} → ${r.ok ? '完成' : r.cancelled ? '取消' : '失败'}`;
              }).join('\n'),
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
          '多个相互独立的子任务优先用 run_parallel；有依赖的任务用 dependsOn 表达。',
          '结果包含各自 traceId 与结论，采信前可核对引用内容。',
        ].join('\n'),
      },
    });

    ctx.logger.info('工具就绪: run_parallel（多会话并行：并发子代理 + 独立轨迹 + 统一汇总）');
  },
} satisfies Plugin;
