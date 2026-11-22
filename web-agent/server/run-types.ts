// server/run-types.ts —— 运行服务的绑定、错误与环境契约（从 run-service.ts 拆出）
import type { AgentLoop, RunOptions } from '../kernel/loop';
import type { ChildRunFallback } from '../kernel/run';
import type { RunRecord } from '../kernel/run';
import type { Session } from '../kernel/types';
import type { ToolDef } from '../kernel/types';
import type { TaskPluginService } from '../kernel/task-plugins';
import type { Store } from './db';
import type { OrganizationService } from './services/organization/service';

export interface OrganizationRunBinding {
  workOrderId: string;
  assignmentContractId: string;
  organizationRoleId: string;
  teamCycleId?: string;
  cachePrefixHash?: string;
}

export class RunError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RunEnvironment {
  plugins?: TaskPluginService;
  store: Store;
  prepare(record: RunRecord): RunOptions;
  historyArchive?: boolean;
  runner(): AgentLoop | undefined;
  workspace(tenantId: string): string;
  projectRoot?: string;
  provider(session: Session, providerId?: string): { id: string; model: string } | undefined;
  activity?(active: boolean): void;
  tools?(): ToolDef[];
  maxDepth?: number;
  executionSlots?: number;
  organization?: OrganizationService;
}

export type { ChildRunFallback };
