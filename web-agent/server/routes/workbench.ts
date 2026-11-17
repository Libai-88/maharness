import type { Express } from 'express';
import type { PersonalItems } from '../../core/todo/items';
import { tenantIdOf, type RouteDeps } from './shared';
import { reviewScore } from '../experience';

export function dateInTimeZone(now: number, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function registerWorkbenchRoutes(app: Express, deps: RouteDeps): void {
  app.get('/api/workbench/summary', (req, res) => {
    const tenantId = tenantIdOf(req);
    const items = deps.kernel.plugins.resolveService('service:personal-items') as PersonalItems | undefined;
    if (!items) return res.status(503).json({ code: 'ITEMS_UNAVAILABLE', error: '事项能力不可用' });
    const timeZone = typeof req.query.timeZone === 'string' ? req.query.timeZone : 'UTC';
    let today: string;
    try { today = dateInTimeZone(Date.now(), timeZone); }
    catch { return res.status(400).json({ code: 'INVALID_TIMEZONE', error: '时区无效' }); }
    const rows = items.list(tenantId);
    const active = rows.filter(item => !['done', 'archived'].includes(item.lifecycle));
    const automations = deps.automations?.list(tenantId) ?? [];
    const allRuns = deps.store.runs.list(tenantId);
    const recentRuns = [...allRuns].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt).slice(0, 12);
    const artifacts = allRuns
      .flatMap(run => deps.store.runs.artifacts(run.id))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, 20);
    const workspace = items.workspace(tenantId).data;
    const metrics = workbenchMetrics(deps, tenantId);
    const experience = experienceSummary(deps, tenantId);
    const organization = organizationSummary(deps, tenantId);
    res.json({
      schemaVersion: 1,
      today,
      todayItems: active.filter(item => item.due === today),
      overdue: active.filter(item => !!item.due && item.due < today),
      upcoming: active.filter(item => !!item.due && item.due > today).slice(0, 20),
      unscheduled: active.filter(item => !item.due).slice(0, 20),
      pendingAutomations: automations.filter(item => item.approval === 'pending'),
      automations: automations.slice(0, 12),
      recentRuns,
      artifacts,
      projects: workspace.projects ?? [],
      notes: (workspace.notes ?? []).slice(0, 8),
      metrics,
      experience,
      organization,
      society: deps.society?.snapshot(tenantId) ?? null,
    });
  });
}

function organizationSummary(deps: RouteDeps, tenantId: string) {
  const service = deps.organization;
  if (!service) {
    return {
      schemaVersion: 1 as const,
      workOrders: [],
      roles: [],
      scorecards: [],
      wellbeing: [],
      receipts: [],
      exceptions: [],
      proposals: [],
    };
  }
  const orders = deps.store.organization.listWorkOrders(tenantId, undefined, 20);
  const workOrders = orders.map(order => {
    const detail = service.detail(order.id, tenantId);
    return {
      ...order,
      contracts: detail.contracts,
      teamCycles: detail.teamCycles,
      roles: detail.roles,
      receipt: detail.receipt,
      exceptions: detail.exceptions,
      economics: detail.economics,
      scorecards: detail.scorecards,
      wellbeing: detail.wellbeing,
    };
  });
  return {
    schemaVersion: 1 as const,
    workOrders,
    roles: deps.store.organization.listRoles(tenantId, undefined, true),
    scorecards: service.scorecards(tenantId),
    wellbeing: service.wellbeing(tenantId),
    receipts: deps.store.organization.receipts(tenantId, 20),
    exceptions: deps.store.organization.exceptions(tenantId, undefined, 50),
    proposals: deps.store.organization.proposals(tenantId),
  };
}

function percent(numerator: number, denominator: number): number | null {
  return denominator ? Math.round(numerator / denominator * 1000) / 10 : null;
}

