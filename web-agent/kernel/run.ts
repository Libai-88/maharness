import type { LLMMessage, ToolResult } from './types';
import type { AgentEvent, RunOptions } from './loop';

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'stopping' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export type PermissionProfile = 'standard' | 'developer';
export interface RunAuthorization { workspace: string; profile: PermissionProfile; readOnly: boolean; revision: number; frameworkChangeId?: string; pluginDevelopment?: import('./task-plugins').PluginDevelopmentGrant; }
export interface RunRecord {
  id: string; sessionId: string; tenantId: string; parentId?: string; rootId: string; depth: number;
  objective: string; providerId: string; model: string; status: RunStatus; authorization: RunAuthorization;
  createdAt: number; updatedAt: number; cost: number; tokensIn: number; tokensOut: number;
  answer?: string; error?: string; verification?: unknown; budgetUsd?: number; deadlineAt?: number;
  parentStepId?: string;
  principalRole?: 'admin' | 'member' | 'readonly';
  acceptance?: import('./task-verifier').TaskCriterion[];
  requestFingerprint?: string;
  usageMessageId?: string;
  toolNames?: string[];
  instructions?: string;
  maxTurns?: number;
  budgetPolicy?: 'advisory' | 'enforce';
  billingAcknowledgedAt?: number;
  billingNotice?: string;
  usageStatus?: 'reported' | 'estimated' | 'unknown';
}
export interface RunEvent { runId: string; seq: number; type: string; data: Record<string, unknown>; createdAt: number; }
export interface RunCheckpoint { history: LLMMessage[]; turn: number; costUsd: number; toolResults: { name: string; ok: boolean; evidence?: import('./types').ToolEvidence[] }[]; enabledTools?: string[]; pending?: boolean; pendingTool?: { name: string; toolCallId: string; sideEffect?: string; effectKey?: string; resultId?: string }; }
export interface ManagedExecution { runChild(options: RunOptions, parentId: string): AsyncGenerator<AgentEvent>; }
export interface ChildRunRequest { parentStepId?: string; objective: string; tools?: 'read' | 'all'; plugins?: string[]; instructions?: string; maxTurns?: number; budgetUsd?: number; }
export interface ChildRunResult { runId: string; traceId: string; answer: string; toolCalls: number; cost: number; tokensIn: number; tokensOut: number; error?: string; cancelled: boolean; }
export interface ToolFailure { code: string; retryable: boolean; outcome: 'not_started' | 'applied' | 'unknown'; }
export interface PersistedToolCall { id: string; runId: string; name: string; result?: ToolResult; }
export const RUN_TERMINAL = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
