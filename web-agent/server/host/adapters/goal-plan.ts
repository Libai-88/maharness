import { currentPlanForSession } from '../../../core/goal-plan';

export interface GoalPlanSnapshot {
  workItems?: Array<{ dependsOn: string[] }>;
}

/** Server adapter for the goal-plan plugin; routes/services receive only this shape. */
export function currentPlan(tenantId: string, sessionId: string): GoalPlanSnapshot | undefined {
  return currentPlanForSession(tenantId, sessionId);
}