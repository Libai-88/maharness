/**
 * core/chat/agent.ts —— Agent 执行器（自研）
 * 循环模型：决策(LLM 流式) → 动作(工具执行) → 观测(结果回填)，直到无工具调用。
 * 每一步发 Trace 事件（llm_call / tool_call），全程可观测；支持预算与中断。
 */
import { randomUUID, createHash } from 'node:crypto';
import { sharedPrefixTokens, estimateTokens } from '../../kernel/tokens';
import { classifyTask, reasoningBudgetFor } from '../../kernel/budget';
import { validateAgainstSchema } from '../../kernel/validate';
import { resultStore, sessionKeyOf } from './result-store';
import { estimateCost } from './provider';
import type {
  EventBusLike, KernelLike, LLMChunk, LLMMessage, ProviderDef, StepHandle, ToolCall, ToolContext, ToolDef, ToolResult, TraceStep,
} from '../../kernel/types';

/**
 * 钩子管线运行上下文（agent.* 事件负载）
 * 监听器通过改写字段影响流程：history（注入上下文/记忆）、tools、scratchpad（跨轮共享）、
 * blocked（拦截）、tool.args（改写参数）、result（改写结果）。约定俗成，不触碰内核。
 */
export interface AgentHookCtx {
  traceId: string;
  turn: number;
  model: string;
  history: LLMMessage[];
  systemPrompt: string;                 // 信息展示；改 history[0].content 才真正生效
  tools: ToolDef[];
  scratchpad: Record<string, unknown>;
  blocked?: boolean;                    // 置 true 拦截（agent.input.received / agent.before_tool）
  blockReason?: string;
  tool?: { name: string; args: unknown };
  content?: string;                     // after_llm：模型输出（观测）
  reasoning?: string;
  toolCalls?: ToolCall[];
  result?: ToolResult;                  // after_tool：结果（可改写）
  error?: string;                       // on_error
  reason?: string;                      // agent.stopped：停止原因（如 'max_turns'）
}

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  /** 工具开始：callId = tool_call id（并行执行时前端按 callId 路由到对应卡片） */
  | { type: 'tool_start'; name: string; args: unknown; callId?: string }
  /** 工具流式输出增量（tool.delta）：工具通过 tctx.stream() 边执行边推送，
   *  执行器实时转发——前端工具卡片边跑边渲染，无需等工具结束 */
  | { type: 'tool_delta'; name: string; text: string; callId?: string }
  | { type: 'tool_result'; name: string; summary: string; ok: boolean; stored?: boolean; callId?: string }
  | { type: 'approval_required'; approvalId: string; name: string; summary: string; args: unknown }
  | { type: 'assistant_done'; content: string; reasoning: string; usage: { input: number; output: number }; cost: number; cached?: boolean }
  | { type: 'budget_hit'; cost: number; budget: number }
  | { type: 'handoff'; role: string; objective: string }
  /** provider 重试（内层瞬态重试 / 外层切换备用）：重试前执行器已清空上次失败流的
   *  半截状态（C1），前端收到本事件应作废当前流式渲染、从零重新累积 */
  | { type: 'retry' }
  | { type: 'error'; error: string };

export interface RunOptions {
  provider: ProviderDef;
  model: string;
  messages: LLMMessage[];    // 会话历史（含最新用户消息）
  /** 本轮临时上下文：发送给模型但不写回会话历史（如世界状态）。 */
  contextMessages?: LLMMessage[];
  systemPrompt?: string;
  tools?: ToolDef[];         // 覆盖可用工具（如 plan 模式出计划阶段传 []，强制只输出计划）
  traceId: string;
  /** L1 会话级缓存作用域（如 session.id）：跨多次 run 的同一会话共享"会话自产答案"；
   *  缺省用 traceId——子代理/独立循环天然隔离（每次 traceId 唯一）。 */
  scope?: string;
  /** 当前会话 ID：透传给工具（ToolContext.sessionId），工具可把状态挂到具体会话 */
  sessionId?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  /** 备用 provider（失败恢复）：主 provider 重试后仍失败时依次尝试，LLM 不必面对 error 500 */
  fallbackProviders?: ProviderDef[];
  /** 父 Trace 步骤 id（span 树）：子代理/并行等子任务的全部步骤挂到调用方工具步骤下，
   *  跨 traceId 可从父轨迹下钻（OpenAI tracing 的 span 层级）。由工具执行时 ToolContext.stepId 传入。 */
  parentStepId?: string;
  /** 本任务成本硬上限（美元）：累计成本 ≥ 该值时熔断——不再发起新 LLM 调用，保留已完成结果。
   *  harness 管理认知资源的硬边界（软边界是 server 侧的成本警告注入）。 */
  costBudget?: number;
  /** 上下文压缩回调（M1 循环内预算检查）：每轮 before_llm 后估算 history，
   *  超 context.maxTokens 时调用，返回压缩后的消息序列（由 server 注入 compactHistory
   *  等实现）；缺失时维持现状（不在 run 内压缩，由 server 组装侧兜底）。 */
  compactFn?: (history: LLMMessage[]) => Promise<LLMMessage[]>;
  /** 断点回调（checkpoint）：每轮工具执行完（下轮 LLM 调用前）触发，携带完整历史
   *  （含工具回填，字节级可恢复）。server 层持久化；resume 用该历史继续——中断不白跑。 */
  onCheckpoint?: (turn: number, history: LLMMessage[]) => void;
  /** 发送序列快照同步（L3 前缀缓存逼近 100% 的关键）：每次 LLM 调用前，把
   *  实际发送的消息序列中【尚未入库的增量】回调给 server 持久化。
   *  覆盖全部消息类型（含钩子注入的教训/记忆/英文提醒）——DB 成为发送序列的
   *  忠实镜像，跨 run 组装与上 run 序列构成纯追加关系，provider KV 缓存前缀
   *  逐字节延续（注入消息不入库会插在历史中段导致整个历史区前缀断裂）。 */
  onHistorySync?: (messages: { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }[]) => void;
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是运行在 Windows 上的自研 Web Agent，具备工具调用能力（文件读写、联网搜索等）。',
  '行为准则：',
  '1. 回答简洁、准确，默认使用中文；',
  '2. 需要文件或外部信息时，先调用工具获取事实，再基于事实回答；',
  '3. 文件操作前简要说明意图；涉及写入时内容要完整准确；',
  '4. 工具失败时说明原因并给出可行的替代方案；',
  '5. 不要编造工具结果。',
].join('\n');

/** 审批等待超时（毫秒）：10 分钟未响应自动拒绝 */
const APPROVAL_TIMEOUT = 10 * 60 * 1000;

/** 工具执行默认超时（毫秒；config agent.toolTimeoutMs 可调） */
const TOOL_TIMEOUT_DEFAULT = 30_000;

