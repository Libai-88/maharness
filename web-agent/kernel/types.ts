/**
 * kernel/types.ts —— 内核全局契约
 * 事件、插件、工具、Trace、LLM 的类型定义。所有模块共享，禁止循环依赖。
 */

// ============ 事件 ============

export interface Event<T = unknown> {
  type: string;          // 域.对象.动作，如 agent.turn.started
  traceId?: string;      // 关联执行轨迹
  ts: number;            // 时间戳(ms)
  data?: T;
}

export type EventListener = (e: Event) => void | Promise<void>;

// ============ 插件 ============

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;            // 入口文件（相对插件目录）
  enabled?: boolean;        // 默认 true
  requires?: string[];      // 依赖的插件 id（先加载）
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  onLoad?(ctx: PluginContext): void | Promise<void>;    // 注册能力
  onStart?(ctx: PluginContext): void | Promise<void>;   // 启动
  onStop?(ctx: PluginContext): void | Promise<void>;    // 热停
  onUnload?(ctx: PluginContext): void | Promise<void>;  // 卸载
}

/** 内核最小接口（插件可见范围）：禁止插件触及内核内部实现 */
export interface KernelLike {
  rootDir: string;
  config: ConfigLike;
  trace: TraceLike;
  cache: CacheLike;
  plugins: {
    capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[];
  };
}

/** 插件运行时上下文：插件与内核通信的唯一句柄 */
export interface PluginContext {
  pluginId: string;
  kernel: KernelLike;
  bus: EventBusLike;
  config: ConfigLike;
  trace: TraceLike;
  cache: CacheLike;
  register(cap: Capability): void;
  logger: Logger;
}

export interface EventBusLike {
  on(event: string, listener: EventListener, priority?: number): () => void;
  emit(e: Event): void;
  emitAsync(e: Event): Promise<void>;
}

export interface ConfigLike {
  get<T>(key: string, def?: T): T;
  set(key: string, value: unknown): void;
  section(pluginId: string): Record<string, unknown>;
}

export interface TraceLike {
  startStep(partial: TraceStepInit): StepHandle;
  stats(): TraceStats;
}

export interface CacheLike {
  l2Get(key: string): { hit: boolean; value?: unknown };
  l2Set(key: string, value: unknown, ttlMs?: number): void;
  makeKey(parts: string[]): string;
  setEmbeddingFn(fn: (text: string) => Promise<number[]>): void;
  /** L1 语义缓存：相同/近似问题命中直接返回缓存答案（跳过 LLM 调用）；
   *  promptKey 为 systemPrompt 指纹，人设/插件规则不同则隔离缓存空间 */
  l1Get(question: string, promptKey?: string): Promise<{ hit: boolean; answer?: string; key?: string }>;
  l1Set(question: string, answer: string, promptKey?: string): Promise<void>;
  /** L3 prompt 前缀复用统计：记录本轮与上轮 LLM 调用公共前缀的 token 数 */
  recordPrefixRepeat(tokens: number): void;
  /** 累计缓存节省成本（由命中方按 provider 价格估算报告） */
  recordSavedCost(cost: number): void;
  clear(): void;
  stats(): CacheStats;
}

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
}

// ============ 能力（插件注册的能力类型） ============

export type Capability =
  | { kind: 'tool'; tool: ToolDef }
  | { kind: 'listener'; event: string; listener: EventListener }
  | { kind: 'command'; command: CommandDef }
  | { kind: 'provider'; provider: ProviderDef }
  | { kind: 'service'; service: ServiceDef }
  | { kind: 'persona'; persona: PersonaDef }
  | { kind: 'context'; context: ContextDef };

/** 服务能力：插件对外暴露的实例（如 chat 服务），server 层通过 capability 获取，不依赖插件内部实现 */
export interface ServiceDef {
  id: string;
  instance: unknown;
}

/** 人设能力：插件向 LLM 贡献的系统提示词片段（随插件加载/卸载自动增减） */
export interface PersonaDef {
  id: string;
  name: string;
  description: string;
  content: string;          // 提示词片段（自然语言规则）
  priority?: number;        // 排序，大者在前（默认 0）
}

// ---------- 工具 ----------

