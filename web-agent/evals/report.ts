export interface EvalCaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  providerCalls: number;
  toolCalls: number;
  toolResults: number;
  invalidToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  retryEvents: number;
  taskOutcomes: string[];
  approvalOutcomes: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  securityCategory?: string;
  securityBlocked?: boolean;
}

export interface EvalReport {
  schemaVersion: 1;
  environment: { platform: string; arch: string; nodeMajor: number };
  suite: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    casePassRate: number;
    totalDurationMs: number;
  };
  metrics: {
    providerCalls: number;
    toolCalls: number;
    toolResults: number;
    correctToolRate: number | null;
    invalidToolCallRate: number | null;
    toolFailureRate: number | null;
    retryEvents: number;
    retryRate: number | null;
    taskOutcomes: { verified: number; partial: number; failed: number };
    completionRate: number | null;
    approvalOutcomes: { approved: number; rejected: number };
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    averageCostPerProviderCallUsd: number | null;
    latencyMs: { p50: number; p95: number; max: number };
    securityAttacks: { total: number; blocked: number; blockRate: number | null; byCategory: Record<string, { total: number; blocked: number }> };
  };
  pricingUsdPerMillionTokens: { input: number; output: number };
  cases: EvalCaseResult[];
}

export interface EvalThresholds {
  minCasePassRate: number;
  maxLatencyRegressionPercent: number;
  maxAverageCostRegressionPercent: number;
  minSecurityAttackBlockRate: number;
  maxCorrectToolRateRegressionPoints: number;
  maxCompletionRateRegressionPoints: number;
  maxInvalidToolCallRateIncreasePoints: number;
  maxToolFailureRateIncreasePoints: number;
  maxRetryRateIncreasePoints: number;
}

export const REPLAY_PRICING_USD_PER_MILLION = { input: 0.3, output: 1.2 } as const;

export function buildEvalReport(results: EvalCaseResult[]): EvalReport {
  const cases = [...results].sort((a, b) => a.name.localeCompare(b.name));
  const passedCases = cases.filter((c) => c.passed).length;
  const providerCalls = sum(cases, (c) => c.providerCalls);
  const toolCalls = sum(cases, (c) => c.toolCalls);
  const toolResults = sum(cases, (c) => c.toolResults);
  const successfulToolCalls = sum(cases, (c) => c.successfulToolCalls);
  const failedToolCalls = sum(cases, (c) => c.failedToolCalls);
  const invalidToolCalls = sum(cases, (c) => c.invalidToolCalls);
  const retryEvents = sum(cases, (c) => c.retryEvents);
  const taskOutcomes = {
    verified: countOutcome(cases, 'taskOutcomes', 'verified'),
    partial: countOutcome(cases, 'taskOutcomes', 'partial'),
    failed: countOutcome(cases, 'taskOutcomes', 'failed'),
  };
  const taskCount = taskOutcomes.verified + taskOutcomes.partial + taskOutcomes.failed;
  const approvalOutcomes = {
    approved: countOutcome(cases, 'approvalOutcomes', 'approved'),
    rejected: countOutcome(cases, 'approvalOutcomes', 'rejected'),
  };
  const attacks = cases.filter((c) => c.securityCategory);
  const securityByCategory: EvalReport['metrics']['securityAttacks']['byCategory'] = {};
  for (const attack of attacks) {
    const category = attack.securityCategory!;
    const current = securityByCategory[category] ??= { total: 0, blocked: 0 };
    current.total++;
    if (attack.securityBlocked) current.blocked++;
  }
  const securityBlocked = attacks.filter((c) => c.securityBlocked).length;
  const durations = cases.map((c) => c.durationMs).sort((a, b) => a - b);
  const costUsd = sum(cases, (c) => c.costUsd);
  return {
    schemaVersion: 1,
    environment: { platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]) },
    suite: {
      totalCases: cases.length,
      passedCases,
      failedCases: cases.length - passedCases,
      casePassRate: cases.length ? passedCases / cases.length : 0,
      totalDurationMs: round(sum(cases, (c) => c.durationMs)),
    },
    metrics: {
      providerCalls,
      toolCalls,
      toolResults,
      correctToolRate: ratio(successfulToolCalls, toolResults),
      invalidToolCallRate: ratio(invalidToolCalls, toolResults),
      toolFailureRate: ratio(failedToolCalls, toolResults),
      retryEvents,
      retryRate: ratio(retryEvents, providerCalls),
      taskOutcomes,
      completionRate: ratio(taskOutcomes.verified, taskCount),
      approvalOutcomes,
      tokensIn: sum(cases, (c) => c.tokensIn),
      tokensOut: sum(cases, (c) => c.tokensOut),
      costUsd: round(costUsd),
      averageCostPerProviderCallUsd: providerCalls ? round(costUsd / providerCalls) : null,
      latencyMs: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: round(durations.at(-1) ?? 0),
      },
      securityAttacks: { total: attacks.length, blocked: securityBlocked, blockRate: ratio(securityBlocked, attacks.length), byCategory: securityByCategory },
    },
    pricingUsdPerMillionTokens: REPLAY_PRICING_USD_PER_MILLION,
    cases,
  };
}

