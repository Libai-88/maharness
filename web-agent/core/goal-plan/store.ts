import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface PlanState {
  objective: string;
  steps: { title: string; status: StepStatus; note?: string; blockedReason?: string; updatedAt?: number }[];
  current: number;
  completed: boolean;
  createdAt: number;
  updatedAt?: number;
}

export const MAX_PLANS = 50;

const STATUSES = new Set<StepStatus>(['pending', 'in_progress', 'done', 'blocked']);

function normalizePlan(value: unknown): PlanState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.objective !== 'string' || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.flatMap((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const item = step as Record<string, unknown>;
    if (typeof item.title !== 'string' || !STATUSES.has(item.status as StepStatus)) return [];
    return [{
      title: item.title,
      status: item.status as StepStatus,
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      ...(typeof item.blockedReason === 'string' ? { blockedReason: item.blockedReason } : {}),
      ...(Number.isFinite(item.updatedAt) ? { updatedAt: Number(item.updatedAt) } : {}),
    }];
  });
  if (steps.length === 0 && raw.steps.length > 0) return null;
  return {
    objective: raw.objective,
    steps,
    current: Number.isFinite(raw.current) ? Math.max(0, Math.trunc(Number(raw.current))) : 0,
    completed: raw.completed === true,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    ...(Number.isFinite(raw.updatedAt) ? { updatedAt: Number(raw.updatedAt) } : {}),
  };
}

/** 步骤级状态机：只允许有意义的迁移；done 可重新打开，但会清除计划完成位。 */
export function canTransition(from: StepStatus, to: StepStatus): boolean {
  if (from === to) return true;
  switch (from) {
    case 'pending': return to === 'in_progress' || to === 'done' || to === 'blocked';
    case 'in_progress': return to === 'pending' || to === 'done' || to === 'blocked';
    case 'blocked': return to === 'pending' || to === 'in_progress';
    case 'done': return to === 'pending' || to === 'in_progress';
    default: return false;
  }
}

export function loadPlans(file: string): Map<string, PlanState> {
  const plans = new Map<string, PlanState>();
  try {
    if (!existsSync(file)) return plans;
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
      : [];
    for (const [key, value] of entries) {
      const plan = normalizePlan(value);
      if (plan) plans.set(key, plan);
    }
    while (plans.size > MAX_PLANS) {
      const oldest = plans.keys().next().value;
      if (oldest === undefined) break;
      plans.delete(oldest);
    }
  } catch {
    return new Map();
  }
  return plans;
}

export function savePlans(file: string, plans: Map<string, PlanState>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(plans), null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 持久化失败不阻断对话 */
  }
}
