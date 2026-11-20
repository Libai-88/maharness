import type { SocialHealth } from '../organization-store';
import { SOCIAL_HEALTH_WEIGHTS } from './policy';

export interface SocialHealthInput {
  loadBalance: number | null;
  welfare: number | null;
  exceptionHealth: number | null;
  budgetUtilization: number | null;
  collaborationHealth: number | null;
  sampleSize: number;
}

/** Build the explicitly heuristic health score; missing components are re-normalized, not treated as zero. */
export function buildSocialHealth(input: SocialHealthInput): SocialHealth {
  const parts: Array<[number | null, number]> = [
    [input.loadBalance, SOCIAL_HEALTH_WEIGHTS.loadBalance],
    [input.welfare, SOCIAL_HEALTH_WEIGHTS.welfare],
    [input.exceptionHealth, SOCIAL_HEALTH_WEIGHTS.exceptionHealth],
    [input.budgetUtilization === null ? null : 1 - input.budgetUtilization, SOCIAL_HEALTH_WEIGHTS.budgetHeadroom],
    [input.collaborationHealth, SOCIAL_HEALTH_WEIGHTS.collaborationHealth],
  ];
  const available = parts.filter((part): part is [number, number] => part[0] !== null);
  const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  return {
    score: availableWeight
      ? Math.round(available.reduce((sum, [value, weight]) => sum + value * weight, 0) / availableWeight * 10_000) / 100
      : null,
    scoreKind: 'weighted_heuristic',
    sampleSize: input.sampleSize,
    weights: { ...SOCIAL_HEALTH_WEIGHTS },
    loadBalance: input.loadBalance,
    welfare: input.welfare,
    exceptionHealth: input.exceptionHealth,
    budgetUtilization: input.budgetUtilization,
    collaborationHealth: input.collaborationHealth,
  };
}
