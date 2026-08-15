// ui/src/types.ts —— 前端共享类型
export interface Session {
  id: string;
  title: string;
  model: string;
  mode: string;
  planPending: number;
  archived: number;
  pinned: number;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  reasoning?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  model: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: boolean;
  apiKeyMasked: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderForm {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priceIn?: string;
  priceOut?: string;
}

export interface PersonaInfo {
  id: string;
  name: string;
  content: string;
  enabled: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface BusEvent {
  type: string;
  traceId?: string;
  data?: unknown;
  ts: number;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: string;
  caps: string[];
  error?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user';
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  current: boolean;
}

export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
}

/** 斜杠命令（命令面板渲染用） */
export interface CommandInfo {
  name: string;
  usage: string;
  description: string;
  source: 'builtin' | 'plugin';
}

/** 统计面板：全局概览 / 进程 / 上下文用量 / 缓存命中率 */
export interface StatsInfo {
  overview: {
    sessions: number;
    messages: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    truncations: number;
    cacheHitSteps: number;
  };
  process: {
    steps: number;
    llmCalls: number;
    toolCalls: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  };
  context: {
    maxTokens: number;
    perSession: {
      id: string;
      title: string;
      mode: string;
      messages: number;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      estimatedTokens: number;
      contextBudget: number;
      contextUsage: number;
      truncated: boolean;
      truncations: number;
    }[];
  };
  /** 任务画像（harness 自适应数据源）：类型 → 次数/平均轮数/成本/失败率 */
  taskProfile: { type: string; count: number; avgTurns: number; avgCost: number; failRate: number }[];
  cache: {
    l1Enabled: boolean;
    l1: { hits: number; misses: number; rate: number };
    l2: { hits: number; misses: number; rate: number };
    /** L3 双口径：hits/tokens 为本地估算（相邻调用公共前缀）；real* 为 provider usage 确认的真实命中 */
    l3: {
      hits: number; tokens: number;
      realHits: number; realTokens: number; realMissTokens: number; realRate: number;
    };
    savedCost: number;
    overall: { served: number; total: number; rate: number };
  };
}

export interface TraceStep {
  id: string;
  traceId: string;
  turn: number;
  type: 'llm_call' | 'tool_call' | 'cache_hit' | 'user_msg' | 'system';
  name?: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  cacheKey?: string;
  cacheLayer?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  ts: number;
  endTs?: number;
}

// 前端会话中的本地消息（含流式状态与工具调用过程）
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';   // system = 斜杠命令等系统提示
  content: string;
  reasoning?: string;       // 思考过程（推理模型）
  streaming?: boolean;
  tools?: ToolStep[];
  error?: string;
  usage?: { input: number; output: number };
  cost?: number;
  cached?: boolean;         // L1 语义缓存命中（零 LLM 成本直接回答）
}

export interface ToolStep {
  name: string;
  args?: unknown;
  summary?: string;
  ok?: boolean;
  status: 'running' | 'done' | 'error';
  /** 执行开始时间戳（前端计时用） */
  startedAt?: number;
  /** 执行耗时（毫秒，onToolResult 结算） */
  durationMs?: number;
}

export interface ApprovalItem {
  id: string;
  name: string;
  summary: string;
}

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface PlanState {
  objective: string;
  steps: { title: string; status: StepStatus; note?: string }[];
  current: number;
  completed: boolean;
  createdAt: number;
}