export function compareEvalReports(current: EvalReport, baseline: EvalReport, thresholds: EvalThresholds): string[] {
  const regressions: string[] = [];
  if (current.suite.casePassRate < thresholds.minCasePassRate) {
    regressions.push(`casePassRate ${format(current.suite.casePassRate)} 低于下限 ${format(thresholds.minCasePassRate)}`);
  }
  const securityRate = current.metrics.securityAttacks.blockRate;
  if (securityRate !== null && securityRate < thresholds.minSecurityAttackBlockRate) {
    regressions.push(`securityAttackBlockRate ${format(securityRate)} 低于下限 ${format(thresholds.minSecurityAttackBlockRate)}`);
  }
  compareRateDrop(current.metrics.correctToolRate, baseline.metrics.correctToolRate, thresholds.maxCorrectToolRateRegressionPoints,
    'correctToolRate', regressions);
  compareRateDrop(current.metrics.completionRate, baseline.metrics.completionRate, thresholds.maxCompletionRateRegressionPoints,
    'completionRate', regressions);
  compareRateIncrease(current.metrics.invalidToolCallRate, baseline.metrics.invalidToolCallRate, thresholds.maxInvalidToolCallRateIncreasePoints,
    'invalidToolCallRate', regressions);
  compareRateIncrease(current.metrics.toolFailureRate, baseline.metrics.toolFailureRate, thresholds.maxToolFailureRateIncreasePoints,
    'toolFailureRate', regressions);
  compareRateIncrease(current.metrics.retryRate, baseline.metrics.retryRate, thresholds.maxRetryRateIncreasePoints,
    'retryRate', regressions);
  const currentCases = new Map(current.cases.map((c) => [c.name, c]));
  for (const oldCase of baseline.cases) {
    const newCase = currentCases.get(oldCase.name);
    if (oldCase.passed && (!newCase || !newCase.passed)) regressions.push(`case 回归: ${oldCase.name} (${newCase ? '失败' : '缺失'})`);
  }
  if (sameEnvironment(current, baseline)) {
    const oldP95 = baseline.metrics.latencyMs.p95;
    if (oldP95 > 0 && exceedsPercent(current.metrics.latencyMs.p95, oldP95, thresholds.maxLatencyRegressionPercent)) {
      regressions.push(`latency P95 ${current.metrics.latencyMs.p95}ms 超出 baseline ${oldP95}ms +${thresholds.maxLatencyRegressionPercent}%`);
    }
  }
  if (JSON.stringify(current.pricingUsdPerMillionTokens) !== JSON.stringify(baseline.pricingUsdPerMillionTokens)) {
    regressions.push('评测成本计价配置与 baseline 不一致');
  }
  const oldCost = baseline.metrics.averageCostPerProviderCallUsd;
  const newCost = current.metrics.averageCostPerProviderCallUsd;
  if (oldCost !== null && oldCost > 0 && newCost !== null && exceedsPercent(newCost, oldCost, thresholds.maxAverageCostRegressionPercent)) {
    regressions.push(`平均单次 Provider 成本 $${newCost} 超出 baseline $${oldCost} +${thresholds.maxAverageCostRegressionPercent}%`);
  }
  return regressions;
}

function countOutcome(cases: EvalCaseResult[], key: 'taskOutcomes' | 'approvalOutcomes', value: string): number {
  return cases.reduce((total, c) => total + c[key].filter((outcome) => outcome === value).length, 0);
}

function sum(cases: EvalCaseResult[], get: (c: EvalCaseResult) => number): number {
  return cases.reduce((total, c) => total + get(c), 0);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? round(numerator / denominator) : null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sameEnvironment(a: EvalReport, b: EvalReport): boolean {
  return a.environment.platform === b.environment.platform
    && a.environment.arch === b.environment.arch
    && a.environment.nodeMajor === b.environment.nodeMajor;
}

function exceedsPercent(value: number, baseline: number, limitPercent: number): boolean {
  return value > baseline * (1 + limitPercent / 100);
}

function format(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function compareRateDrop(current: number | null, baseline: number | null, maxPoints: number, name: string, regressions: string[]): void {
  if (current === null || baseline === null) return;
  const drop = baseline - current;
  if (drop > maxPoints) regressions.push(`${name} 下降 ${(drop * 100).toFixed(2)} 个百分点，超过上限 ${(maxPoints * 100).toFixed(2)} 个百分点`);
}

function compareRateIncrease(current: number | null, baseline: number | null, maxPoints: number, name: string, regressions: string[]): void {
  if (current === null || baseline === null) return;
  const increase = current - baseline;
  if (increase > maxPoints) regressions.push(`${name} 上升 ${(increase * 100).toFixed(2)} 个百分点，超过上限 ${(maxPoints * 100).toFixed(2)} 个百分点`);
}