/** 工具结果回填阈值（字符）：超过则存入结果存储，历史只留摘要+引用（recall_tool_result 重读） */
const RESULT_STORE_THRESHOLD = 2000;

/** Context Provider 单轮注入总预算（tokens）：上下文工程——按需组装，杜绝无脑塞入 */
const CONTEXT_PROVIDER_BUDGET = 1500;

/** 自适应阈值：连续工具失败达到该次数时，harness 注入策略提示（管理"认知资源"） */
const ADAPT_FAIL_STREAK = 3;

/** 单轮思考预算（token）：单轮 reasoning 超限 → 下一轮注入降级提示。
 *  800 ≈ 600 英文词，足以容纳深度推理的完整一轮；配合任务分级（代码 ×1.5 / 问答 ×0.5）。
 *  预算的本质是限制「空转」（重复推理、原地打转），而不是限制「有效思考」——
 *  降级提示因此允许模型在有新路径时继续推进。 */
const REASONING_BUDGET_DEFAULT = 800;

/** 单任务总思考预算（token）：跨轮累计，防多轮空转绕过单轮预算（每轮 600 词 × 5 轮 ≈ 3000） */
const REASONING_TOTAL_DEFAULT = 3000;

/** 英文思考提醒：紧贴每次 LLM 决策点注入（system role，位置稳定可复用 L3 前缀缓存）。
 *  与 system prompt 的思维宪章呼应；带英文思考示例（few-shot 引导强于纯指令，Wei22）：
 *  模型推理语言跟随上下文主导语言，中文消息会淹没英文指令——示例让模型进入英文推理语境。 */
const EN_THINK_REMINDER = 'Reason in ENGLISH, start with "We need ...". Example: "We need to explain virtual memory. Known: it maps virtual addresses to physical frames. Unknown: the exact page-table mechanism. Plan: define the concept, then the mechanism, then why it matters." Chinese is only for the final answer.';

/** 轮次继续提示（user 角色，固定内容）——请求结尾规整的关键：
 *  实测网关（opencode.ai/zen/go）对「以 tool/system 消息结尾」的请求不建立前缀缓存
 *  （跨 run 首轮全 miss 的根因），而对「以 user 结尾」的请求缓存正常。
 *  工具轮后追加此提示使每次 LLM 请求恒以 user 结尾 → 前缀跨 run 逐字节延续。
 *  带【继续】标记：L1 语义缓存查询/任务画像据此排除，不当作真实用户问题。 */
const CONTINUE_HINT = '【继续】请根据工具结果继续处理任务；如任务已完成，直接给出最终回答。';

/** 工具结果摘要（固定截断：同一内容 → 同一文本，保证前缀逐字节稳定） */
export function summarizeToolResult(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 400 ? t.slice(0, 400) + '…' : t;
}

/**
 * 工具轮文本化（L3 前缀缓存的关键形态，run 内与跨 run 共用）：
 * 把历史中的 assistant{tc} + tool 消息对合并为一条 assistant 纯文本消息
 * （工具名 + 结果摘要）——发送序列不含 tool_calls 结构、恒以 user 结尾，
 * 网关（opencode.ai/zen/go）对纯文本序列的前缀缓存稳定，对含 tc 结构不稳定。
 * 文本化产物字节级确定（同一消息 → 同一文本），run 内每轮与跨 run 组装
 * 生成的序列完全一致 → 前缀逐字节延续。tool 消息不单独输出（合并进 assistant）。
 */
