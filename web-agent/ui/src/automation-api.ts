import { api } from './api';
import type { WorkbenchAutomation } from './workbench-api';

export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'once'; at: number }
  | { type: 'schedule'; recurrence: 'daily' | 'weekdays' | 'weekly' | 'monthly'; time: string; timeZone: string; dayOfWeek?: number; dayOfMonth?: number }
  | { type: 'file'; path: string }
  | { type: 'url'; url: string };

export interface AutomationOccurrence {
  id: string;
  automationId: string;
  occurrenceKey: string;
  dueAt: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  reason?: string;
  runId?: string;
  updatedAt: number;
  run?: { status: string; sessionId: string; answer?: string; error?: string };
  runMissing?: boolean;
}

export interface Automation extends WorkbenchAutomation {
  workspace: string;
  createdBy: 'user' | 'agent';
  materials: { id: string; version: string }[];
  trigger: AutomationTrigger;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationCreateInput {
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
}

export const automationApi = {
  list: () => api<{ automations: Automation[]; occurrences: AutomationOccurrence[] }>('/api/automations'),
  create: (input: AutomationCreateInput) => api<{ automation: Automation }>('/api/automations', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, revision: number, patch: Partial<AutomationCreateInput>) => api<{ automation: Automation }>(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ revision, patch }) }),
  confirm: (id: string, revision: number) => api<{ automation: Automation }>(`/api/automations/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({ revision }) }),
  pause: (id: string, revision: number) => api<{ automation: Automation }>(`/api/automations/${encodeURIComponent(id)}/pause`, { method: 'POST', body: JSON.stringify({ revision }) }),
  resume: (id: string, revision: number) => api<{ automation: Automation }>(`/api/automations/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ revision }) }),
  run: (id: string, revision: number) => api<{ occurrence: AutomationOccurrence }>(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ revision }) }),
  cancel: (id: string, revision: number) => api<{ automation: Automation }>(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),
};
