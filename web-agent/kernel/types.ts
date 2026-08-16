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
  /** 声明本插件提供的服务键（coeffect provide 的声明式预览，供依赖图谱/插件面板可查；
   *  实际提供以运行时 ctx.provide 为准——声明只读，动态提供才算数） */
  provides?: string[];
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
    /** 原子配额消耗（check-and-consume 一步完成，消除 TOCTOU）：per-session 池 + 进程级总上限 */
    consumeSubagentQuota(sessionId: string): { allowed: boolean; remaining: number };
    recordTask(record: { type: string; turns: number; cost: number; failed: boolean; ts: number }): void;
    taskProfile(): { type: string; count: number; avgTurns: number; avgCost: number; failRate: number }[];
  };
  plugins: {
    capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[];
    /** 生命周期管理（dynamic capability loading）：按需激活/停用插件 */
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    list(): { manifest: PluginManifest; state: string; error?: string }[];
    /** 服务共效应解析（非插件消费方用，如 server 层）：key = 'service:<id>' 或自定义提供键 */
    resolveService(key: string): unknown | undefined;
  };
}

/** 插件运行时上下文：插件与内核通信的唯一句柄
 *  时空可组合性契约（借鉴 Cordis）：插件通过 ctx 做的一切都会留下逆元，
 *  卸载时按 LIFO 自动完全恢复——清理正确性由运行时保证，而非作者勤勉。 */
export interface PluginContext {
  pluginId: string;
  kernel: KernelLike;
  bus: EventBusLike;
  config: ConfigLike;
  trace: TraceLike;
  cache: CacheLike;
  /** 注册能力。返回 unregister：可单独撤销；未手动撤销时卸载自动回收（可逆效应） */
  register(cap: Capability): () => void;
  /** 事件订阅（自动退订：卸载时自动取消，杜绝监听器泄漏——旧 API ctx.bus.on 的替代） */
  on(event: string, listener: EventListener, priority?: number): () => void;
  /** 提供服务绑定（可逆效应：卸载时自动撤回并通知依赖方停用） */
  provide(key: string, value: unknown): () => void;
  /** 反应性依赖注入（coeffect）：解析 key 当前绑定并订阅变化。
   *  依赖方在提供者激活/停用/替换时收到通知——"依赖不可用则保持等待，出现即激活"。 */
  inject(key: string, onChange?: (value: unknown | undefined) => void): { value: unknown | undefined; stop: () => void };
  /** 能力集反应性订阅：某类能力集合变化时回调（如 persona 集变化 → 自动重装系统提示词） */
  onCapabilities(kind: Capability['kind'], cb: () => void): () => void;
  /** 声明式配置对账：配置键变化时回调（自动退订；替代手写 config.changed 监听） */
  watchConfig(key: string, cb: (value: unknown) => void): () => void;
  /** 原始可逆效应：执行 callback 并登记逆元（跨系统边界操作由调用方自备补偿） */
  effect<T>(callback: () => T | Promise<T>, makeInverse: (value: T) => () => void | Promise<void>): Promise<void>;
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
  /** 声明式配置对账：订阅配置键变化（支持 'a.b.*' 通配符），返回退订函数 */
  watch(pattern: string, cb: (key: string, value: unknown) => void): () => void;
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
  /** 失效指定会话的全部 L1 条目（会话级隔离键命中）：会话内写入文件成功后调用，
   *  使依赖旧观察的答案过期——同一问题应重新观察，而非复用陈旧事实 */
  l1InvalidateSession(sessionId: string): void;
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
  | { kind: 'role'; role: RoleDef }
  | { kind: 'api'; api: ApiDef };

/**
 * 角色能力（handoff 移交的目标）：角色 = 专业化分工的 systemPrompt + 工具集。
 * 任何插件可注册角色（万物皆插件：角色也是插件）。执行器识别 handoff_to 工具
 * 的返回 → 终止当前循环 → 会话记录新角色 → 后续对话由新角色接管（提示词/工具集
 * 热切换，无需重启）。角色注册表动态枚举进 handoff_to 工具参数。
 */
export interface RoleDef {
  id: string;               // 如 main / planner（handoff_to 的 role 参数枚举值）
  name: string;             // 显示名（前端/日志）
  description: string;      // 角色职责说明（进 handoff_to 工具描述，LLM 据此决定移交对象）
  systemPrompt: string;     // 角色主提示词（置于通用规则之前——系统提示词越靠前引导力越强）
  /** 角色可用工具集：all=全部（默认）；readonly=只读白名单（侦查/搜索/记忆，不改变世界） */
  tools?: 'all' | 'readonly';
}

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
  /** 输出格式的机器校验（JSONSchema 子集）：工具执行后对 result.data 做结构校验。
   *  校验失败不阻断（LLM 可拿到原始结果自我修正），但回填内容会附【输出校验】标注，
   *  且校验事件入 Trace——"成败机器可判"从工具返回值延伸到输出结构。 */
  outputSchema?: Record<string, unknown>;
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
  /** 审批/治理类拦截标记：本次"失败"是用户拒绝/策略拦截，不是工具或执行错误——
   *  memory 插件据此不把"用户拒绝"记为失败教训（拒绝是合法终态，不是教训） */
  governed?: boolean;
  /** 角色移交（handoff）：工具返回此字段 → 执行器立即终止本轮循环并移交会话控制权。
   *  由 handoff_to 工具使用——角色 id 必须存在于角色注册表。 */
  handoff?: { role: string; objective: string };
}

export interface ToolContext {
  traceId?: string;
  turn: number;
  /** 当前会话 ID（server 层透传）：工具可据此把状态挂到具体会话（如 todo 插件的会话级 to do list） */
  sessionId?: string;
  /** 当前工具调用的 Trace 步骤 id：子任务（子代理/并行）用它挂 parentId，形成 span 树 */
  stepId?: string;
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
  /** 父步骤 id（span 树）：子代理/并行等子任务的步骤挂到调用方工具步骤下，
   *  跨 traceId 也能从父轨迹下钻到子轨迹（OpenAI tracing 的 span 层级） */
  parentId?: string;
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
  /** 本步骤的 id（span 树）：子任务（子代理/并行）用它挂 parentId 下钻 */
  id: string;
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
  /** JSONL 异步落盘失败次数（不再静默：首次失败 console.warn，此处累计可观测） */
  writeFailures: number;
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
  /** 当前接管角色（handoff）：空 = 主代理（默认）；有值 = 该角色提示词/工具集接管会话 */
  role?: string;
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
