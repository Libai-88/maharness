import type { Express } from 'express';
import type { PersonalItems } from '../../core/todo/items';
import { tenantIdOf, type RouteDeps } from './shared';

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
    const recentRuns = deps.store.runs.list(tenantId).slice(0, 12);
    const artifacts = recentRuns
      .flatMap(run => deps.store.runs.artifacts(run.id))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, 20);
    const workspace = items.workspace(tenantId).data;
    const metrics = workbenchMetrics(deps, tenantId);
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
    });
  });
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
  };
}
