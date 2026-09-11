/**
 * kernel/loop.ts —— Agent 执行循环的契约（内核与循环实现之间的接口）
 *
 * 第一性原理：**循环的形态由实现决定，循环的接口由内核承诺**。
 * 把接口留在 core/chat 内部，内核就无法在不反向依赖插件的前提下声明
 * 「谁来提供循环」；把它放进内核，插件替换循环才是真正的可替换——
 * 任何实现（ReAct / Reflexion / 两段式 / 带验证器的循环）只要满足本契约即可接管
 * `service:runner`，顶层对话、子代理、并行三条路径无需改动。
 *
 * 本文件只放【形状】（类型与常量），不放行为：行为归默认实现（core/chat/agent.ts）。
 */
import type {
  AgentRunSummary, KernelLike, LLMMessage, PluginBus, ProviderDef, ToolCall, ToolDef, ToolResult,
} from './types';

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
  /** agent.before_tool：用户策略规则显式放行本次调用（免审批），执行器据此跳过审批门并留痕 */
  policyApproved?: boolean;
  tool?: { name: string; args: unknown };
  content?: string;                     // after_llm：模型输出（观测）
  reasoning?: string;
  toolCalls?: ToolCall[];
  result?: ToolResult;                  // after_tool：结果（可改写）
  error?: string;                       // on_error
  reason?: string;                      // agent.stopped：停止原因（如 'max_turns'）
}

/** 执行循环的逐步事件流（决策→行动→观察 的播报）。可辨识联合：消费方按 type 收窄。 */
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  /** id = tool_call_id：前端靠它把 start/result 精确配对成同一张卡（同名并发调用不会串卡） */
  | { type: 'tool_start'; id?: string; name: string; args: unknown }
  | { type: 'tool_result'; id?: string; name: string; summary: string; ok: boolean; stored?: boolean }
  | { type: 'approval_required'; approvalId: string; name: string; summary: string; args: unknown }
  | { type: 'assistant_done'; content: string; reasoning: string; usage: { input: number; output: number }; cost: number; cached?: boolean }
  | { type: 'budget_hit'; cost: number; budget: number }
  | { type: 'handoff'; role: string; objective: string }
  /** provider 重试（内层瞬态重试 / 外层切换备用）：重试前执行器已清空上次失败流的
   *  半截状态（C1），前端收到本事件应作废当前流式渲染、从零重新累积。
   *  reason 让人话提示能对上现实：同线路重试 / 换线路 / 叙述化纠偏，三者观感不同。 */
  | { type: 'retry'; reason: 'attempt' | 'failover' | 'narration'; detail?: string }
  /** kind 让前端能区分"用户自己按了停止"与"真出错了"——aborted 不该画成红色报错 */
  | { type: 'error'; error: string; kind?: 'aborted' | 'budget' | 'max-turns' | 'policy' | 'upstream' };

/** 一次 run 的全部输入（循环实现的入参契约） */
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

/** 执行循环实例：run 返回事件流（决策→行动→观察 的逐步播报），approveApproval 响应挂起审批 */
export interface AgentLoop {
  run(opts: RunOptions): AsyncGenerator<AgentEvent>;
  /** 共享审批板的批准/拒绝入口（子循环的审批同样经此可达） */
  approveApproval(approvalId: string, approved: boolean): boolean;
}

/** 执行循环工厂：`service:runner` 的契约。
 *  工厂而非单例——子代理/并行需要独立循环实例（独立 traceId/history/scratchpad）。 */
export type RunnerFactory = (kernel: KernelLike, bus: PluginBus) => AgentLoop;

/** 服务键常量：键名是契约的一部分，字符串散落各处会漂移 */
export const SERVICE_KEYS = {
  /** Agent 执行循环工厂（可被插件整体替换） */
  runner: 'service:runner',
  /** 三层缓存（内核内置实现可被接管） */
  cache: 'service:cache',
  /** 可观测性（内核内置实现可被接管） */
  trace: 'service:trace',
  /** 认知资源管理（内核内置实现可被接管） */
  budget: 'service:budget',
} as const;

/**
 * 解析执行循环工厂（`service:runner` 的绑定值就是工厂本身）。
 *
 * 这是「循环可替换」的唯一取用口——顶层对话、子代理、并行三条路径都经此拿工厂
 * 再造循环，因此替换一次即全局生效，不会出现「顶层换了、子代理还在跑旧循环」的割裂。
 * 返回 undefined 表示没有插件提供循环（如对话引擎插件被停用）：调用方据此降级报错，
 * 而不是崩溃或静默用旧实现。
 */
export function resolveRunnerFactory(kernel: KernelLike): RunnerFactory | undefined {
  return kernel.plugins.resolveService(SERVICE_KEYS.runner) as RunnerFactory | undefined;
}

/**
 * 造一个执行循环实例（工厂 + 内核/总线一步到位）。
 * 调用方只需 `const loop = makeRunner(kernel)`；无提供者时返回 undefined（调用方降级）。
 */
export function makeRunner(kernel: KernelLike, bus?: PluginBus): AgentLoop | undefined {
  const factory = resolveRunnerFactory(kernel);
  if (!factory) return undefined;
  // bus 缺省时取内核总线实体（KernelLike 不声明 bus）：插件侧通常直接传 ctx.bus
  return factory(kernel, bus ?? (kernel as unknown as { bus: PluginBus }).bus);
}

/** 循环结束时的终态摘要（agent.run.finished 事件的负载类型别名，便于实现方引用） */
export type { AgentRunSummary };
