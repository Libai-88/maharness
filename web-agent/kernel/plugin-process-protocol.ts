import type { ToolDef, ToolResult } from './types';

/** 子进程可序列化的工具描述：函数字段不跨界。 */
export type ProcessToolDescriptor = Omit<ToolDef, 'handler' | 'assessApproval' | 'executionTimeoutMs'>;

export interface ProcessCallContext {
  runId?: string;
  parentRunId?: string;
  authorization?: import('./run').RunAuthorization;
  remainingBudget?: number;
  traceId?: string;
  turn: number;
  sessionId?: string;
  tenantId?: string;
  stepId?: string;
  sandboxRoot: string;
  approved?: boolean;
  approvalId?: string;
  policyApproved?: boolean;
  model?: string;
  providerId?: string;
}

export type ParentToHost =
  | {
    type: 'load';
    pluginId: string;
    entry: string;
    loadDir: string;
    storageDir: string;
    config: Record<string, unknown>;
    env: Record<string, string | undefined>;
    limits: { maxStorageBytes?: number; maxStorageFiles?: number };
    runtime?: {
      network?: 'none' | 'allowlist' | 'full';
      networkAllowlist?: string[];
      filesystem?: 'none' | 'storage' | 'sandbox' | 'full';
      sandboxRoot?: string;
    };
  }
  | { type: 'start' }
  | { type: 'stop'; reason?: string }
  | { type: 'call'; id: number; tool: string; args: unknown; context: ProcessCallContext }
  | { type: 'abort'; id: number }
  | { type: 'event'; token: number; event: { type: string; data?: unknown; ts?: number; traceId?: string } }
  | { type: 'unsubscribe'; token: number };

export type HostToParent =
  | { type: 'register'; tool: ProcessToolDescriptor }
  | { type: 'unregister'; name: string }
  | { type: 'ready'; tools: ProcessToolDescriptor[] }
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'result'; id: number; result: ToolResult }
  | { type: 'error'; id: number; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; message: string; meta?: unknown }
  | { type: 'outbound'; record: { kind: 'file' | 'http' | 'db' | 'proc'; detail: string; compensable?: boolean } }
  | { type: 'subscribe'; token: number; event: string; priority?: number }
  | { type: 'unsubscribe'; token: number }
  | { type: 'emit'; event: { type: string; data?: unknown; ts?: number; traceId?: string } }
  | { type: 'fatal'; error: string };
