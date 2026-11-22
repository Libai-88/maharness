import { RUN_TERMINAL, type RunRecord } from '../../../kernel/run';
import type { Store } from '../../db';
import type { EvaluationVersion, RoleScorecard, RoleWellbeingSnapshot } from '../../organization-store';

/**
 * Read-only organization projections: scorecards, wellbeing and work-order
 * economics. They read durable facts only, so they can be recomputed for the
 * UI without touching contract or Run state.
 */
export interface ProjectionDeps {
  store: Store;
  repository(): Store['organization'];
  ensureEvaluation(tenantId: string): EvaluationVersion;
  executionUsage(runs: RunRecord[]): {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    tokensCached: number;
    tokensCacheMiss: number;
    cacheWriteTokens: number;
    usageKnown: boolean;
    costStatus: 'known' | 'partial' | 'unknown';
  };
  now(): number;
}

export function buildScorecards(deps: ProjectionDeps, tenantId: string): RoleScorecard[] {
  const repo = deps.repository();
  const evaluation = deps.ensureEvaluation(tenantId);
  const roles = repo.listRoles(tenantId, undefined, true);
  const orders = repo.listWorkOrders(tenantId, undefined, 500);
  const contracts = orders.flatMap((order) => repo.contracts(order.id, tenantId));
  return roles.map((role) => {
    const own = contracts.filter((contract) => contract.roleId === role.id);
    const terminal = own.filter((contract) => ['delivered', 'failed', 'cancelled', 'collapsed'].includes(contract.status));
    const delivered = terminal.filter((contract) => contract.status === 'delivered');
    const withDelivery = own.filter((contract) => !!contract.delivery);
    const runs = own.flatMap((contract) =>
      contract.runId ? [deps.store.runs.get(contract.runId, tenantId)].filter((run): run is RunRecord => !!run) : [],
    );
    const evidenceComplete = withDelivery.filter((contract) => (contract.delivery?.evidence.length ?? 0) > 0).length;
    const budgetChecks = own.flatMap((contract) => {
      const run = contract.runId ? deps.store.runs.get(contract.runId, tenantId) : undefined;
      return run && contract.budgetUsd !== undefined ? [{ run, budget: contract.budgetUsd }] : [];
    });
    const withinBudget = budgetChecks.filter((item) => item.run.cost <= item.budget + 1e-10).length;
    const tokenBudgetChecks = own.flatMap((contract) => {
      const run = contract.runId ? deps.store.runs.get(contract.runId, tenantId) : undefined;
      return run && run.budgetTokens !== undefined ? [run.tokensIn + run.tokensOut <= run.budgetTokens] : [];
    });
    const recovered = runs.filter((run) => deps.store.runs.events(run.id).some((event) => event.type === 'tool_recovered')).length;
    const sampleSize = terminal.length;
    return {
      roleId: role.id,
      tenantId,
      sampleSize,
      evaluationVersion: evaluation.version,
      evaluationHash: evaluation.hash,
      confidence:
        sampleSize < evaluation.record.lowConfidenceSamples
          ? 'insufficient'
          : sampleSize < evaluation.record.mediumConfidenceSamples
            ? 'low'
            : sampleSize < evaluation.record.highConfidenceSamples
              ? 'medium'
              : 'high',
      completionRate: sampleSize ? delivered.length / sampleSize : null,
      acceptanceRate: delivered.length
        ? delivered.filter((contract) => contract.delivery?.unfinished.length === 0).length / delivered.length
        : null,
      reworkRate: sampleSize >= 2 ? Math.max(0, own.length - sampleSize) / own.length : null,
      budgetCompliance: budgetChecks.length ? withinBudget / budgetChecks.length : null,
      recoveryRate: runs.length ? recovered / runs.length : null,
      evidenceCompleteness: withDelivery.length ? evidenceComplete / withDelivery.length : null,
      reviewConsistency: null,
      costUsd: runs.reduce((sum, run) => sum + run.cost, 0),
      tokens: runs.reduce((sum, run) => sum + run.tokensIn + run.tokensOut, 0),
      cachedInputTokens: runs.reduce((sum, run) => sum + (run.tokensCached ?? 0), 0),
      tokenBudgetCompliance: tokenBudgetChecks.length ? tokenBudgetChecks.filter(Boolean).length / tokenBudgetChecks.length : null,
      updatedAt: deps.now(),
    };
  });
}

export function buildWellbeing(deps: ProjectionDeps, tenantId: string, projectId?: string): RoleWellbeingSnapshot[] {
  const repo = deps.repository();
  const roles = repo
    .listRoles(tenantId, undefined, true)
    .filter((role) => !projectId || role.projectId === '' || role.projectId === projectId);
  const orders = repo.listWorkOrders(tenantId, projectId, 200);
  const contracts = orders.flatMap((order) => repo.contracts(order.id, tenantId));
  const allRuns = deps.store.runs.list(tenantId);
  const now = deps.now();
  const recentCutoff = now - 24 * 60 * 60 * 1000;
  const backoffMs = 15 * 60 * 1000;
  return roles.map((role) => {
    const roleRuns = allRuns.filter((run) => run.organizationRoleId === role.id);
    const ownRuns = roleRuns.filter((run) => !RUN_TERMINAL.has(run.status));
    const ownContracts = contracts.filter((contract) => contract.roleId === role.id && ['proposed', 'active'].includes(contract.status));
    const waiting = ownRuns.filter((run) => run.status === 'waiting_approval').length;
    const recentTerminal = roleRuns
      .filter((run) => RUN_TERMINAL.has(run.status) && run.updatedAt >= recentCutoff)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    let failures = 0;
    for (const run of recentTerminal) {
      if (run.status !== 'failed') break;
      failures += 1;
    }
    const lastFailureAt = recentTerminal.find((run) => run.status === 'failed')?.updatedAt;
    const failureBackoffUntil = failures >= 2 && lastFailureAt ? lastFailureAt + backoffMs : undefined;
    const latestModelCall = roleRuns
      .flatMap((run) => deps.store.runs.modelCalls(run.id, 0, 500))
      .filter(
        (call) =>
          call.status === 'completed' &&
          (call.purpose === 'agent' || call.purpose === 'vision') &&
          Number.isSafeInteger(call.contextWindow) &&
          call.contextWindow! > 0,
      )
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    const contextRatio = latestModelCall ? latestModelCall.inputEstimate / latestModelCall.contextWindow! : undefined;
    const contextPressure =
      contextRatio !== undefined ? (contextRatio >= 0.8 ? ('high' as const) : ('normal' as const)) : ('unknown' as const);
    const pendingContracts = ownContracts.filter((contract) => !contract.runId || !ownRuns.some((run) => run.id === contract.runId));
    return {
      roleId: role.id,
      activeAssignments: ownRuns.length + pendingContracts.length,
      consecutiveFailures: failures,
      waitingApproval: waiting,
      reworkAssignments: ownContracts.filter((contract) => contract.status === 'proposed').length,
      contextPressure,
      state:
        failureBackoffUntil && failureBackoffUntil > now
          ? ('resting' as const)
          : waiting
            ? ('waiting' as const)
            : ownRuns.length
              ? ('busy' as const)
              : role.employment === 'paused'
                ? ('resting' as const)
                : ('ready' as const),
      ...(lastFailureAt ? { lastFailureAt } : {}),
      ...(failureBackoffUntil ? { failureBackoffUntil } : {}),
      updatedAt: now,
    };
  });
}
