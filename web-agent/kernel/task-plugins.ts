import type { RunRecord } from './run';
import type { Capability, KernelLike, PluginBus, PluginManifest, ToolDef, ToolPermission } from './types';

export interface PluginDevelopmentGrant {
  enabled: boolean;
  permissions: ToolPermission[];
  dependencies: string[];
}
export interface TaskPluginBinding {
  id: string;
  version: string;
  hash: string;
  scope: 'run' | 'workspace';
  owner: string;
  manifest: PluginManifest;
  files: Record<string, string>;
  state: 'staged' | 'validated' | 'active' | 'stopped' | 'error';
  error?: string;
}
export interface TaskPluginPersistence {
  get(runId: string): TaskPluginBinding[];
  put(runId: string, bindings: TaskPluginBinding[]): void;
  workspace(tenantId: string, workspace: string): TaskPluginBinding[];
  save(tenantId: string, workspace: string, binding: TaskPluginBinding): void;
  event(runId: string, type: string, data: Record<string, unknown>): void;
}
export interface TaskPluginSession {
  tools(): ToolDef[];
  revision(): number;
  capabilities<T extends Capability['kind']>(kind: T): Extract<Capability, { kind: T }>[];
  bus: PluginBus;
  boundary(): Promise<void>;
  dispose(): Promise<void>;
}
export interface TaskPluginService {
  attach(persistence: TaskPluginPersistence): void;
  open(run: RunRecord): Promise<TaskPluginSession>;
  list(run: RunRecord): TaskPluginBinding[];
  save(run: RunRecord, id: string, hash: string): void;
  routes(runId: string): { pluginId: string; mount: string; router: unknown }[];
  capabilities<T extends Capability['kind']>(runId: string, kind: T): Extract<Capability, { kind: T }>[];
}
export const TASK_PLUGIN_SERVICE = 'service:task-plugins';
export const EMPTY_PLUGIN_GRANT: PluginDevelopmentGrant = { enabled: false, permissions: [], dependencies: [] };

export function taskPluginService(kernel: KernelLike): TaskPluginService | undefined {
  return kernel.plugins.resolveService(TASK_PLUGIN_SERVICE) as TaskPluginService | undefined;
}