function workbenchMetrics(deps: RouteDeps, tenantId: string) {
  const allRuns = deps.store.runs.list(tenantId);
  const bySession = new Map<string, typeof allRuns>();
  for (const run of allRuns) {
    const rows = bySession.get(run.sessionId) ?? [];
    rows.push(run);
    bySession.set(run.sessionId, rows);
  }
  let firstTaskRuns = 0, firstTaskSuccesses = 0, sessionsWithFailure = 0, failuresRecovered = 0, sessionsWithTakeover = 0;
  for (const runs of bySession.values()) {
    const ordered = [...runs].sort((a, b) => a.createdAt - b.createdAt);
    const first = ordered[0];
    if (!first) continue;
    firstTaskRuns++;
    if (first.status === 'completed') firstTaskSuccesses++;
    const failureIndex = ordered.findIndex(run => run.status === 'failed' || run.status === 'interrupted');
    if (failureIndex >= 0) {
      sessionsWithFailure++;
      if (ordered.slice(failureIndex + 1).some(run => run.status === 'completed')) failuresRecovered++;
    }
    if (ordered.some(run => run.status === 'waiting_approval' || deps.store.runs.events(run.id).some(event => event.type === 'approval_required'))) {
      sessionsWithTakeover++;
    }
  }
  const calls = allRuns.flatMap(run => deps.store.runs.toolCalls(run.id));
  const seen = new Set<string>();
  let duplicates = 0, invalid = 0, capabilityFailures = 0;
  for (const run of allRuns) {
    for (const call of deps.store.runs.toolCalls(run.id)) {
      const key = `${run.sessionId}:${call.name}:${call.argsSummary}`;
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }
  }
  for (const call of calls) {
    if (call.status === 'failed' && /INVALID|NOT_AUTHORIZED|UNKNOWN|CONFLICT/.test(call.failure?.code ?? '')) invalid++;
    if (call.status === 'failed' && (call.name === 'discover_capabilities' || call.name === 'enable_capabilities')) capabilityFailures++;
  }
  const recovered = allRuns.flatMap(run => deps.store.runs.events(run.id).filter(event => event.type === 'tool_recovered')).length;
  const failedToolCalls = calls.filter(call => call.status === 'failed' || call.status === 'unknown').length;
  const modelCalls = allRuns.reduce((sum, run) => sum + deps.store.runs.modelCalls(run.id).length, 0);
  const reviews = deps.store.experience.listReviews(tenantId, 100);
  return {
    schemaVersion: 1,
    firstTaskSuccessRate: percent(firstTaskSuccesses, firstTaskRuns),
    takeoverRate: percent(sessionsWithTakeover, bySession.size),
    recoveredAfterFailureRate: percent(failuresRecovered, sessionsWithFailure),
    automaticRecoveryRate: percent(recovered, recovered + failedToolCalls),
    invalidToolCalls: invalid,
    duplicateToolCalls: duplicates,
    capabilitySelectionFailures: capabilityFailures,
    durationMs: allRuns.filter(run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
      .reduce((sum, run) => sum + Math.max(0, run.updatedAt - run.createdAt), 0),
    modelCalls,
    costUsd: Math.round(allRuns.reduce((sum, run) => sum + run.cost, 0) * 1e6) / 1e6,
    experienceReviewCostUsd: Math.round(reviews.reduce((sum, review) => sum + review.budget.costUsd, 0) * 1e6) / 1e6,
    experienceReviewCount: reviews.length,
  };
}

function experienceSummary(deps: RouteDeps, tenantId: string) {
  const reviews = deps.store.experience.listReviews(tenantId, 100);
  const findings = deps.store.experience.findings(tenantId, undefined, 500);
  const scores = reviews.map(reviewScore).flatMap(score => score === null ? [] : [score]);
  return {
    schemaVersion: 1,
    reviewCount: reviews.length,
    negativeReviews: reviews.filter(review => review.verdict === 'negative').length,
    averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 10) / 10 : null,
    undecidedFindings: findings.filter(finding => finding.status === 'new' || finding.status === 'triaged').length,
    openFindings: findings.filter(finding => !['closed', 'wont_fix'].includes(finding.status)).length,
    findings: findings.slice(0, 8),
    recentReviews: reviews.slice(0, 6).map(review => ({
      id: review.id,
      sourceRunIds: review.sourceRunIds,
      sessionId: review.sourceRunIds.flatMap(runId => {
        const run = deps.store.runs.get(runId, tenantId);
        return run ? [run.sessionId] : [];
      })[0],
      status: review.status,
      verdict: review.verdict,
      path: review.path,
      providerId: review.providerId,
      model: review.model,
      originalProviderId: review.originalProviderId,
      originalModel: review.originalModel,
      crossModel: review.crossModel,
      score: reviewScore(review),
      suggestionCount: review.suggestions.length,
      adoptedCount: review.suggestions.filter(suggestion => suggestion.adoptedFindingId).length,
      costUsd: review.budget.costUsd,
      updatedAt: review.updatedAt,
    })),
  };
}
