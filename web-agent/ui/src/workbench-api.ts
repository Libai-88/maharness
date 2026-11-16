import { api } from './api';
import type { Material } from './material-api';
import type { RunArtifact, RunInfo } from './run-api';

export interface WorkbenchItem {
  id: string;
  title: string;
  note?: string;
  due?: string;
  dueTime?: string;
  lifecycle: string;
  revision: number;
  attempts?: { runId: string; status: string }[];
}

export interface WorkbenchAutomation {
  id: string;
  name: string;
  prompt: string;
  state: string;
  approval: string;
  nextDueAt?: number;
  lastTriggeredAt?: number;
  revision: number;
  trigger: Record<string, unknown>;
}

export interface WorkbenchProject {
  id: string;
  name: string;
  stage: string;
  next: string;
  blocker: string;
  status: 'active' | 'blocked' | 'done';
  updatedAt: number;
}

export interface WorkbenchNote {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchSummary {
  schemaVersion: 1;
  today: string;
  todayItems: WorkbenchItem[];
  overdue: WorkbenchItem[];
  upcoming: WorkbenchItem[];
  unscheduled: WorkbenchItem[];
  pendingAutomations: WorkbenchAutomation[];
  automations: WorkbenchAutomation[];
  recentRuns: RunInfo[];
  artifacts: RunArtifact[];
  projects: WorkbenchProject[];
  notes: WorkbenchNote[];
  metrics: {
    schemaVersion: 1;
    firstTaskSuccessRate: number | null;
    takeoverRate: number | null;
    recoveredAfterFailureRate: number | null;
    automaticRecoveryRate: number | null;
    invalidToolCalls: number;
    duplicateToolCalls: number;
    capabilitySelectionFailures: number;
    durationMs: number;
    modelCalls: number;
    costUsd: number;
  };
}

export const workbenchApi = {
  summary: () => api<WorkbenchSummary>(`/api/workbench/summary?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  execute: (item: WorkbenchItem) => api<{ sessionId: string }>(`/api/items/${encodeURIComponent(item.id)}/execute`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ revision: item.revision, newAttempt: false }),
  }),
  artifact: (runId: string, artifact: RunArtifact) => api<Material>('/api/materials/artifact', {
    method: 'POST',
    body: JSON.stringify({ runId, artifactId: artifact.id }),
  }),
};
