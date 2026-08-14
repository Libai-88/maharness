// ui/src/types.ts —— 前端共享类型
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
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;       // 思考过程（推理模型）
  streaming?: boolean;
  tools?: ToolStep[];
  error?: string;
  usage?: { input: number; output: number };
  cost?: number;
}

export interface ToolStep {
  name: string;
  args?: unknown;
  summary?: string;
  ok?: boolean;
  status: 'running' | 'done' | 'error';
}
