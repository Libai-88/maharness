// 生成物，请勿手改。源：contracts/api.ts（node scripts/check-contracts.mjs --write）

/**
 * contracts/api.ts —— 前端与后端的 API 线上形状唯一声明处（ADR 0009）
 *
 * 硬约束：本文件**只允许**包含类型与常量，不得 import 任何模块。
 * 原因：`ui/src/generated/contracts.ts` 是它的逐字副本，一旦引入 import，
 * 前端就会被动拖上服务端依赖（node 内置模块、数据库）。
 *
 * 服务端对齐由 `server/tests/contracts.spec.ts` 保底：真实响应样本必须可以赋给这里的类型。
 */

/** 会话行（/api/sessions，含侧栏派生摘要字段）。 */
export interface Session {
  id: string;
  /** 会话所属租户（默认 default；单用户模式不改变现有行为） */
  tenantId?: string;
  title: string;
  model: string;
  /** model 所属 provider id（发送/恢复时需与 model 匹配） */
  provider: string;
  /** normal / plan / goal：会话级 Agent 模式 */
  mode: string;
  /** 计划模式进度：0 未提出 / 1 待确认 / 2 已确认 */
  planPending: number;
  /** 当前接管角色（handoff）：空 = 主代理 */
  role?: string;
  archived: number;
  pinned: number;
  createdAt: number;
  updatedAt: number;
  /** 侧栏摘要：最后一句"真正说出口的话"及其角色（服务端派生，非 sessions 列） */
  lastMsg?: string;
  lastRole?: 'user' | 'assistant';
}

export interface ToolCallWire {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
}

export interface TaskVerification {
  status: 'verified' | 'partial' | 'failed';
  objective: string;
  checks: { ok: boolean; reason?: string }[];
  evidence: { source: string; detail: string; traceStepId?: string }[];
}

/** 会话消息行（/api/sessions/:id/messages）。 */
export interface Message {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
  /** 原生工具调用（assistant 行）：刷新后工具卡/群成员靠它复原 */
  toolCalls?: ToolCallWire[];
  /** tool 行回填所对应的 tool_call_id（与 assistant.toolCalls[].id 配对） */
  toolCallId?: string;
  /** 一次 run 的关联键（结算回填后才有） */
  traceId?: string;
  taskVerification?: TaskVerification;
}

/** 模型能力位（模型行口径：0/1 存储；运行时能力表另用布尔）。 */
export interface ModelCapabilityInfo {
  providerId?: string;
  modelId: string;
  modelKey?: string;
  pricingId?: string;
  contextWindow: number | null;
  maxOutput: number | null;
  vision: number;
  tools: number;
  reasoning: number;
  priceIn: number | null;
  priceOut: number | null;
  enabled: number;
  source: string;
  latencyMs?: number | null;
  privacyTier?: 'local' | 'trusted' | 'external' | null;
  riskLevel?: 'low' | 'medium' | 'high' | null;
}

export interface ModelInfo {
  schemaVersion?: number;
  /** provider@model */
  id: string;
  /** 纯 provider id */
  provider: string;
  label: string;
  model: string;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface ProviderHealthWire {
  failures: number;
  transientFailures?: number;
  authFailed: boolean;
  lastError: string;
  lastErrorAt: number;
  openedAt?: number;
}

export interface ProviderToolCheck {
  status: 'confirmed' | 'not_confirmed' | 'unknown';
  checkedAt?: number;
  reason?: string;
}

/** /api/providers 列表项（密钥永远只给掩码）。 */
export interface ProviderInfo {
  protocolToolCalls?: boolean;
  toolCheck?: ProviderToolCheck;
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  protocol?: string;
  priceIn?: number | null;
  priceOut?: number | null;
  enabled: boolean;
  apiKeyMasked: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
  models?: ModelCapabilityInfo[];
  health?: ProviderHealthWire;
}

/** 诊断用的模型行：能力位是布尔（与存储行口径不同，别混用）。 */
export interface ProviderDiagnosticModel {
  providerId: string;
  modelId: string;
  modelKey: string;
  pricingId: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  priceIn: number;
  priceOut: number;
  source: string;
}

/** /api/providers/:id/diagnose：不含密钥材料的配置诊断。 */
export interface ProviderDiagnostic {
  schemaVersion: number;
  providerId: string;
  protocol: string;
  configured: { baseUrl: boolean; apiKey: boolean; defaultModel: boolean };
  health: ProviderHealthWire | null;
  models: ProviderDiagnosticModel[];
  issues: string[];
}

/** /api/providers/models 拉取结果（含推断能力，用于免手填）。 */
export interface PulledModel {
  id: string;
  providerId?: string;
  modelKey?: string;
  pricingId?: string;
  label?: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  priceIn: number;
  priceOut: number;
  source: string;
}

/** /api/events 的推送帧。 */
export interface BusEvent {
  type: string;
  traceId?: string;
  data?: unknown;
  ts: number;
}
