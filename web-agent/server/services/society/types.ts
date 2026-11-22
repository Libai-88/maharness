import type { MaterialRef } from '../../../kernel/material';
import type { RunService } from '../../run-service';
import type { SocietySchedule, SocietySnapshot, SocietyTask, SocietyTaskBranch } from '../../organization-store';

/** Shared society task/estimate shapes used by the service, scheduler and experiments. */
export interface CreateSocietyTaskInput {
  tenantId: string;
  projectId?: string;
  objective: string;
  acceptance?: string[];
  materials?: Pick<MaterialRef, 'id' | 'version'>[];
  valueUsd: number;
  maxBudgetUsd: number;
  maxBudgetTokens?: number;
  priority?: number;
  departmentId?: string;
  requiredCapabilities?: string[];
  needsWrite?: boolean;
  teamMode?: 'auto' | 'solo' | 'team';
  economics?: Partial<NonNullable<SocietyTask['economics']>>;
  evidenceExperimentId?: string;
  branches?: SocietyTaskBranch[];
}

export interface SocietyEconomicsEstimate {
  costSource: 'configured' | 'historical' | 'unavailable';
  pricingRefs: string[];
  single: {
    costUsd: number;
    tokens: number;
    quality: number;
    latencyMs: number;
    risk: number;
    netBenefitUsd: number;
  };
  team: {
    costUsd: number;
    coordinationCostUsd: number;
    tokens: number;
    coordinationTokens: number;
    quality: number;
    latencyGainMs: number;
    riskReduction: number;
    netBenefitUsd: number;
  };
  marginalNetBenefitUsd: number;
  formula: string;
}

export interface SocietyTickResult {
  decisions: SocietySchedule[];
  queued: number;
  waitingApproval: number;
  snapshot: SocietySnapshot;
}

export interface SocietyTickAllResult {
  tenants: number;
  decisions: SocietySchedule[];
  queued: number;
  waitingApproval: number;
  failed: Array<{ tenantId: string; error: string }>;
}

export type SocietyRunRuntime = Pick<RunService, 'startSocietyAssignment' | 'get' | 'subscribe' | 'cancel'> &
  Partial<Pick<RunService, 'resume'>>;

export function teamCostEligible(
  objective: string,
  estimate: SocietyEconomicsEstimate,
  explicitTeamRequest: (text: string) => boolean,
): boolean {
  return explicitTeamRequest(objective) || estimate.team.costUsd <= estimate.single.costUsd + 1e-10;
}