export function textualizeHistory(history: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  const toolById = new Map<string, string>();
  for (const m of history) {
    if (m.role === 'tool' && m.tool_call_id) toolById.set(m.tool_call_id, String(m.content ?? ''));
  }
  for (const m of history) {
    if (m.role === 'tool') continue; // 工具消息合并进对应的 assistant 消息
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [m.content ?? ''];
      for (const c of m.tool_calls) {
        // L3 参数摘要：保留调用实参的前 200 字符（确定性截断，字节级稳定）——
        // 模型可回顾自己之前的调用实参，不至于只见结果不见输入
        const rawArgs = String(c.function?.arguments ?? '').replace(/\s+/g, ' ').trim();
        const argBrief = rawArgs.length > 200 ? rawArgs.slice(0, 200) + '…' : rawArgs;
        const res = toolById.get(c.id);
        parts.push(`\n【工具调用 ${String(c.function?.name ?? '')}】参数: ${argBrief || '(空)'}\n结果: ${res ? summarizeToolResult(res) : '(结果已省略)'}`);
      }
      out.push({ role: 'assistant', content: parts.join('\n') });
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/** 能力发现：给 LLM 看的工具描述自动附加风险/成本/限制/输出格式标签（registry 元数据 → 提示词）
 *  导出供 selftest 单测；LLM 收到的每个工具描述都带【风险:…|成本:…|…】前缀与输出格式说明 */
export function annotateToolDef(t: ToolDef): ToolDef {
  if (!t.risk && !t.costHint && !t.approval && !t.limits && !t.output) return t;
  const tags: string[] = [];
  if (t.risk) tags.push(`风险:${t.risk}`);
  if (t.costHint) tags.push(`成本:${t.costHint}`);
  if (t.approval) tags.push('需审批');
  if (t.limits) tags.push(t.limits);
  const head = tags.length ? `【${tags.join('|')}】` : '';
  const tail = t.output ? `\n输出格式: ${t.output}` : '';
  return { ...t, description: `${head}${t.description}${tail}` };
}

/** 包裹工具执行：超时保护，防止工具挂起卡死整轮对话（超时后 handler 仍可能在后台运行，由工具自行响应 signal 取消） */
async function withToolTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`工具执行超时（${ms / 1000}s）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式工具执行（tool.delta）：把工具 handler 与增量队列解耦——
 *  - 注入 tctx.stream：工具边执行边推送增量文本（命令实时输出/大文件分段读取等）；
 *  - 返回 { promise, deltas }：promise 为最终结果（含超时/异常兜底），
 *    deltas 为 AsyncIterable，主循环 for await 实时转发为 tool_delta 事件；
 *  - handler 结束（成功/失败/超时）即 finish 队列，残留增量排空后迭代终止。
 *  工具不调用 stream 时队列恒空，for await 立即结束——零开销向后兼容。
 */
function runToolStreaming(
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number,
): { promise: Promise<ToolResult>; deltas: AsyncIterable<string> } {
  const queue: string[] = [];
  let done = false;
  let notify: (() => void) | null = null;
  const streamCtx: ToolContext = { ...ctx, stream: (chunk) => { queue.push(String(chunk?.text ?? '')); notify?.(); notify = null; } };
  const promise = withToolTimeout(handler(args, streamCtx), timeoutMs).then(
    (r) => { done = true; notify?.(); notify = null; return r; },
    (err) => { done = true; notify?.(); notify = null; return { ok: false, error: err instanceof Error ? err.message : String(err) }; },
  );
  const deltas: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) return;
        await new Promise<void>((r) => { notify = r; });
      }
    },
  };
  return { promise, deltas };
}

/**
 * 合并多个工具的流式增量（并行工具执行）：并发消费各工具 deltas 队列，
 * 先到先发（Promise.race 竞速），每个增量带 callId 供前端路由到对应卡片。
 * 全部流结束（handler 完成/超时/失败）即终止。
 */
async function* mergeToolStreams(streams: { callId: string; name: string; deltas: AsyncIterable<string> }[]): AsyncGenerator<{ callId: string; name: string; text: string }> {
  if (!streams.length) return;
  const iters = streams.map((s) => ({ callId: s.callId, name: s.name, it: s.deltas[Symbol.asyncIterator]() }));
  const active = new Set(iters.map((_, i) => i));
  const nexts = new Map<number, Promise<{ i: number; r: IteratorResult<string> }>>();
  for (const i of active) nexts.set(i, iters[i].it.next().then((r) => ({ i, r })));
  while (active.size) {
    const { i, r } = await Promise.race([...nexts.values()]);
    nexts.delete(i);
    if (r.done) {
      active.delete(i);
    } else {
      yield { callId: iters[i].callId, name: iters[i].name, text: r.value };
      nexts.set(i, iters[i].it.next().then((r2) => ({ i, r: r2 })));
    }
  }
}

export class AgentRunner {
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private kernel: KernelLike, private bus: EventBusLike) {}

  /** 发布钩子事件（v3 中间件语义）：走 waterfall 派发——每个监听器收到 (e)，
   *  e.data 即钩子上下文（可改写 history/tools/scratchpad/blocked 等），
   *  返回 undefined 自动继续下个监听器，落到底层 final（现状无底层，纯串联）。
   *  与旧 emitAsync 兼容：现有插件 (e)=>void 直接可用，只是额外获得
   *  「改写 data / 短路接管」的中间件能力（如 memory 插件可改写注入内容）。 */
  private emitHook(type: string, data: AgentHookCtx): Promise<void> {
    return this.bus.waterfall<void>(type, data, async () => {
      /* 无底层实现：钩子链仅由监听器组成，串联即观察/改写 */
      void type;
    });
  }

  /** 外部（REST 接口）响应审批：批准或拒绝 */
  approveApproval(approvalId: string, approved: boolean): boolean {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) return false;
    this.pendingApprovals.delete(approvalId);
    resolve(approved);
    return true;
  }

  /** 运行一轮完整对话（直到模型不再调用工具） */
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent> {
    const { provider, model, messages, traceId, signal } = opts;
    // L1 会话级缓存作用域：优先使用调用方传入的稳定会话标识（session.id），
    // 缺省用 traceId（每次 run 唯一 → 天然隔离，子代理不串答案）
    const cacheScope = opts.scope ?? traceId;
    // 轮数上限：调用方按模式传值（目标模式长任务更高），缺省用配置 agent.maxTurns
    const maxTurns = opts.maxTurns ?? this.kernel.config.get<number>('agent.maxTurns', 12);
    const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const history: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
      ...(opts.contextMessages ?? []),
    ];
    const tools = this.kernel.plugins.capabilities('tool');
    const toolDefs = (opts.tools ?? tools.map((c) => c.tool)).map(annotateToolDef);
    const sandboxRoot = this.kernel.config.get<string>('sandboxRoot', this.kernel.rootDir);
    const toolTimeout = this.kernel.config.get<number>('agent.toolTimeoutMs', TOOL_TIMEOUT_DEFAULT);
    // 思考预算：单轮 + 总量双轨，基准值 × 任务本质系数（代码多思考、问答少思考）——认知资源按本质分配
    const baseBudget = this.kernel.config.get<number>('agent.reasoningBudget', REASONING_BUDGET_DEFAULT);
    const totalBudget = this.kernel.config.get<number>('agent.reasoningTotalBudget', REASONING_TOTAL_DEFAULT);
    const lastUserMsg0 = [...messages].reverse().find((m) => m.role === 'user');
    const reasoningBudget = reasoningBudgetFor(classifyTask(lastUserMsg0?.content ?? ''), baseBudget);
    const thinkInEnglish = this.kernel.config.get<boolean>('agent.thinkInEnglish', true);
    const scratchpad: Record<string, unknown> = {};

    // ---- 发送序列快照同步游标：DB = 发送序列的忠实镜像（L3 前缀缓存逼近 100% 的关键） ----
    // history 数组只增不改；[0, syncedCount) 已入库。history[0] = system prompt
    // （routes 每 run 组装，不入库）；history[1:] = DB 组装的历史（已在库中）——
    // 因此 syncedCount 初始化为组装完成时的 history.length：只同步【本 run 新增】
    // 的消息（钩子注入的教训/记忆/英文提醒、assistant 含 tool_calls、tool 结果）。
    // 若从 1 开始会把已入库消息重复写回 → DB 翻倍 → 跨 run 序列与上 run 不同 → 前缀断裂。
    let syncedCount = history.length;
    const syncHistory = () => {
      if (!opts.onHistorySync || history.length <= syncedCount) return;
      const inc = history.slice(syncedCount);
      syncedCount = history.length;
      opts.onHistorySync(inc.map((m) => ({
        role: m.role,
        content: m.content ?? null,
        ...(m.role === 'assistant' && m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.role === 'tool' && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })));
    };

    // ---- 钩子：输入到达（安全/预处理插件可拦截或改写上下文） ----
    const inputCtx: AgentHookCtx = { traceId, turn: 0, model, history, systemPrompt, tools: toolDefs, scratchpad };
    await this.emitHook('agent.input.received', inputCtx);
    if (inputCtx.blocked) {
      yield { type: 'error', error: inputCtx.blockReason ?? '已被策略拦截' };
      return;
    }

    let totalIn = 0, totalOut = 0, totalCost = 0;
    // L3 前缀缓存统计：记录上一轮实际发给 LLM 的 history 快照（钩子可能改写）
    let lastHistory: { role?: string; content?: string | null }[] | null = null;
    // 自适应：本会话连续工具失败计数（超阈值时注入建议，管理"认知资源"）
    let toolFailStreak = 0;
    let adaptHintInjected = false;
    // 思考预算：上一轮 reasoning 长度 + 全任务累计（token）；超限后注入降级提示（限一次）
    // 双轨语义：单轮预算防「单轮空转」，总量预算防「多轮累计空转」。
    // 降级提示允许模型区分「空转」与「推进」——有新路径可继续思考，原地打转才收敛。
    let lastTurnReasoningTokens = 0;
    let totalReasoningTokens = 0;
    let budgetHintInjected = false;
    let costWarnInjected = false;
    // 最后真实 user 消息（任务画像/熔断记录用；L1 缓存查询块会更新它）
    let q = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        yield { type: 'error', error: '已中断' };
        return;
      }

      // ---- 成本熔断（harness 硬边界，实时核算）：累计成本 ≥ 预算 → 不再发起新 LLM 调用 ----
      // 与 server 侧的成本警告（软边界，注入文本）分级配合：警告让 LLM 收敛，
      // 熔断由 harness 强制执行——预算不是建议，是边界。
      if (opts.costBudget !== undefined && totalCost >= opts.costBudget) {
        this.kernel.trace.startStep({ traceId, turn, type: 'system', name: 'cost-breaker', parentId: opts.parentStepId })
          .fail(`成本预算已耗尽`, { outputSummary: `$${totalCost.toFixed(6)} ≥ $${opts.costBudget.toFixed(6)}，熔断停止` });
        this.kernel.budget.recordTask({
          type: classifyTask(q), turns: turn + 1, cost: totalCost, failed: true, ts: Date.now(),
        });
        yield { type: 'budget_hit', cost: totalCost, budget: opts.costBudget };
        yield { type: 'error', error: `成本预算已耗尽（本任务累计 $${totalCost.toFixed(6)} ≥ 预算 $${opts.costBudget.toFixed(6)}），已停止。已完成的部分结果保留在会话中；如需继续请新建会话或提高预算。` };
        return;
      }

      // ---- 钩子：调用 LLM 前（记忆注入 / 上下文拼装 / 工具调整） ----
      const llmCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad };
      await this.emitHook('agent.before_llm', llmCtx);

      // ---- M1 循环内预算检查：每轮估算 history，超 context.maxTokens → 压缩 ----
      // compactFn 由 server 注入（compactHistory 实现）；缺失时维持现状。
      // 压缩 = 序列重写：就地替换（history 与 llmCtx.history 同引用不断链），并重置
      // 增量同步游标（重写后的序列与 DB 镜像关系由 server 侧协调）。
      if (opts.compactFn) {
        const ctxMaxTokens = this.kernel.config.get<number>('context.maxTokens', 60_000);
        const histTokens = estimateTokens(llmCtx.history.map((m) => m.content ?? '').join('\n'));
        if (histTokens > ctxMaxTokens) {
          try {
            const compacted = await opts.compactFn(llmCtx.history);
            if (compacted && compacted.length < llmCtx.history.length) {
              llmCtx.history.splice(0, llmCtx.history.length, ...compacted);
              syncedCount = llmCtx.history.length;
            }
          } catch { /* 压缩失败不阻断主循环：按原历史继续（server 组装侧截断兜底） */ }
        }
      }

      // ---- 成本预警（85% 阈值，限一次）：接近预算 → 注入收敛指令 ----
      // 与思考预算同级的"认知资源"管理：预算不是请 LLM 自觉，是 harness 告知边界
      if (opts.costBudget !== undefined && !costWarnInjected && totalCost > opts.costBudget * 0.85) {
        costWarnInjected = true;
        llmCtx.history.push({
          role: 'system',
          content: `【harness 成本预警】本任务已花费 $${totalCost.toFixed(5)}，接近预算上限 $${opts.costBudget.toFixed(5)}（85%）。请立即收敛：停止探索性工具调用，基于已有信息直接给出结论；超预算将被强制熔断。`,
        });
      }

      // ---- 思考预算（思维链管理）：单轮或总量超限 → 注入降级指令 ----
      // 依据：Anthropic effort 实测「少想反而更好」；但预算的本质是限制空转而非有效思考，
      // 故降级提示保留「有新路径可继续推进」的出口。
      if (!budgetHintInjected && (totalReasoningTokens > totalBudget || lastTurnReasoningTokens > reasoningBudget)) {
        budgetHintInjected = true;
        const overTotal = totalReasoningTokens > totalBudget;
        const shown = overTotal ? totalReasoningTokens : lastTurnReasoningTokens;
        const cap = overTotal ? totalBudget : reasoningBudget;
        llmCtx.history.push({
          role: 'system',
          content: `【harness 思考预算·${overTotal ? '总量' : '单轮'}】思考已达预算（${shown} token > ${cap}）。请自检是否在原地打转：若确有新信息可观察（调工具）或新路径可尝试，继续推进；若只是在重复已有推理，请基于已有信息与工具结果给出当前最佳结论。`,
        });
        this.kernel.trace.startStep({ traceId, turn, parentId: opts.parentStepId, type: 'system', name: 'reasoning-budget' })
          .finish({ outputSummary: `注入思考预算降级提示（${overTotal ? '总量' : '单轮'} ${shown}/${cap} token）` });
      }

      // ---- Context Provider 注入（上下文工程）：插件按需提供上下文 ----
      // 与 before_llm 钩子并存：钩子 = 命令式（失败教训注入），context = 声明式。
      // 全部追加到 history 末尾（前缀稳定，不破坏 L3）；总预算控制，超限丢弃低权重；
      // 每次注入记入 Trace（context-inject），可观察"谁喂了什么给 LLM"。
      if (turn === 0) {
        const ctxProviders = this.kernel.plugins.capabilities('context')
          .map((c) => c.context)
          .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
        let ctxTokens = 0;
        for (const cp of ctxProviders) {
          try {
            const content = cp.contentFn({ history: llmCtx.history, systemPrompt, scratchpad });
            if (!content) continue;
            const t = estimateTokens(content);
            if (ctxTokens + t > CONTEXT_PROVIDER_BUDGET) continue;
            ctxTokens += t;
            llmCtx.history.push({ role: 'system', content });
            const cStep = this.kernel.trace.startStep({ traceId, turn, parentId: opts.parentStepId, type: 'system', name: 'context-inject' });
            cStep.finish({ outputSummary: `${cp.id} 注入 ${t} tokens${cp.description ? `（${cp.description.slice(0, 40)}）` : ''}` });
          } catch { /* context provider 自身异常不影响主循环 */ }
        }
      }

      // ---- 英文思考提醒（首轮注入，随历史保留）----
      // 必须在 Context Provider 注入【之后】：记忆/上下文消息若追加在 reminder 后面，
      // 模型最后看到的是中文消息，思考语言会被带偏（思维链不稳定的根因）。
      // H6 去重：按全局存在性查重（跨 run / 断点恢复的历史中部已有 reminder 时不再注入，
      // 否则每次 resume 都会叠一条）。
      if (turn === 0 && thinkInEnglish && !llmCtx.history.some((m) => m.content === EN_THINK_REMINDER)) {
        llmCtx.history.push({ role: 'system', content: EN_THINK_REMINDER });
      }

      // ---- 请求结尾规整（L3 前缀缓存的关键，见 CONTINUE_HINT 注释）----
      // 每轮 LLM 调用前保证 history 末尾是 user 消息：网关对 tool/system 结尾的请求
      // 不建立前缀缓存（跨 run 首轮全 miss 的根因）；user 结尾缓存正常。
      // 固定内容 → 跨 run 逐字节一致 → 前缀纯追加延续。
      // H6 去重（按位置，非全局存在性）：末尾已是 user 消息（含【继续】本身）即跳过；
      // 不做全局 some() 查重——每个工具轮各注入一条是设计要求（维持请求以 user 结尾，
      // 全局去重会让第 2+ 个工具轮的请求以 assistant 结尾，破坏跨轮前缀延续）。
      if (llmCtx.history[llmCtx.history.length - 1]?.role !== 'user') {
        llmCtx.history.push({ role: 'user', content: CONTINUE_HINT });
      }

      // ---- L1 语义缓存：问答命中直接返回缓存答案（跳过 LLM 调用，零成本） ----
      // 命中条件：首轮（turn=0）且最后一条是真实 user 消息，问题 ≥8 字符
      // （"继续/总结一下"等短问题不参与，避免跨上下文误命中）。
      // 作用域安全：全局条目（纯问答，不依赖工具观察）任何会话可命中；
      // 会话条目（答案依赖本会话工具观察，如"这个文件里写了什么"）仅本会话可命中——
      // 因此即使历史已有工具消息也可安全查询：跨会话不串陈旧观察，会话内换措辞可命中。
      // promptKey = systemPrompt 指纹：人设/插件规则不同则隔离缓存空间。
      // 排除 before_llm 钩子注入的记忆/教训消息（【长期记忆】/【失败教训】），避免被当作"问题"
      const realUsers = llmCtx.history.filter((m) => m.role === 'user' && m.content
        && !String(m.content).startsWith('【长期记忆】') && !String(m.content).startsWith('【失败教训】') && !String(m.content).startsWith('【继续】'));
      const lastUser = realUsers[realUsers.length - 1];
      q = lastUser?.content ?? '';
      // 注入完成后、LLM 调用前：把发送序列增量同步入库（教训/记忆/提醒/上一轮工具消息）
      syncHistory();
      if (turn === 0 && q.length >= 8) {
        const promptKey = createHash('sha256').update(`${model}\0${systemPrompt}`).digest('hex').slice(0, 16);
        const cached = await this.kernel.cache.l1Get(q, promptKey, cacheScope);
        if (cached.hit && cached.answer) {
          // 命中学习：把当前措辞也回填（沿用来源条目的作用域，缓存簇同域扩展——同义改写可连续命中）
          void this.kernel.cache.l1Set(q, cached.answer, promptKey, cached.hitScope);
          const tIn = estimateTokens([...llmCtx.history.map((m) => m.content ?? '')].join('\n'));
          const tOut = estimateTokens(cached.answer);
          // 按 provider 价格估算本次节省的成本（缓存命中 = 省掉的 LLM 调用费用）
          const saved = (tIn / 1_000_000) * (provider.prices?.in ?? 0) + (tOut / 1_000_000) * (provider.prices?.out ?? 0);
          this.kernel.cache.recordSavedCost(saved);
          const step = this.kernel.trace.startStep({ traceId, turn, parentId: opts.parentStepId, type: 'cache_hit', name: 'L1', cacheKey: cached.key ?? '' });
          step.finish({ outputSummary: `L1 语义缓存命中：${cached.answer.slice(0, 60)}…`, tokensIn: tIn, tokensOut: tOut });
          yield { type: 'delta', text: cached.answer };
          yield {
            type: 'assistant_done',
            content: cached.answer,
            reasoning: '',
            usage: { input: tIn, output: tOut },
            cost: 0,
            cached: true,
          };
          return;
        }
      }

      // ---- 决策：LLM 调用（流式） ----
      // 失败恢复（内核拯救 LLM）：provider 链 = 主 provider + 备用 providers。
      // 每个 provider 瞬态失败自动重试 1 次，仍失败则换下一个备用（如主服务宕机/限流）。
      // LLM 作为用户只需要知道"系统换了备用路径"，不需要面对 error 500 胡乱思考。
      const providerChain = [provider, ...(opts.fallbackProviders ?? [])];
      let activeProvider: ProviderDef = provider;
      const step = this.kernel.trace.startStep({
        traceId, turn, type: 'llm_call', name: `${provider.id}/${model}`,
        parentId: opts.parentStepId,
      });
      let text = '';
      let reasoning = '';
      let usage: { input: number; output: number; cachedInput?: number; missInput?: number } | undefined;
      let collected: ToolCall[] = [];
      const handleChunk = (chunk: LLMChunk): { type: 'delta' | 'reasoning'; text: string } | null => {
        if (chunk.type === 'delta') {
          text += chunk.text;
          return { type: 'delta', text: chunk.text };
        }
        if (chunk.type === 'reasoning') {
          reasoning += chunk.text;
          return { type: 'reasoning', text: chunk.text };
        }
        if (chunk.type === 'tool_call') collected.push(chunk.toolCall);
        else if (chunk.type === 'usage') {
          usage = { input: chunk.input, output: chunk.output, cachedInput: chunk.cachedInput, missInput: chunk.missInput };
        }
        return null;
      };
      try {
        // 发送序列 = 文本化形态（L3 前缀缓存关键）：工具轮合并为 assistant 文本、
        // 恒以 user 结尾——与跨 run 组装（routes buildHistory）完全一致，
        // 消除 tool_calls 结构导致的网关缓存不稳定（run 内与跨 run 前缀逐字节延续）。
        const sendHistory = textualizeHistory(llmCtx.history);
        // L3 前缀复用统计：与上一轮调用共享的公共前缀 token（provider KV cache 直接命中）
        if (lastHistory) {
          const shared = sharedPrefixTokens(lastHistory, sendHistory);
          if (shared > 0) this.kernel.cache.recordPrefixRepeat(shared);
        }
        lastHistory = sendHistory.map((m) => ({ role: m.role, content: m.content }));
        let lastErr: unknown;
        for (let pi = 0; pi < providerChain.length; pi++) {
          activeProvider = providerChain[pi];
          let ok = false;
          for (let attempts = 0; attempts < 2 && !ok; attempts++) {
            if (attempts > 0) {
              // C1 重试状态残留：进入新 attempt 前清空上次失败流的半截状态
              // （text/reasoning/usage/collected 残留会导致残段拼进新回复、
              //  半截 tool_calls 被误执行、usage 计量错乱），并发 retry 事件
              // 告知前端作废当前渲染、重新累积
              text = '';
              reasoning = '';
              usage = undefined;
              collected = [];
              yield { type: 'retry' };
            }
            try {
              for await (const chunk of activeProvider.chat(sendHistory, { model, tools: llmCtx.tools, signal })) {
                const ev = handleChunk(chunk);
                if (ev) yield ev;
              }
              ok = true; // 成功结束
            } catch (err) {
              lastErr = err;
              if (attempts === 0) await new Promise((r) => setTimeout(r, 1200)); // 瞬态恢复缓冲
            }
          }
          if (ok) break;
          if (pi < providerChain.length - 1) {
            // 备用路径：同样先重置状态（换 provider 从头开始）+ retry 事件，
            // 再记录切换（可观察），继续下一个 provider
            text = '';
            reasoning = '';
            usage = undefined;
            collected = [];
            yield { type: 'retry' };
            this.kernel.trace.startStep({ traceId, turn, parentId: opts.parentStepId, type: 'system', name: 'failover' })
              .finish({ outputSummary: `${activeProvider.id} 连续失败，切换备用 ${providerChain[pi + 1].id}` });
          } else {
            throw lastErr; // 全部 provider 失败：抛给外层终止本轮
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.emitHook('agent.on_error', { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, error: errMsg });
        step.fail(errMsg);
        // 已发送序列仍同步入库（失败中断也不丢已观察的上下文；下 run 从这里继续能命中前缀）
        syncHistory();
        yield { type: 'error', error: errMsg };
        return;
      }
      const tIn = usage?.input ?? 0;
      const tOut = usage?.output ?? 0;
      totalIn += tIn;
      totalOut += tOut;
      const cost = estimateCost(activeProvider, tIn, tOut);
      totalCost += cost;
      // L3 真实命中核算：provider usage 确认的缓存命中 token——前缀缓存命中省的是
      // prefill 输入的钱（DeepSeek 50~120 倍价差 / OpenAI 最高省 90% / Anthropic 1/10 价），
      // 真实命中率 = cachedInput/(cachedInput+missInput)，本地估算不可替代。
      if (usage?.cachedInput != null && usage.cachedInput > 0) {
        this.kernel.cache.recordProviderCacheHit(usage.cachedInput, usage.missInput ?? 0);
        const saved = (usage.cachedInput / 1_000_000) * (activeProvider.prices?.in ?? 0);
        this.kernel.cache.recordSavedCost(saved);
      }
      // 思考预算统计：记录本轮 reasoning 长度并累计（下一轮 LLM 调用前消费）
      lastTurnReasoningTokens = estimateTokens(reasoning);
      totalReasoningTokens += lastTurnReasoningTokens;
      step.finish({
        outputSummary: text.slice(0, 200),
        tokensIn: tIn, tokensOut: tOut, tokensCached: usage?.cachedInput, cost,
      });

      // ---- 钩子：LLM 输出后（校验/观测；流出的输出暂不可改写） ----
      await this.emitHook('agent.after_llm', {
        traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad,
        content: text, reasoning, toolCalls: collected,
      });

      history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: collected.length ? collected : undefined,
      });

      // ---- 无工具调用：本轮结束 ----
      if (!collected.length) {
        // L1 缓存回填：最终答案按最后一条真实 user 消息入缓存（≥8 字符防短问题误命中）。
        // 作用域规则：本轮历史含工具消息 → 答案可能依赖本会话工具观察 → 会话级（仅本会话可命中，
        // 防跨会话复用陈旧观察）；纯问答（全程无工具）→ 全局可见，跨会话共享。
        // M2 加固：钩子注入的 system 消息（【长期记忆】/【失败教训】等，history[0] 之外
        // 的 system 均为注入）或超长问题（>2000 字符）同样意味着答案强依赖本会话上下文
        // → 强制会话级，不全局共享。
        if (q.length >= 8 && text.trim()) {
          const promptKey = createHash('sha256').update(`${model}\0${systemPrompt}`).digest('hex').slice(0, 16);
          const hasInjectedSystem = llmCtx.history.some((m, i) => i > 0 && m.role === 'system');
          const scope = (llmCtx.history.some((m) => m.role === 'tool') || hasInjectedSystem || q.length > 2000)
            ? cacheScope : undefined;
          void this.kernel.cache.l1Set(q, text, promptKey, scope);
        }
        // 任务画像（自适应性数据源）：harness 记录任务类型/轮数/成本/成败
        this.kernel.budget.recordTask({
          type: classifyTask(q),
          turns: turn + 1,
          cost: totalCost,
          failed: false,
          ts: Date.now(),
        });
        // 最终 assistant 消息同步入库（下 run 组装与该轮序列纯追加 → 前缓存延续）
        syncHistory();
        yield {
          type: 'assistant_done',
          content: text,
          reasoning,
          usage: { input: totalIn, output: totalOut },
          cost: totalCost,
        };
        return;
      }

      // ---- 动作：并行执行工具，结果回填 ----
      // H7：本轮内命中角色移交时先记录，工具全部执行回填后再统一移交（不留孤儿 tool_calls）
      // P1：并行工具执行（config agent.parallelTools 可关）——同一轮多个独立工具调用并发执行，
      // 显著缩短多工具轮次的墙钟时间（IO 型工具互不阻塞）。
      // 正确性保证：
      //  - 钩子（before_tool/after_tool）与历史回填保持串行 + 按 tool_call 顺序（L3 前缀字节级稳定）；
      //  - 只有 handler 本体并发（IO 密集的耗时部分）；
      //  - 审批/输出校验/自适应/移交逻辑按原顺序逐项处理（结果确定性）。
      let pendingHandoff: { role: string; objective: string } | null = null;
      const parallelTools = this.kernel.config.get<boolean>('agent.parallelTools', true);
      interface ResolvedTool {
        tc: ToolCall;
        tool?: ToolDef;
        args: unknown;
        toolArgs?: unknown;
        blocked?: boolean;
        blockReason?: string;
        tStep?: StepHandle;
        tctx?: ToolContext & { remainingBudget?: number };
        promise?: Promise<ToolResult>;
        deltas?: AsyncIterable<string>;
      }
      const resolved: ResolvedTool[] = [];
      // Phase A（串行，快）：解析每个 tool_call → 可执行描述符（before_tool 钩子/拦截判定）
      for (const tc of collected) {
        const tool = toolDefs.find((t) => t.name === tc.function.name);
        let args: unknown = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
        if (!tool) {
          resolved.push({ tc, args, blocked: true, blockReason: `工具不存在: ${tc.function.name}` });
          yield { type: 'tool_start', name: tc.function.name, args, callId: tc.id };
          continue;
        }
        yield { type: 'tool_start', name: tool.name, args, callId: tc.id };
        // ---- 钩子：工具执行前（权限策略 / 参数改写 / 拦截） ----
        const toolCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, tool: { name: tool.name, args } };
        await this.emitHook('agent.before_tool', toolCtx);
        if (toolCtx.blocked) {
          resolved.push({ tc, tool, args, blocked: true, blockReason: toolCtx.blockReason ?? '已被策略拦截' });
          continue;
        }
        const toolArgs = toolCtx.tool?.args ?? args;
        const tStep = this.kernel.trace.startStep({
          traceId, turn, type: 'tool_call', name: tool.name, inputSummary: summarize(toolArgs),
          parentId: opts.parentStepId,
        });
        // ToolContext 先构造（类型 = ToolContext ∪ 局部扩展字段，注解声明可携带扩展）：
        //  - H3 预算透传：remainingBudget = 主循环剩余预算（kernel ToolContext 契约尚未
        //    声明该字段，此处局部扩展——run_subagent/run_parallel 据此给子循环设 costBudget）
        const tctx: ToolContext & { remainingBudget?: number } = {
          traceId,
          turn,
          sessionId: opts.sessionId,
          stepId: tStep.id, // span 树：子任务（子代理/并行）挂到本工具步骤下
          sandboxRoot,
          signal,
          cache: this.kernel.cache,
          trace: this.kernel.trace,
          remainingBudget: opts.costBudget !== undefined ? Math.max(opts.costBudget - totalCost, 0) : undefined,
        };
        resolved.push({ tc, tool, args, toolArgs, tStep, tctx });
      }
      // Phase B：启动 handler（并行：全部启动后合并转发增量；串行：逐个启动并转发）
      const startTool = (r: ResolvedTool): void => {
        if (r.blocked || !r.tool || !r.tctx) return;
        if (r.tool.approval && !r.tctx.approved) {
          // C-S2 审批强制下沉执行器：声明 approval 的工具在未获批准前不进入 handler
          // （执行器不信任工具自觉）——直接构造 needsApproval 结果，走既有审批挂起流：
          // approval_required → 批准 → approved=true 重执行；拒绝 → governed 错误结果
          r.promise = Promise.resolve({
            ok: false,
            needsApproval: true,
            approvalSummary: `工具 ${r.tool.name} 声明需要用户审批。参数: ${summarize(r.toolArgs, 200)}`,
          });
          return;
        }
        // 流式执行（tool.delta）：工具通过 tctx.stream() 边执行边推送增量，
        // 主循环实时转发为 tool_delta 事件（前端工具卡片边跑边渲染）；
        // 不调用 stream 的工具零开销兼容（队列恒空，for await 立即结束）
        const { promise, deltas } = runToolStreaming(r.tool.handler, r.toolArgs, r.tctx, r.tool.timeoutMs ?? toolTimeout);
        r.promise = promise;
        r.deltas = deltas;
      };
      if (parallelTools) {
        for (const r of resolved) startTool(r);
        const streams = resolved
          .filter((r) => r.deltas && r.tool)
          .map((r) => ({ callId: r.tc.id, name: r.tool!.name, deltas: r.deltas! }));
        for await (const { callId, name, text } of mergeToolStreams(streams)) {
          yield { type: 'tool_delta', name, text, callId };
        }
      } else {
        for (const r of resolved) {
          startTool(r);
          if (r.deltas) {
            for await (const text of r.deltas) yield { type: 'tool_delta', name: r.tool!.name, text, callId: r.tc.id };
          }
        }
      }
      // Phase C（串行，确定性）：按 tool_call 顺序处理结果（审批/钩子/校验/回填）
      for (const r of resolved) {
        const { tc, tool, args } = r;
        if (!tool) {
          const missMsg = r.blockReason ?? `工具不存在: ${tc.function.name}`;
          history.push({ role: 'tool', tool_call_id: tc.id, content: missMsg });
          yield { type: 'tool_result', name: tc.function.name, summary: missMsg, ok: false, callId: tc.id };
          continue;
        }
        if (r.blocked) {
          const blockMsg = JSON.stringify({ ok: false, error: r.blockReason ?? '已被策略拦截' });
          history.push({ role: 'tool', tool_call_id: tc.id, content: blockMsg });
          yield { type: 'tool_result', name: tool.name, summary: r.blockReason ?? '已被策略拦截', ok: false, callId: tc.id };
          continue;
        }
        let result = await r.promise!;
        // ---- 审批挂起：工具请求用户审批时，执行器暂停等待（安全机制，不可绕过） ----
        // 审批全程入 Trace（approval 步骤）：挂起/批准/拒绝可追溯——"权力"的使用必须可审计
        if (!result.ok && result.needsApproval) {
          // L4：完整 UUID 作审批 ID（8 位截断有碰撞风险，审批键空间不可吝啬）
          const approvalId = randomUUID();
          const aStep = this.kernel.trace.startStep({
            traceId, turn, type: 'system', name: 'approval',
            inputSummary: `等待用户审批: ${tool.name} ${summarize(args)}`,
            parentId: opts.parentStepId,
          });
          yield {
            type: 'approval_required',
            approvalId,
            name: tool.name,
            summary: result.approvalSummary ?? result.error ?? '',
            args,
          };
          const approved = await new Promise<boolean>((resolve) => {
            // L5 定时器管理：保存引用、resolve 即 clearTimeout、创建后 unref()
            // （不阻止进程退出；批准/拒绝即时到达时定时器句柄立刻释放）
            const timer = setTimeout(() => {
              this.pendingApprovals.delete(approvalId);
              resolve(false);
            }, APPROVAL_TIMEOUT);
            timer.unref?.();
            this.pendingApprovals.set(approvalId, (v) => {
              clearTimeout(timer);
              resolve(v);
            });
          });
          if (!approved) {
            aStep.fail('用户拒绝或审批超时');
            r.tStep?.cancel();
            result = { ok: false, error: '用户拒绝了该操作', governed: true };
          } else {
            aStep.finish({ outputSummary: `已批准: ${tool.name}` });
            // 已批准：带 approved 标记重试执行（approved=true → 不再触发执行器侧审批拦截）
            const { promise, deltas } = runToolStreaming(tool.handler, args, { ...r.tctx!, approved: true, approvalId }, tool.timeoutMs ?? toolTimeout);
            for await (const text of deltas) {
              yield { type: 'tool_delta', name: tool.name, text, callId: tc.id };
            }
            result = await promise;
          }
        }
        // ---- 钩子：工具执行后（结果过滤/改写） ----
        const afterTCtx: AgentHookCtx = { traceId, turn, model, history, systemPrompt, tools: toolDefs, scratchpad, tool: { name: tool.name, args: r.toolArgs }, result };
        await this.emitHook('agent.after_tool', afterTCtx);
        const finalResult = afterTCtx.result ?? result;
        // ---- 输出校验（structured output 的机器侧）：声明了 outputSchema 的工具，
        // 结果结构不符即标注（不阻断——LLM 可拿原始结果自我修正，但"格式不符"必须被说破）。
        // 校验事件入 Trace：失败结构可追溯，LLM 不会对着坏格式继续编排。 ----
        let outputNote = '';
        if (finalResult.ok && tool.outputSchema) {
          const issues = validateAgainstSchema(finalResult.data, tool.outputSchema);
          if (issues.length > 0) {
            outputNote = `\n【输出校验】工具 ${tool.name} 的返回与声明格式不符（${issues.length} 项）：${issues.slice(0, 3).join('；')}${issues.length > 3 ? `；等 ${issues.length} 项` : ''}。请核对返回结构，或说明为何无法满足。`;
            this.kernel.trace.startStep({ traceId, turn, type: 'system', name: 'output-validate', parentId: opts.parentStepId })
              .fail(issues.slice(0, 3).join('；'), { outputSummary: `${tool.name} 返回结构校验失败（${issues.length} 项）` });
          }
        }
        if (finalResult.ok) {
          r.tStep?.finish({ outputSummary: summarize(finalResult.data) });
        } else {
          r.tStep?.fail(finalResult.error ?? '工具执行失败', { outputSummary: summarize(finalResult) });
        }

        // ---- C5 子代理成本并入熔断核算：run_subagent/run_parallel 在 data 中回传 ----
        // subagentCost 时并入本任务累计——下一轮成本熔断判定自然覆盖子代理开销，
        // assistant_done 的 cost（→ 会话累计成本 sessionCost）同样包含之。
        const subCost = (finalResult.data as { subagentCost?: { cost: number; tokensIn?: number; tokensOut?: number } } | null | undefined)
          ?.subagentCost;
        if (subCost && typeof subCost.cost === 'number' && Number.isFinite(subCost.cost)) {
          totalCost += subCost.cost;
          totalIn += subCost.tokensIn ?? 0;
          totalOut += subCost.tokensOut ?? 0;
        }

        // ---- 角色移交（handoff，OpenAI Agents SDK 的 maharness 版）----
        // H7：命中移交不再立即 return——本轮剩余 tool_calls 继续执行完并回填
        // （孤儿 assistant 消息不留未配对的 tool_calls），本轮结束后统一移交并终止外层循环。
        // 移交是"分工决策"而非错误——任务画像记为成功移交，不浪费后续轮次。
        if (finalResult.handoff && finalResult.handoff.role) {
          pendingHandoff = finalResult.handoff;
        }
        // 自适应性：连续工具失败 → harness 注入策略提示（管理"认知资源"，
        // 阻止 LLM 在错误路径上反复消耗 token）
        if (!finalResult.ok) {
          toolFailStreak++;
          if (toolFailStreak >= ADAPT_FAIL_STREAK && !adaptHintInjected) {
            adaptHintInjected = true;
            history.push({
              role: 'system',
              content: `【harness 自适应提示】检测到连续 ${ADAPT_FAIL_STREAK} 次工具失败：请停止重试，重新核对路径/参数/前提假设，或将任务拆小后继续；也可考虑用 run_subagent 委派独立子代理排查。`,
            });
          }
        } else {
          toolFailStreak = 0; // 成功一次即重置连败
        }
        // observation 完整性 v2：小结果全文回填；大结果存入结果存储、历史只留摘要+引用
        // （recall_tool_result 零副作用重读；v1 截断后只能重算工具才能拿回全文）
        const rawResult = JSON.stringify(finalResult);
        let content: string;
        if (rawResult.length > RESULT_STORE_THRESHOLD) {
          const sk = sessionKeyOf({ sessionId: opts.sessionId, traceId });
          resultStore.put(sk, tc.id, rawResult);
          content = `${summarize(finalResult, 300)}\n【工具结果已存入结果存储（id=${tc.id}，共 ${rawResult.length} 字符，仅回填摘要）；需要完整内容请用 recall_tool_result 按 id 重读，零副作用】`;
        } else if (rawResult.length > 4000) {
          content = `${rawResult.slice(0, 4000)}\n【结果已截断：共 ${rawResult.length} 字符，仅显示前 4000；需要完整内容请用工具定向读取】`;
        } else {
          content = rawResult;
        }
        history.push({ role: 'tool', tool_call_id: tc.id, content: content + outputNote });
        yield { type: 'tool_result', name: tool.name, summary: summarize(finalResult), ok: !!finalResult.ok, stored: rawResult.length > RESULT_STORE_THRESHOLD, callId: tc.id };
      }

      // ---- H7 移交收尾：本轮工具全部执行回填后移交并终止（控制权交给目标角色） ----
      if (pendingHandoff) {
        history.push({ role: 'system', content: `【角色移交】任务已移交给「${pendingHandoff.role}」：${pendingHandoff.objective}` });
        this.kernel.budget.recordTask({
          type: classifyTask(q), turns: turn + 1, cost: totalCost, failed: false, ts: Date.now(),
        });
        syncHistory();
        yield { type: 'handoff', role: pendingHandoff.role, objective: pendingHandoff.objective };
        return;
      }

      // ---- 断点（checkpoint）：本轮含工具回填的完整历史已就绪 → 持久化，中断可从此恢复 ----
      // 时机：工具执行完、下轮 LLM 调用前（恢复 = 从这个字节级相同的历史继续，L3 前缀不丢）。
      // 无工具调用的最终轮不存（任务已完成，无需恢复）。
      opts.onCheckpoint?.(turn, history);
    }

    syncHistory(); // 超限路径：最后一轮的工具/助理消息一并入库，续跑可命中前缀
    await this.emitHook('agent.on_error', { traceId, turn: maxTurns, model, history, systemPrompt, tools: toolDefs, scratchpad, error: `超过最大轮数 ${maxTurns}，已停止` });
    // 任务画像：截断/失败也算一次任务记录（失败率是自适应策略的输入）
    const lastUserMsg = [...history].reverse()
      .find((m) => m.role === 'user' && m.content && !String(m.content).startsWith('【长期记忆】') && !String(m.content).startsWith('【失败教训】') && !String(m.content).startsWith('【继续】'));
    this.kernel.budget.recordTask({
      type: classifyTask(lastUserMsg?.content ?? ''),
      turns: maxTurns,
      cost: totalCost,
      failed: true,
      ts: Date.now(),
    });
    // 轮数上限不是任务失败：已完成的工作与断点均保留，可继续推进
    yield { type: 'error', error: `本任务已达到轮数上限（${maxTurns} 轮）——已完成的工作已保存在会话中，可继续发送消息推进，或将任务拆小；长任务可调高 agent.maxTurns 配置` };
  }
}

/** 摘要化（Trace 用，防大对象撑爆记录） */
function summarize(v: unknown, max = 300): string {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Trace 查询辅助（供 server 使用） */
export function queryTraceSteps(steps: TraceStep[], traceId: string): TraceStep[] {
  return steps.filter((s) => s.traceId === traceId);
}
