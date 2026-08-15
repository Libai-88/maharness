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
  enabled?: boolean;        // 默认 true；false = 声明停用（不自动启动）
  requires?: string[];      // 依赖的插件 id（先加载）
  lazy?: boolean;           // 默认 false；true = 惰性加载（注册可见但默认不启动，
                            // 能力不进入上下文；LLM 需要时用 enable_plugin 激活，类似 OS 驱动按需加载）
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
  /** 认知资源管理（harness 管，不是 LLM 自觉）：重工具配额 + 任务画像 */
  budget: {
    subagentQuota(): { allowed: boolean; remaining: number; reason?: string };
    consumeSubagent(): void;
    recordTask(record: { type: string; turns: number; cost: number; failed: boolean; ts: number }): void;
    taskProfile(): { type: string; count: number; avgTurns: number; avgCost: number; failRate: number }[];
  };
  plugins: {
    capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[];
    /** 生命周期管理（dynamic capability loading）：按需激活/停用插件 */
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    list(): { manifest: PluginManifest; state: string; error?: string }[];
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
  l2Delete(key: string): void;
  /** 按命名空间批量失效（key 前缀 = parts[0]）：写操作后失效受影响工具的缓存，不误伤其他工具 */
  l2DeleteNamespace(ns: string): void;
  makeKey(parts: string[]): string;
  setEmbeddingFn(fn: (text: string) => Promise<number[]>): void;
  /** L1 语义缓存：相同/近似问题命中直接返回缓存答案（跳过 LLM 调用）；
   *  promptKey 为 systemPrompt 指纹，人设/插件规则不同则隔离缓存空间；
   *  scope 为会话级隔离键（如 traceId）：传入时仅命中「该会话自产」的答案，
   *  全局答案对所有会话可见（纯问答产物），会话答案只对本会话可见（依赖工具观察的产物）。
   *  hitScope：命中条目的作用域，供命中学习回填沿用。 */
  l1Get(question: string, promptKey?: string, scope?: string): Promise<{ hit: boolean; answer?: string; key?: string; hitScope?: string }>;
  l1Set(question: string, answer: string, promptKey?: string, scope?: string): Promise<void>;
  /** L3 前缀复用统计（估算口径）：记录本轮与上轮 LLM 调用公共前缀的 token 数 */
  recordPrefixRepeat(tokens: number): void;
  /** L3 真实命中统计：provider usage 确认的缓存命中/未命中 token（归一化后）
   *  ——真实命中率只能由 provider 说了算，本地估算不可替代 */
  recordProviderCacheHit(hitTokens: number, missTokens: number): void;
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
  | { kind: 'context'; context: ContextDef }
  | { kind: 'api'; api: ApiDef };

/**
 * API 能力：插件向 Web 前端贡献 REST 端点（「前端是插件的一部分」的数据通道）。
 * 挂载到 /api/plugins/<pluginId>/<mount>/...，热重载后动态取当前实例（无需重启）。
 * 约定：提供 GET /panel 返回 { title, html } 时，前端插件详情页自动渲染为插件面板。
 */
export interface ApiDef {
  mount: string;
  /** server 层断言为 express 中间件 (req, res, next)；插件侧可用任意兼容签名 */
  router: (req: never, res: never, next?: never) => void;
}

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
  /** 输出格式描述：返回结构的显式说明（减少"靠猜/试错"型幻觉），注入 LLM */
  output?: string;
  /** 独立超时（毫秒）：重工具（如 run_subagent 内部多轮）需要比默认 30s 更长的执行窗口 */
  timeoutMs?: number;
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
  | {
      type: 'usage';
      input: number;           // 总输入 token（含缓存命中部分）
      output: number;
      /** 本次请求中 provider 前缀缓存真实命中的输入 token（归一化各厂商字段）：
       *  DeepSeek prompt_cache_hit_tokens / OpenAI·智谱 prompt_tokens_details.cached_tokens /
       *  Anthropic cache_read_input_tokens。无该字段（provider 不支持）时为 undefined。 */
      cachedInput?: number;
      /** 本次请求中未命中缓存的输入 token（真实命中率 = cachedInput/(cachedInput+missInput)） */
      missInput?: number;
    }
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
  /** 本次 LLM 调用中 provider 前缀缓存真实命中的输入 token（usage 归一化后） */
  tokensCached?: number;
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
  /** L3 前缀复用（本地估算口径）：相邻 LLM 调用公共前缀的 token 数——无 provider 反馈时的降级度量 */
  l3Hits: number;
  l3Tokens: number;
  /** L3 前缀缓存（真实口径）：provider usage 确认的缓存命中 token 数。
   *  真实命中率 = l3RealTokens / (l3RealTokens + l3RealMissTokens)；
   *  与估算口径(l3Tokens)的差距 = provider TTL 过期 / 路由抖动 / 不支持缓存 造成的损耗。 */
  l3RealHits: number;
  l3RealTokens: number;
  l3RealMissTokens: number;
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