export interface ToolDef {
  name: string;
  description: string;      // 给 LLM 看的能力说明
  parameters: Record<string, unknown>; // JSONSchema
  /** 风险等级：high 的工具默认需要审批（harness 可在审批策略中自动挂起） */
  risk?: 'low' | 'medium' | 'high';
  /** 成本提示（注入 LLM：管理"认知资源"——简单问题不召唤重工具） */
  costHint?: 'low' | 'medium' | 'high';
  /** 明确要求审批（与 needsApproval 运行时返回值互补：声明式 vs 运行时） */
  approval?: boolean;
  /** 使用限制（如文件大小/并发/频率），注入 LLM 减少幻觉 */
  limits?: string;
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Context Provider：插件不只是 tool provider，也可以是 context provider。
 *  按需向 LLM 注入上下文（区别于无脑塞进 system prompt）：
 *  harness 在每轮 LLM 调用前收集全部 context 能力，按 weight 排序注入，
 *  受总预算（contextMaxTokens）约束；contentFn 可依据当前任务动态返回内容。 */
export interface ContextDef {
  id: string;
  description: string;      // 给人类/harness 看（registry 可查）
  /** 注入优先级（越大越靠前，默认 0） */
  weight?: number;
  /** 动态内容：返回 null/空串则不注入（按任务按需出现） */
  contentFn(ctx: { history: LLMMessage[]; systemPrompt: string; scratchpad: Record<string, unknown> }): string | null;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;           // 成功时返回给 LLM 的结构化结果
  error?: string;           // 失败原因（会原样回给 LLM）
  cacheable?: boolean;      // 是否允许 L2 缓存（默认 true）
  needsApproval?: boolean;  // 需用户审批（执行器级挂起，不可绕过）
  approvalSummary?: string; // 审批卡片摘要（needsApproval 时必填）
}

export interface ToolContext {
  traceId?: string;
  turn: number;
  sandboxRoot: string;      // 文件类工具的安全边界
  signal?: AbortSignal;
  cache: CacheLike;         // 工具自管理时效性缓存（L2）
  trace: TraceLike;         // 工具可自行记录 cache_hit 等步骤
  approved?: boolean;       // 已通过用户审批（审批后重试时置 true）
  approvalId?: string;      // 本次审批 ID
}

export interface CommandDef {
  name: string;
  description: string;
  handler(args: string[]): Promise<string> | string;
}

// ---------- LLM Provider（v1 内置 OpenAI 兼容，预留多实现） ----------

export interface ProviderDef {
  id: string;               // 如 deepseek
  label: string;            // 显示名
  defaultModel: string;
  prices?: { in: number; out: number };  // USD / 百万 token，用于成本核算
  chat(messages: LLMMessage[], opts: ChatOptions): AsyncIterable<LLMChunk>;
}

// ============ LLM ============

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments 为 JSON 字符串
}

export interface LLMMessage {
  role: LLMRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type LLMChunk =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }   // 推理模型思考过程（如 deepseek reasoning_content）
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done' };

export interface ChatOptions {
  model: string;
  tools?: ToolDef[];        // 传给 LLM 的工具定义
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

// ============ Trace ============

export type StepType = 'llm_call' | 'tool_call' | 'cache_hit' | 'user_msg' | 'system';

export type StepStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TraceStepInit {
  traceId: string;
  turn: number;
  type: StepType;
  name?: string;
  inputSummary?: string;
  cacheLayer?: 'L1' | 'L2' | 'L3';
  cacheKey?: string;
}

export interface TraceStep extends TraceStepInit {
  id: string;
  status: StepStatus;
  ts: number;               // 开始时间
  endTs?: number;
  durationMs?: number;
  outputSummary?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  error?: string;
}

export interface StepHandle {
  /** 正常收尾：补充输出摘要/用量/成本 */
  finish(extra?: Partial<TraceStep>): void;
  /** 失败收尾 */
  fail(error: string, extra?: Partial<TraceStep>): void;
  /** 取消收尾 */
  cancel(): void;
}

export interface TraceStats {
  steps: number;
  llmCalls: number;
  toolCalls: number;
  cacheHits: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
}

// ============ 缓存 ============

export interface CacheStats {
  l2Hits: number;
  l2Misses: number;
  l1Hits: number;
  l1Misses: number;
  /** L3 prompt 前缀复用：相邻 LLM 调用公共前缀的累计 token 数（provider KV cache 直接命中） */
  l3Hits: number;
  l3Tokens: number;
  savedCost: number;
}

// ============ 会话/消息（数据模型） ============

export interface Session {
  id: string;
  title: string;
  model: string;
  mode: string;             // normal / plan / goal（会话级 Agent 模式）
  planPending: number;      // 计划模式状态机：0 无限制 / 1 待出计划 / 2 已出计划待确认
  archived: number;         // 0/1 归档（会话管理）
  pinned: number;           // 0/1 置顶标记（会话管理）
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: LLMRole;
  content: string | null;
  reasoning?: string;          // 推理模型思考过程（可选）
  toolCalls?: ToolCall[];
  toolCallId?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  traceId?: string;
  createdAt: number;
}
