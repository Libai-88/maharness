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
  | { kind: 'persona'; persona: PersonaDef };

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
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;           // 成功时返回给 LLM 的结构化结果
  error?: string;           // 失败原因（会原样回给 LLM）
  cacheable?: boolean;      // 是否允许 L2 缓存（默认 true）
}

export interface ToolContext {
  traceId?: string;
  turn: number;
  sandboxRoot: string;      // 文件类工具的安全边界
  signal?: AbortSignal;
  cache: CacheLike;         // 工具自管理时效性缓存（L2）
  trace: TraceLike;         // 工具可自行记录 cache_hit 等步骤
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
  savedCost: number;
}

// ============ 会话/消息（数据模型） ============

export interface Session {
  id: string;
  title: string;
  model: string;
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
