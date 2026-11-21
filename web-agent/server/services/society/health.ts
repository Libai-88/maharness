import type { SocietyObservation } from '../../organization-store';

export interface SocialHealthInput {
  loadBalance: number | null;
  welfare: number | null;
  exceptionHealth: number | null;
  budgetUtilization: number | null;
  collaborationHealth: number | null;
  sampleSize: number;
  roleCount: number;
  unresolvedExceptions: number;
  reservedUsd: number;
  spentUsd: number;
  budgetUsd: number;
}

function quality(sampleSize: number): SocietyObservation['quality'] {
  if (sampleSize <= 0) return 'unknown';
  return sampleSize >= 3 ? 'observed' : 'insufficient';
}

/**
 * Social observations, not a social health score.
 *
 * Each metric reports its own numerator, denominator, sample size and formula.
 * There is deliberately no composite `/100`: the previous weighted average
 * looked like an objective measurement while its weights had no calibration.
 */
export function buildSocialObservations(input: SocialHealthInput): SocietyObservation[] {
  return [
    {
      id: 'load_balance',
      label: '负载均衡',
      value: input.loadBalance,
      unit: 'ratio',
      numerator: null,
      denominator: input.roleCount,
      sampleSize: input.roleCount,
      quality: input.loadBalance === null ? 'unknown' : quality(input.roleCount),
      formula: '1 - 活跃任务负载的标准差 / 平均值；角色数为 0 时无定义',
    },
    {
      id: 'welfare',
      label: '福利余量',
      value: input.welfare,
      unit: 'ratio',
      numerator: null,
      denominator: input.roleCount,
      sampleSize: input.roleCount,
      quality: input.welfare === null ? 'unknown' : quality(input.roleCount),
      formula: '按角色计算 1 - 当前活跃任务 / 福利上限后取平均；无角色时无定义',
    },
    {
      id: 'exception_backlog',
      label: '未结异常',
      value: input.unresolvedExceptions,
      unit: 'count',
      numerator: input.unresolvedExceptions,
      denominator: null,
      sampleSize: input.unresolvedExceptions,
      quality: 'observed',
      formula: '状态不是 resolved/dismissed/auto_resolved 的异常数量；只计数，不做健康换算',
    },
    {
      id: 'budget_utilization',
      label: '预算占用',
      value: input.budgetUtilization,
      unit: 'ratio',
      numerator: Math.round((input.reservedUsd + input.spentUsd) * 1e6) / 1e6,
      denominator: input.budgetUsd,
      sampleSize: input.budgetUsd > 0 ? 1 : 0,
      quality: input.budgetUsd > 0 ? 'observed' : 'unknown',
      formula: '(已预留 + 已花费) / 社会预算；预算为 0 时无定义',
    },
    {
      id: 'collaboration',
      label: '协作关系',
      value: input.collaborationHealth,
      unit: 'ratio',
      numerator: null,
      denominator: null,
      sampleSize: input.sampleSize,
      quality: input.collaborationHealth === null ? 'unknown' : quality(input.sampleSize),
      formula: '实际交接/复核/冲突事件的关系分平均；无事件样本时无定义，不按任务结果批量赋值',
    },
  ];
}
