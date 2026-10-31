import type { TraceStep } from './types';

export interface TraceStepChange {
  id: string;
  before?: TraceStep;
  after?: TraceStep;
  fields?: string[];
}

export interface TraceDiff {
  added: TraceStepChange[];
  removed: TraceStepChange[];
  changed: TraceStepChange[];
}

/** 纯数据比较：只报告步骤集合和字段变化，不触发工具、Provider 或任何副作用。 */
export function diffTraceSteps(before: readonly TraceStep[], after: readonly TraceStep[]): TraceDiff {
  const left = new Map(before.map((step) => [step.id, step]));
  const right = new Map(after.map((step) => [step.id, step]));
  const added: TraceStepChange[] = [];
  const removed: TraceStepChange[] = [];
  const changed: TraceStepChange[] = [];
  for (const [id, step] of right) {
    if (!left.has(id)) {
      added.push({ id, after: step });
      continue;
    }
    const previous = left.get(id)!;
    const fields = changedFields(previous, step);
    if (fields.length) changed.push({ id, before: previous, after: step, fields });
  }
  for (const [id, step] of left) {
    if (!right.has(id)) removed.push({ id, before: step });
  }
  return { added, removed, changed };
}

function changedFields(before: TraceStep, after: TraceStep): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key as keyof TraceStep]) !== JSON.stringify(after[key as keyof TraceStep]));
}
