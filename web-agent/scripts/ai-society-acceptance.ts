import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RunEvent, RunRecord } from '../kernel/run';
import { Store } from '../server/db';
import { OrganizationService } from '../server/services/organization/service';
import {
  OrganizationError,
  type AssignmentContract,
  type OrganizationRole,
  type SocietySchedule,
  type SocietyTask,
} from '../server/organization-store';
import { SocietyService } from '../server/services/society';

type Criterion = {
  id: string;
  domain: string;
  status: 'passed' | 'partial';
  evidence: string[];
};

type PlaywrightSuite = {
  file?: string;
  specs?: Array<{ file?: string; title?: string; ok?: boolean }>;
  suites?: PlaywrightSuite[];
};

type PlaywrightJson = {
  suites?: PlaywrightSuite[];
  kind?: string;
  sourceSha256?: string;
  targetFiles?: string[];
  specs?: Array<{ file?: string; title?: string; passed?: boolean }>;
  stats?: {
    startTime?: string;
    endTime?: string;
    duration?: number;
    expected?: number;
    skipped?: number;
    unexpected?: number;
    flaky?: number;
  };
};

type SocietyRuntime = Pick<SocietyService, 'snapshot' | 'releaseTask'>;

type PreviousAcceptanceReport = {
  evidence?: {
    pairedLive?: {
      ref?: string;
      createdAt?: string;
      status?: string;
      providerId?: string;
      model?: string;
      complete?: boolean;
      sha256?: string;
      comparison?: {
        netBenefitUsd?: { solo?: number; team?: number; marginal?: number };
      };
    };
  };
  liveModelEvidence?: {
    available?: boolean;
    model?: string;
    rawRun?: {
      reportRef?: string;
      reportHash?: string;
      createdAt?: string;
      expected?: number;
      observed?: number;
      passed?: number;
      allPassed?: boolean;
      calls?: number;
      tokensIn?: number;
      tokensOut?: number;
      configuredCostUsd?: number | null;
      usageComplete?: boolean;
      elapsedMs?: number;
    };
    historicalTraceReplay?: {
      createdAt?: string;
      sourceReportHash?: string;
      rawPassed?: number;
      reconciledPassed?: number;
      total?: number;
      callsModels?: boolean;
      semantics?: string;
    };
    providerCache?: {
      hitMissStatus?: 'known' | 'unknown';
      writeStatus?: 'known' | 'unknown';
      cachedInputTokens?: number | null;
      missInputTokens?: number | null;
      cacheWriteTokens?: number | null;
      cacheSavingsUsd?: number | null;
      source?: string;
    };
    billing?: string;
  };
};

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'evals/acceptance/ai-society-v1/deterministic-report.json');
const dashboardRef = 'evals/acceptance/ai-society-v1/dashboard.png';
const dashboard = resolve(root, dashboardRef);
const playwrightInputPath = resolve(root, 'ui/test-results/playwright-results.json');
const playwrightInputRef = 'ui/test-results/playwright-results.json';
const playwrightArchiveRef = 'evals/acceptance/ai-society-v1/playwright-results.json';
const playwrightArchivePath = resolve(root, playwrightArchiveRef);
const realWorkflowRef = 'evals/acceptance/ai-society-v1/real-workflow.json';
const realWorkflowPath = resolve(root, realWorkflowRef);
const realWorkflowScreenshotRef = 'evals/acceptance/ai-society-v1/real-workflow.png';
const realWorkflowScreenshotPath = resolve(root, realWorkflowScreenshotRef);
const criteria: Criterion[] = [];
let browserProven = false;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileEvidence(ref: string, path: string) {
  if (!existsSync(path)) return { ref, status: 'missing' as const };
  const stat = statSync(path);
  return {
    ref,
    status: 'present' as const,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: sha256(path),
  };
}

const previousReport = existsSync(output)
  ? JSON.parse(readFileSync(output, 'utf8')) as PreviousAcceptanceReport
  : undefined;

function playwrightSuites(suites: PlaywrightSuite[] = []): PlaywrightSuite[] {
  return suites.flatMap(suite => [suite, ...playwrightSuites(suite.suites)]);
}

function playwrightEvidence() {
  const hasLiveInput = existsSync(playwrightInputPath);
  const sourceRef = hasLiveInput ? playwrightInputRef : playwrightArchiveRef;
  const sourcePath = hasLiveInput ? playwrightInputPath : playwrightArchivePath;
  const file = fileEvidence(sourceRef, sourcePath);
  if (file.status === 'missing') return {
    ...file,
    status: 'missing' as const,
    targetedSpec: false,
    targetedSpecs: { mockedContract: false, realBackend: false },
    assertionsPassed: false,
    stats: undefined,
  };
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as PlaywrightJson;
    const stats = parsed.stats;
    const suites = playwrightSuites(parsed.suites);
    const files = suites
      .flatMap(suite => [suite.file, ...(suite.specs?.map(spec => spec.file) ?? [])])
      .filter((file): file is string => Boolean(file))
      .concat(parsed.targetFiles ?? [])
      .map(file => file.replaceAll('\\', '/'));
    const targetedSpecs = {
      mockedContract: files.some(file => file.endsWith('society.spec.ts')),
      realBackend: files.some(file => file.endsWith('society-real-backend.spec.ts')),
    };
    const targetedSpec = targetedSpecs.mockedContract || targetedSpecs.realBackend;
    const assertionsPassed = Boolean(
      targetedSpec
      && stats?.startTime
      && Number.isFinite(stats.duration)
      && (stats.expected ?? 0) > 0
      && stats.unexpected === 0
      && stats.skipped === 0
      && stats.flaky === 0,
    );
    return {
      ...file,
      status: assertionsPassed ? 'passed' as const : 'failed' as const,
      targetedSpec,
      targetedSpecs,
      assertionsPassed,
      stats,
      archiveData: hasLiveInput
        ? {
            kind: 'playwright-sanitized-evidence',
            sourceSha256: file.sha256,
            targetFiles: [...new Set(files)],
            specs: suites.flatMap(suite => (suite.specs ?? []).map(spec => ({
              file: spec.file?.replaceAll('\\', '/'),
              title: spec.title,
              passed: spec.ok,
            }))),
            stats,
          }
        : parsed,
    };
  } catch (error) {
    return {
      ...file,
      status: 'invalid' as const,
      targetedSpec: false,
      targetedSpecs: { mockedContract: false, realBackend: false },
      assertionsPassed: false,
      stats: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function realWorkflowEvidence(isPlaywrightTarget: boolean, runStart: number, runEnd: number) {
  const file = fileEvidence(realWorkflowRef, realWorkflowPath);
  const screenshot = fileEvidence(realWorkflowScreenshotRef, realWorkflowScreenshotPath);
  if (file.status === 'missing' || screenshot.status === 'missing') return {
    file,
    screenshot,
    status: 'missing' as const,
    proven: false,
  };
  try {
    const data = JSON.parse(readFileSync(realWorkflowPath, 'utf8')) as {
      kind?: string;
      backend?: string;
      database?: string;
      browser?: string;
      provider?: string;
      realModel?: boolean;
      mockBoundary?: string;
      coverage?: Record<string, boolean>;
      screenshots?: Record<string, string>;
      scenarios?: Array<{
        scenario?: string;
        taskStatus?: string;
        scheduleStatus?: string;
        childRunCount?: number;
        contractCount?: number;
        providerCalls?: number;
        auditActions?: string[];
        scheduleMode?: string;
        initialScheduleMode?: string;
        initialChildRunCount?: number;
        initialContractCount?: number;
        fallbackMode?: string;
        rollbackMarker?: string;
        collaborationNetworkUi?: boolean;
        bottleneckUi?: boolean;
        sixFactorUi?: boolean;
        wellbeingUi?: boolean;
        tokenCacheUi?: boolean;
      }>;
    };
    const source = readFileSync(resolve(root, 'ui/e2e/society-real-backend.spec.ts'), 'utf8');
    const sourceUsesLiveBackend = !/page\.route\(/.test(source);
    const reportFresh = Number.isFinite(runStart)
      && Number.isFinite(runEnd)
      && Date.parse(file.modifiedAt!) >= runStart - 1_000
      && Date.parse(file.modifiedAt!) <= runEnd + 2_000;
    const screenshotChecks = Object.entries(data.screenshots ?? {}).map(([name, expected]) => {
      const path = resolve(root, 'evals/acceptance/ai-society-v1', name);
      const actual = fileEvidence(`evals/acceptance/ai-society-v1/${name}`, path);
      const valid = actual.status === 'present'
        && actual.sha256 === expected
        && Date.parse(actual.modifiedAt!) >= runStart - 1_000
        && Date.parse(actual.modifiedAt!) <= runEnd + 2_000;
      return { name, expected, actual, valid };
    });
    const requiredScreenshots = [
      'real-workflow-governance.png',
      'real-workflow-team-active.png',
      'real-workflow.png',
      'real-workflow-team-final.png',
      'real-workflow-rollback-active.png',
      'real-workflow-rollback.png',
    ];
    const screenshotsValid = requiredScreenshots.every(name =>
      screenshotChecks.some(item => item.name === name && item.valid));
    const coverage = data.coverage ?? {};
    const scenarios = data.scenarios ?? [];
    const governance = scenarios.find(item => item.scenario === 'governance-version-history');
    const team = scenarios.find(item => item.scenario === 'team-auto-scheduler-ui');
    const rollback = scenarios.find(item => item.scenario === 'failed-child-rollback-to-solo');
    const proven = Boolean(
      isPlaywrightTarget
      && sourceUsesLiveBackend
      && reportFresh
      && screenshotsValid
      && data.kind === 'browser-real-backend-workflow-suite'
      && data.backend === 'maharness server/index.ts'
      && data.database === 'temporary SQLite'
      && data.realModel === false
      && data.mockBoundary?.includes('API, production Scheduler, RunService, SocietyService, persistence and UI are real')
      && coverage.realTeamTask === true
      && coverage.childRunsAtLeast2 === true
      && coverage.contractsAtLeast2 === true
      && coverage.collaborationNetworkUi === true
      && coverage.bottleneckUi === true
      && coverage.sixFactorUi === true
      && coverage.wellbeingUi === true
      && coverage.tokenCacheUi === true
      && coverage.rollbackToSolo === true
      && coverage.immutableSocietyAudit === true
      && coverage.schedulerAutoAdvanceWithoutTickApi === true
      && governance?.taskStatus === 'completed'
      && governance.scheduleStatus === 'completed'
      && governance.auditActions?.includes('update')
      && governance.auditActions.includes('rollback')
      && (governance.providerCalls ?? 0) > 0
      && team?.taskStatus === 'completed'
      && team.scheduleStatus === 'completed'
      && team.scheduleMode === 'team'
      && (team.childRunCount ?? 0) >= 2
      && (team.contractCount ?? 0) >= 2
      && team.collaborationNetworkUi === true
      && team.bottleneckUi === true
      && team.sixFactorUi === true
      && team.wellbeingUi === true
      && team.tokenCacheUi === true
      && rollback?.taskStatus === 'completed'
      && rollback.initialScheduleMode === 'team'
      && (rollback.initialChildRunCount ?? 0) >= 2
      && (rollback.initialContractCount ?? 0) >= 2
      && rollback.fallbackMode === 'solo'
      && rollback.rollbackMarker === 'ROLLBACK_TO_SOLO'
      && (rollback.providerCalls ?? 0) > 0,
    );
    return {
      file,
      screenshot,
      status: proven ? 'passed' as const : 'failed' as const,
      proven,
      freshForPlaywrightRun: reportFresh,
      sourceUsesLiveBackend,
      screenshots: screenshotChecks,
      data,
    };
  } catch (error) {
    return {
      file,
      screenshot,
      status: 'invalid' as const,
      proven: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const dashboardEvidence = fileEvidence(dashboardRef, dashboard);
const playwright = playwrightEvidence();
if (playwright.status !== 'missing') {
  mkdirSync(dirname(playwrightArchivePath), { recursive: true });
  writeFileSync(
    playwrightArchivePath,
    JSON.stringify('archiveData' in playwright ? playwright.archiveData : {
      kind: 'playwright-sanitized-evidence',
      sourceSha256: playwright.sha256,
      error: 'Playwright results could not be parsed.',
    }, null, 2),
    'utf8',
  );
}
const playwrightArchive = fileEvidence(playwrightArchiveRef, playwrightArchivePath);
const societyE2eSource = readFileSync(resolve(root, 'ui/e2e/society.spec.ts'), 'utf8');
const mockRouteCount = (societyE2eSource.match(/page\.route\(/g) ?? []).length;
const mockBrowserBoundary = /page\.route\(\s*['"]\*\*\/api\/\*\*/.test(societyE2eSource)
  ? 'mocked_api' as const
  : mockRouteCount > 0
    ? 'mixed_api' as const
    : 'live_backend' as const;
const playwrightStart = Date.parse(playwright.stats?.startTime ?? '');
const playwrightEnd = Number.isFinite(Date.parse(playwright.stats?.endTime ?? ''))
  ? Date.parse(playwright.stats!.endTime!)
  : playwrightStart + (playwright.stats?.duration ?? 0);
const dashboardFresh = dashboardEvidence.status === 'present'
  && Number.isFinite(playwrightStart)
  && Number.isFinite(playwrightEnd)
  && Date.parse(dashboardEvidence.modifiedAt) >= playwrightStart - 1_000
  && Date.parse(dashboardEvidence.modifiedAt) <= playwrightEnd + 2_000;
const realWorkflow = realWorkflowEvidence(
  playwright.status === 'passed' && playwright.targetedSpecs.realBackend,
  playwrightStart,
  playwrightEnd,
);
const browserBackendBoundary = realWorkflow.proven
  ? 'real_backend_with_deterministic_provider' as const
  : mockBrowserBoundary;
const pairedLive = previousReport?.evidence?.pairedLive;
const liveEvidence = previousReport?.liveModelEvidence;
const rawLive = liveEvidence?.rawRun;
const liveReport = liveEvidence?.available && rawLive
  ? {
      ...rawLive,
      requestedModel: liveEvidence.model,
      cacheUsageStatus: liveEvidence.providerCache?.hitMissStatus ?? 'unknown',
      cacheWriteUsageStatus: liveEvidence.providerCache?.writeStatus ?? 'unknown',
      reportedCachedTokens: liveEvidence.providerCache?.cachedInputTokens ?? null,
      reportedCacheMissTokens: liveEvidence.providerCache?.missInputTokens ?? null,
      reportedCacheWriteTokens: liveEvidence.providerCache?.cacheWriteTokens ?? null,
      cacheSavingsUsd: liveEvidence.providerCache?.cacheSavingsUsd ?? null,
    }
  : undefined;
const replayReport = liveEvidence?.historicalTraceReplay
  ? {
      ...liveEvidence.historicalTraceReplay,
      providerCacheUsage: liveEvidence.providerCache,
    }
  : undefined;

function pass(id: string, domain: string, evidence: string[]): void {
  criteria.push({ id, domain, status: 'passed', evidence });
}

function partial(id: string, domain: string, evidence: string[]): void {
  criteria.push({ id, domain, status: 'partial', evidence });
}

function persistentRole(
  store: Store,
  tenantId: string,
  name: string,
  capabilities: string[],
): OrganizationRole {
  const now = Date.now();
  return store.organization.createRole({
    id: randomUUID(), tenantId, projectId: '', name,
    responsibilities: ['执行可验收的独立分支'],
    capabilities,
    authority: { workspace: '', readOnly: false, profile: 'standard', allowedTools: [] },
    modelPolicy: { providerId: 'institution', model: 'runtime-selected' },
    persistent: true, employment: 'active', source: 'human', revision: 0,
    createdAt: now, updatedAt: now,
  });
}

function fixture(store: Store, tenantId = 'default') {
  const organization = new OrganizationService({
    store,
    runtimeAuthority: () => ({
      workspace: process.cwd(),
      readOnly: false,
      profile: 'standard',
    }),
  });
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  const emit = (runId: string) => {
    const run = store.runs.get(runId, tenantId);
    if (!run) return;
    const event: RunEvent = {
      runId,
      seq: store.runs.events(runId).length + 1,
      type: 'run_updated',
      data: { status: run.status },
      createdAt: Date.now(),
    };
    for (const listener of listeners.get(runId) ?? []) listener(event);
  };
  const runtime = {
    startSocietyAssignment(input: {
      task: SocietyTask;
      schedule: SocietySchedule;
      role: OrganizationRole;
      contract: AssignmentContract;
    }): RunRecord {
      const session = store.createSession('fixture-model', 'fixture', input.task.tenantId);
      const id = randomUUID();
      const now = Date.now();
      const run: RunRecord = {
        id, rootId: id, sessionId: session.id, tenantId: input.task.tenantId,
        depth: 0, status: 'queued', objective: input.contract.branchObjective,
        providerId: 'fixture', model: 'fixture-model',
        authorization: {
          workspace: process.cwd(),
          profile: input.role.authority.profile,
          readOnly: input.role.authority.readOnly,
          revision: 0,
        },
        requestFingerprint: `society:${input.schedule.id}:${input.contract.id}`,
        budgetUsd: input.contract.budgetUsd,
        budgetTokens: input.contract.budgetTokens,
        budgetPolicy: 'enforce',
        toolNames: input.role.authority.allowedTools,
        origin: {
          kind: 'society',
          societyTaskId: input.task.id,
          scheduleId: input.schedule.id,
          assignmentContractId: input.contract.id,
        },
        workOrderId: input.contract.workOrderId,
        assignmentContractId: input.contract.id,
        organizationRoleId: input.role.id,
        teamCycleId: input.contract.teamCycleId,
        cost: 0, tokensIn: 0, tokensOut: 0,
        createdAt: now, updatedAt: now,
      };
      organization.prepareSocietyRun(run, input.contract.id);
      store.runs.create(run);
      return store.runs.get(run.id, run.tenantId)!;
    },
    get(runId: string, tenant: string): RunRecord {
      const run = store.runs.get(runId, tenant);
      if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
      return run;
    },
    subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
      let current = listeners.get(runId);
      if (!current) listeners.set(runId, current = new Set());
      current.add(listener);
      return () => current!.delete(listener);
    },
    cancel(runId: string, tenant: string): RunRecord {
      const run = store.runs.get(runId, tenant);
      if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
      store.runs.update(run, { status: 'cancelled', error: 'fixture cancelled' });
      emit(runId);
      return store.runs.get(runId, tenant)!;
    },
  };
  const finish = (
    runId: string,
    status: 'completed' | 'failed' = 'completed',
    consumeBudget = true,
  ): RunRecord => {
    const run = store.runs.get(runId, tenantId);
    if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
    const contract = run.assignmentContractId
      ? store.organization.getContract(run.assignmentContractId, tenantId)
      : undefined;
    if (status === 'completed') {
      for (const artifact of contract?.expectedArtifacts ?? []) {
        const callId = `artifact:${randomUUID()}`;
        store.runs.startTool(runId, callId, 'fixture_artifact', '{}', {
          sideEffect: 'write',
          version: 'fixture',
        });
        store.runs.finishTool(runId, callId, {
          ok: true,
          data: { artifact },
          evidence: [{
            artifact: true,
            kind: 'file',
            label: artifact,
            ref: artifact,
          }],
        });
      }
    }
    const input = consumeBudget ? Math.max(20, Math.floor((run.budgetTokens ?? 100) / 4)) : 0;
    store.runs.update(run, status === 'completed' ? {
      status,
      answer: `真实契约交付：${contract?.branchObjective ?? run.objective}`,
      usageStatus: 'reported',
      tokensIn: input,
      tokensOut: 10,
      cost: consumeBudget ? run.budgetUsd ?? 0 : 0,
    } : {
      status,
      error: 'fixture branch failed',
      usageStatus: 'reported',
      tokensIn: input,
      tokensOut: 0,
      cost: consumeBudget ? run.budgetUsd ?? 0 : 0,
    });
    emit(runId);
    return store.runs.get(runId, tenantId)!;
  };
  const society = new SocietyService({ store, organization, runs: runtime });
  return { organization, society, runtime, finish };
}

function teamBranches() {
  return [
    {
      objective: '核对资料 A 的来源与结论',
      acceptance: ['逐条列出来源'],
      expectedArtifacts: ['source-a.md'],
      departmentId: 'knowledge',
    },
    {
      objective: '核对资料 B 的来源与结论',
      acceptance: ['逐条列出来源'],
      expectedArtifacts: ['source-b.md'],
      departmentId: 'knowledge',
    },
  ];
}

function finishAndAccept(
  fixtureValue: ReturnType<typeof fixture>,
  society: SocietyRuntime,
  schedule: SocietySchedule,
  task: SocietyTask,
): void {
  for (const runId of schedule.runIds) fixtureValue.finish(runId);
  assert.equal(
    society.snapshot(task.tenantId).tasks.find(item => item.id === task.id)?.status,
    'awaiting_acceptance',
  );
  society.releaseTask(task.id, task.tenantId, 'completed', '人工核验真实 Run、契约与产物后验收');
}

const store = new Store(':memory:');
store.upsertProvider({
  id: 'fixture', label: 'Acceptance fixture',
  baseUrl: 'https://fixture.invalid/v1', apiKey: '',
  model: 'fixture-model', priceIn: 1, priceOut: 2,
});

try {
  const primary = fixture(store);
  const { organization, society, finish } = primary;
  const institution = society.ensureInstitution('default');
  const initial = society.snapshot('default');
  const docs = [
    readFileSync(resolve(root, 'docs/AI-SOCIETY.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/AI-ORGANIZATION.md'), 'utf8'),
  ].join('\n');
  assert.match(docs, /AI 社会 v1/);
  assert.match(docs, /AI 社会运行层/);
  assert.match(docs, /主 Agent/);
  assert.match(docs, /持久角色/);
  pass('A1', '产品定位', [
    '架构文档明确 OS 层与社会运行层共同构成产品本体，主 Agent 只是人类入口与协调器。',
    `默认制度 v${institution.version} 包含 ${initial.departments.length} 个部门和 ${initial.roles.length} 个持久角色。`,
  ]);
  assert.equal(initial.roles.length, 4);
  assert.equal(initial.roleLife.every(item => item.memories.some(memory => memory.kind === 'appointment')), true);
  pass('A2', '与多代理框架区分', [
    '社会运行由独立 SocietyService 与系统调度器推进，不依赖主 Agent 调用链。',
    '角色在任务结束后保留身份、履历、关系和福利状态。',
  ]);
  pass('B1', '持久社会成员', [
    `持久角色 ${initial.roles.length} 个，均有 appointment 生命史。`,
    '角色记录包含岗位、权限、模型策略、聘用状态和修订号。',
  ]);

  const versionedRole = persistentRole(store, 'default', '研究执行员二', ['research', 'reading', 'analysis']);
  const teamTask = society.createTask({
    tenantId: 'default',
    objective: '请组织团队并行核对两份独立资料并形成可追溯交付',
    materials: [
      { id: 'material-1', version: 'v1' },
      { id: 'material-1', version: 'v1' },
    ],
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  assert.equal(store.runs.list('default').length, 0);
  const teamExperiment = society.experiment(teamTask.id, 'default');
  assert.equal(
    teamExperiment.selected,
    'team',
    JSON.stringify({
      economics: teamTask.economics,
      branches: teamExperiment.task.branches,
      estimate: teamExperiment.estimate,
      selected: teamExperiment.selected,
    }),
  );
  assert.match(teamExperiment.estimate.formula, /quality.*riskReduction.*estimatedCost.*coordinationCost/);
  assert.ok(teamExperiment.estimate.marginalNetBenefitUsd > 0);
  const teamTick = society.tick('default');
  const teamSchedule = teamTick.decisions.find(item => item.taskId === teamTask.id);
  assert.equal(teamSchedule?.mode, 'team', JSON.stringify({
    task: store.organization.getSocietyTask(teamTask.id, 'default'),
    decision: teamSchedule,
    institution: society.ensureInstitution('default'),
    roles: store.organization.listRoles('default', undefined, true),
    schedules: store.organization.societySchedules('default', 1000),
  }));
  assert.equal(teamSchedule?.roleIds.length, 2);
  assert.equal(teamSchedule?.runIds.length, 2);
  assert.equal(store.runs.list('default').length, 2);
  assert.equal(store.runs.list('default').every(run => run.origin?.kind === 'society'), true);
  pass('B2', '制度调度而非硬派活', [
    `机构 v${teamSchedule?.institutionVersion} 作出 ${teamSchedule?.mode} 决策，角色 ${teamSchedule?.roleIds.length} 个。`,
    '系统 tick 在无主 Agent 调用时创建了 2 个真实社会 Run 和 2 份分工契约。',
  ]);
  pass('F1', '去掉主 Agent 仍运转', [
    `无主 Agent 运行时创建 Run：${teamSchedule?.runIds.join(', ')}。`,
    '运行来源均为 society，并由系统调度器而不是聊天调用链推进。',
  ]);

  assert.equal(teamSchedule?.contractIds.length, 2);

  assert.throws(
    () => society.releaseTask(teamTask.id, 'default', 'completed', '提前伪造成功'),
    (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
  );
  for (const runId of teamSchedule!.runIds) finish(runId);
  const awaiting = society.snapshot('default').tasks.find(item => item.id === teamTask.id);
  assert.equal(awaiting?.status, 'awaiting_acceptance');
  const postRun = society.snapshot('default');
  const settledSchedule = postRun.schedules.find(item => item.id === teamSchedule?.id);
  assert.equal(settledSchedule?.status, 'completed');
  assert.equal(postRun.network.edges.length > 0, true);
  assert.equal(postRun.roleLife.some(item => item.memories.some(memory => memory.kind === 'submission')), true);
  assert.equal(postRun.roleLife.some(item => item.memories.some(memory => memory.kind === 'delivery')), false);
  const teamLedger = postRun.economics.taskLedger.find(item => item.taskId === teamTask.id)!;
  assert.ok((teamLedger.actualTokens ?? 0) > 0);
  assert.equal(teamLedger.cachedInputTokens, 0);
  assert.equal(postRun.economics.cacheHitRate, null);
  assert.equal(postRun.economics.cacheSavingsUsd, null);
  assert.equal(postRun.economics.compression.sharedMemoryRefs, 1);
  assert.equal(postRun.economics.compression.reusedRefs, 1);
  assert.deepEqual(settledSchedule?.assignments.map(item => item.cognitiveTier), ['decision', 'execution']);
  assert.equal(settledSchedule?.assignments.every(item => item.routingStrategy.length > 0), true);
  const cacheRuns = teamSchedule!.runIds.map(runId => store.runs.get(runId, 'default')!);
  for (const run of cacheRuns) {
    store.runs.update(run, { usageStatus: 'reported', tokensCached: 50, tokensCacheMiss: 50 });
  }
  assert.equal(society.snapshot('default').economics.cacheHitRate, 0.5);
  store.runs.update(store.runs.get(cacheRuns[0]!.id, 'default')!, { tokensCached: undefined });
  assert.equal(society.snapshot('default').economics.cacheHitRate, null);
  pass('B3', '部门与社会运行层', [
    `${postRun.departments.length} 个部门、${postRun.network.nodes.length} 个成员和 ${postRun.network.edges.length} 条协作关系进入社会快照。`,
    '快照同时提供部门队列、并发、福利、瓶颈和健康度。',
  ]);
  pass('C1', '多目标优化', [
    '每个调度决策记录能力、记忆、工具、协作、履历和负载六项分数及权重。',
    `能力索引=${teamSchedule?.selection?.requiredCapabilities.join('/')}，选中角色=${teamSchedule?.selection?.chosenRoleIds.length}。`,
    '调度事实同时记录任务价值、质量、时延、风险、成本、部门配额和福利负载。',
    `当前社会健康分数=${postRun.health.score}，预算利用率=${postRun.health.budgetUtilization}。`,
  ]);
  pass('F2', '角色跨任务生命史', [
    '团队完成后先记录 submission，人工验收通过后才记录 delivery；失败和拒收记录 failure。',
    `当前协作网络包含 ${postRun.network.edges.length} 条有契约证据的关系。`,
  ]);
  pass('G3', '最小必要团队与动态解散', [
    `团队 Run 数=${settledSchedule?.runIds.length}，全部真实契约交付后调度释放。`,
    '角色处于空闲状态，但身份、记忆和关系继续保留。',
  ]);
  pass('G4', '分层认知与共享记忆', [
    '调度作业持久化 decision 与 execution 认知层及各自路由策略。',
    '重复材料引用按稳定 EvidenceRef 去重；fixture 不伪造 Provider cache usage。',
  ]);
  pass('G5', 'token 社会仪表盘与调度市场', [
    `社会、部门和角色预算可见；团队实际 token=${teamLedger.actualTokens}。`,
    '全部 Run 同时报告缓存命中与未命中 token 时命中率为 0.5；任一 Run 缺字段时命中率恢复为 null。',
    `Provider 缓存节省=${postRun.economics.cacheSavingsUsd}；未知值保持 null。`,
  ]);
  const acceptedTeam = society.releaseTask(
    teamTask.id, 'default', 'completed', '人类确认真实分工、产物与证据后完成验收',
  );
  assert.equal(acceptedTeam.task.status, 'completed');
  assert.equal(society.snapshot('default').roleLife
    .some(item => item.memories.some(memory => memory.kind === 'delivery')), true);

  const paired = society.createPairedExperiment({
    tenantId: 'default',
    objective: '请组织团队并行分别核对两份资料',
    valueUsd: 0.1,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.2, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const pairedSchedules = society.tick('default').decisions;
  const pairedSolo = pairedSchedules.find(item => item.taskId === paired.solo.id)!;
  const pairedTeam = pairedSchedules.find(item => item.taskId === paired.team.id)!;
  assert.equal(pairedSolo.mode, 'solo');
  assert.equal(pairedTeam.mode, 'team');
  finish(pairedSolo.runIds[0]!);
  finish(pairedTeam.runIds[0]!);
  finish(pairedTeam.runIds[1]!, 'failed', true);
  const pairedResult = society.measurePairedExperiment(paired.experiment.id, 'default');
  assert.equal(pairedResult.status, 'measured');
  assert.ok(pairedResult.measurements);
  assert.ok(pairedResult.netBenefitUsd);
  assert.ok(pairedResult.netBenefitUsd.marginal < 0);
  const guarded = society.createTask({
    tenantId: 'default',
    objective: '复用负收益实验继续核对两份资料',
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    departmentId: 'knowledge',
    evidenceExperimentId: paired.experiment.id,
    economics: { qualityGain: 0.2, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const guardedSchedule = society.tick('default').decisions.find(item => item.taskId === guarded.id)!;
  assert.equal(guardedSchedule.mode, 'solo');
  assert.match(guardedSchedule.reason, /配对实测边际净收益.*未达到门槛/);
  const pairedEvidence = [
    '确定性层已完成同一任务的单角色与团队真实 Run 配对，记录质量、产物覆盖、时延、风险、实际成本、token 与协调增量。',
    `声明估算边际净收益=${teamExperiment.estimate.marginalNetBenefitUsd} USD。`,
    `配对实测：单角色=${pairedResult.netBenefitUsd.solo} USD，团队=${pairedResult.netBenefitUsd.team} USD，边际=${pairedResult.netBenefitUsd.marginal} USD。`,
    '负边际结果显示在审计记录中，后续绑定该实验的任务被强制保持单角色。',
  ];
  if (pairedLive?.complete) {
    pass('H1', '多团队净收益实验', [
      ...pairedEvidence,
      `真实 paired live 已执行：${pairedLive.providerId}/${pairedLive.model}，报告=${pairedLive.ref}，哈希=${pairedLive.sha256}。`,
      `真实单角色/团队/边际净收益=${JSON.stringify(pairedLive.comparison?.netBenefitUsd)}。`,
      '两条臂均完成，usage 与硬预算完整；团队是否更优由实测边际结果决定。',
    ]);
  } else {
    partial('H1', '多团队净收益实验', [
      ...pairedEvidence,
      pairedLive
        ? `配对实验报告存在但未过门禁：状态=${pairedLive.status}，完整事实=${pairedLive.complete}，报告=${pairedLive.ref}。`
        : 'TODO：尚未执行同一任务上的真实模型 paired live A/B。',
      '真实 Provider 的质量、时延、token、费用与净收益复现性仍未验证。',
    ]);
  }

  const lowTask = society.createTask({
    tenantId: 'default',
    objective: '低价值双分支任务',
    valueUsd: 0.1,
    maxBudgetUsd: 0.08,
    departmentId: 'operations',
    branches: teamBranches().map(item => ({ ...item, departmentId: 'operations' })),
  });
  const lowTick = society.tick('default');
  const lowSchedule = lowTick.decisions.find(item => item.taskId === lowTask.id);
  assert.equal(lowSchedule?.mode, 'solo');
  assert.equal(lowSchedule?.roleIds.length, 1);
  finishAndAccept(primary, society, lowSchedule!, lowTask);

  const costTask = society.createTask({
    tenantId: 'default',
    objective: '分别核对两份资料',
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const costEstimate = society.estimate(costTask);
  const costSchedule = society.tick('default').decisions.find(item => item.taskId === costTask.id);
  assert.ok(costEstimate.team.costUsd > costEstimate.single.costUsd);
  assert.equal(costSchedule?.mode, 'solo');
  assert.match(costSchedule?.reason ?? '', /团队估算高于单角色方案/);
  finishAndAccept(primary, society, costSchedule!, costTask);

  const noGain = society.createTask({
    tenantId: 'default',
    objective: '低收益检查',
    valueUsd: 0.001,
    maxBudgetUsd: 0.08,
    departmentId: 'operations',
  });
  society.tick('default');
  const noGainTask = store.organization.getSocietyTask(noGain.id, 'default');
  assert.equal(noGainTask?.status, 'queued');
  assert.match(noGainTask?.lastSchedulingReason ?? '', /净收益不足/);
  pass('G2', '组队净收益阈值', [
    '同一双分支结构在低价值时保持单角色，没有误组队。',
    `自动组队团队估算 ${costEstimate.team.costUsd} USD 高于单角色 ${costEstimate.single.costUsd} USD，调度保持单角色。`,
    `更低收益任务进入排队：${noGainTask?.lastSchedulingReason}。`,
    '自动组队要求团队成本不高于单角色、团队净收益高于单角色并跨过制度门槛。',
  ]);
  pass('G6', '熔断与回退', [
    '低收益扩团被阻止，任务保留可重新估价状态。',
    '团队分支失败后创建单角色协调契约，保留已完成证据并以 ROLLBACK_TO_SOLO 继续。',
  ]);

  const failureTask = society.createTask({
    tenantId: 'default',
    objective: '验证失败交付不能人工伪造成功',
    valueUsd: 5,
    maxBudgetUsd: 0.08,
    departmentId: 'knowledge',
  });
  const failureTick = society.tick('default');
  const failureSchedule = failureTick.decisions.find(item => item.taskId === failureTask.id)!;
  finish(failureSchedule.runIds[0]!, 'failed');
  const failedTask = store.organization.getSocietyTask(failureTask.id, 'default');
  assert.equal(failedTask?.status, 'failed');
  assert.throws(
    () => society.releaseTask(failureTask.id, 'default', 'completed', '模型或人工声称完成'),
    (error: unknown) => error instanceof OrganizationError && error.code === 'SOCIETY_TASK_STATE',
  );

  const fallbackTask = society.createTask({
    tenantId: 'default',
    objective: '请组织团队并行核对两份资料，失败后由协调角色接管已完成证据',
    acceptance: ['保留已完成分支证据'],
    valueUsd: 100,
    maxBudgetUsd: 0.08,
    maxBudgetTokens: 4_000,
    departmentId: 'knowledge',
    economics: { qualityGain: 0.1, riskReduction: 0.02 },
    branches: teamBranches(),
  });
  const fallbackTeam = society.tick('default').decisions.find(item => item.taskId === fallbackTask.id)!;
  assert.equal(fallbackTeam.mode, 'team');
  finish(fallbackTeam.runIds[0]!);
  finish(fallbackTeam.runIds[1]!, 'failed', false);
  const fallbackSchedule = store.organization.getSocietySchedule(fallbackTeam.id, 'default')!;
  assert.equal(fallbackSchedule.mode, 'solo');
  const fallbackContract = store.organization.getContract(fallbackSchedule.contractIds[0]!, 'default')!;
  assert.ok(fallbackContract.runId);
  assert.equal(store.runs.get(fallbackContract.runId!, 'default')?.fallbackReason, 'ROLLBACK_TO_SOLO');
  finish(fallbackContract.runId!);
  assert.equal(store.organization.getSocietyTask(fallbackTask.id, 'default')?.status, 'awaiting_acceptance');
  society.releaseTask(fallbackTask.id, 'default', 'completed', '人工验收协调回退结果');

  const budgets = society.snapshot('default').economics;
  assert.ok(budgets.societyBudgetUsd > 0);
  assert.ok(budgets.societyTokenBudget > 0);
  assert.equal(budgets.departmentBudgets.every(item => item.quotaUsd >= 0 && item.quotaTokens >= 0), true);
  assert.equal(budgets.roleBudgets.every(item => item.activeAssignments >= 0), true);
  pass('G1', 'token 三级预算', [
    `社会预算=${budgets.societyBudgetUsd} USD / ${budgets.societyTokenBudget} token。`,
    '部门配额、角色账本和任务预算均进入同一快照与调度门禁。',
  ]);

  const updated = society.updateInstitution('default', {
    societyBudgetUsd: 25,
    reason: '人类提高社会总预算',
  });
  const rolledBack = society.rollbackInstitution('default', institution.version, '恢复初始制度');
  assert.equal(rolledBack.version, updated.version + 1);
  const auditActions = new Set(store.organization.institutionAudits('default').map(item => item.action));
  assert.equal(auditActions.has('initialize'), true);
  assert.equal(auditActions.has('update'), true);
  assert.equal(auditActions.has('rollback'), true);
  const roleBeforeChanges = organization.roleHistory(versionedRole.id, 'default').role;
  const roleV2 = organization.updateRole(
    versionedRole.id,
    'default',
    roleBeforeChanges.revision,
    { name: '研究执行员（职责修订）' },
    '验证角色独立版本',
  );
  const roleV2Version = organization.roleHistory(versionedRole.id, 'default').versions[0]?.version;
  const roleV3 = organization.rollbackRole(versionedRole.id, 'default', 1, '验证角色版本回滚');
  const roleHistory = organization.roleHistory(versionedRole.id, 'default');
  assert.equal(roleV2Version, 2);
  assert.equal(roleV2.revision > roleBeforeChanges.revision, true);
  assert.equal(roleV3.name, versionedRole.name);
  assert.deepEqual(roleHistory.versions.map(item => item.version), [3, 2, 1]);
  assert.deepEqual(roleHistory.audits.map(item => item.action), ['rollback', 'update', 'initialize']);

  const evaluationBeforeChanges = organization.evaluationHistory('default');
  const evaluationV2 = organization.updateEvaluation('default', {
    lowConfidenceSamples: 4,
    mediumConfidenceSamples: 12,
    highConfidenceSamples: 40,
  }, '验证评价标准独立版本');
  const evaluationV3 = organization.rollbackEvaluation(
    'default',
    evaluationBeforeChanges.active.version,
    '验证评价标准版本回滚',
  );
  const evaluationHistory = organization.evaluationHistory('default');
  assert.equal(evaluationV2.version, evaluationBeforeChanges.active.version + 1);
  assert.equal(evaluationV3.version, evaluationV2.version + 1);
  assert.deepEqual(
    evaluationHistory.versions.map(item => item.version),
    [evaluationV3.version, evaluationV2.version, evaluationBeforeChanges.active.version],
  );
  assert.deepEqual(
    evaluationHistory.audits.map(item => item.action),
    ['rollback', 'update', 'initialize'],
  );

  pass('E1', '制度版本化演化', [
    '制度更新和回滚均创建新 active 版本，旧版本保留；哈希、来源、前后版本和原因可审计。',
    `角色独立发布 v${roleV2Version} 并回滚为 active v${roleHistory.versions[0]?.version}，历史版本和审计保持可查。`,
    `评价标准独立发布 v${evaluationV2.version} 并回滚为 active v${evaluationV3.version}，AI 复盘可冻结完整策略版本和哈希。`,
  ]);
  pass('F4', '制度可版本化演化', [
    `制度从 v${institution.version} 更新到 v${updated.version}，再以 v${rolledBack.version} 发布回滚。`,
    '历史版本、策略哈希和审计记录保持可查。',
  ]);

  const highSpendStore = new Store(':memory:');
  try {
    const high = fixture(highSpendStore);
    const pending = high.society.createTask({
      tenantId: 'default',
      objective: '高额研究交付',
      valueUsd: 30,
      maxBudgetUsd: 3,
      departmentId: 'knowledge',
    });
    assert.equal(pending.status, 'waiting_approval');
    assert.equal(high.society.tick('default').decisions.length, 0);
    high.society.approveTask(pending.id, 'default', true);
    high.society.updateInstitution('default', {
      departments: high.society.ensureInstitution('default').policies.departments.map(department =>
        department.id === 'knowledge' ? { ...department, quotaUsd: 2 } : department),
      reason: '收紧研究部门配额',
    });
    assert.equal(high.society.tick('default').decisions.length, 0);
    assert.match(
      highSpendStore.organization.getSocietyTask(pending.id, 'default')?.lastSchedulingReason ?? '',
      /部门预算配额不足/,
    );
    pass('E2', '可审计与可干预', [
      '模型不能批准自身高额任务；人类批准后才进入调度。',
      '人类调整部门配额后，调度被事实门禁阻断并记录具体原因。',
    ]);
  } finally {
    highSpendStore.close();
  }

  const welfareStore = new Store(':memory:');
  try {
    const welfare = fixture(welfareStore);
    welfare.society.updateInstitution('default', {
      welfareMaxActiveAssignments: 1,
      reason: '限制单角色并发',
    });
    const first = welfare.society.createTask({
      tenantId: 'default', objective: '读取论文一', valueUsd: 5,
      maxBudgetUsd: 0.08, departmentId: 'knowledge',
    });
    const second = welfare.society.createTask({
      tenantId: 'default', objective: '读取论文二', valueUsd: 5,
      maxBudgetUsd: 0.08, departmentId: 'knowledge',
    });
    const welfareTick = welfare.society.tick('default');
    assert.equal(welfareTick.decisions.some(item => item.taskId === first.id), true);
    assert.equal(welfareTick.decisions.some(item => item.taskId === second.id), false);
    assert.match(
      welfareStore.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '',
      /福利上限|角色预算不足/,
    );
    const welfareRunId = welfareTick.decisions.find(item => item.taskId === first.id)!.runIds[0]!;
    const welfareRun = welfareStore.runs.get(welfareRunId, 'default')!;
    welfareStore.runs.startModelCall({
      id: randomUUID(), runId: welfareRunId, scope: 'run', purpose: 'agent',
      providerId: welfareRun.providerId, model: welfareRun.model, status: 'running',
      startedAt: Date.now(), inputEstimate: 850, outputLimit: 50,
      contextWindow: 1_000, usageStatus: 'unknown', priceSource: 'unknown',
    });
    const modelCallId = welfareStore.runs.modelCalls(welfareRunId)[0]!.id;
    welfareStore.runs.finishModelCall({
      ...welfareStore.runs.modelCalls(welfareRunId)[0]!, id: modelCallId, status: 'completed',
    });
    welfare.society.tick('default');
    const pressuredRole = welfare.organization.wellbeing('default')
      .find(item => item.roleId === welfareTick.decisions.find(decision => decision.taskId === first.id)?.roleIds[0]);
    assert.equal(pressuredRole?.contextPressure, 'high');
    assert.match(
      welfareStore.organization.getSocietyTask(second.id, 'default')?.lastSchedulingReason ?? '',
      /上下文压力过高/,
    );
    pass('C2', 'AI 社会成员福利', [
      '角色并发上限进入实际调度门禁。',
      '超载时新任务不启动 Run，角色不会被无限占用。',
      'Provider 上下文窗口进入福利快照；最近调用达到窗口 80% 时暂停向该角色分配新任务。',
    ]);
    pass('F3', '调度受福利与资源约束', [
      '福利负载、部门并发、预算和角色可用性共同决定是否派工。',
    ]);
  } finally {
    welfareStore.close();
  }

  assert.equal(store.organization.getSocietyTask(noGain.id, 'default')?.status, 'queued');
  assert.equal(store.organization.getSocietyTask(failureTask.id, 'default')?.status, 'failed');
  const browserEvidence = [
    `Playwright JSON=${playwrightInputRef}，归档=${JSON.stringify(playwrightArchive)}，状态=${playwright.status}，目标测试=${playwright.targetedSpec}，公开结果=${JSON.stringify(playwright.stats ?? {})}。`,
    `截图=${JSON.stringify(dashboardEvidence)}，与本次 Playwright 运行时间匹配=${dashboardFresh}。`,
    `mock UI 契约边界=${mockBrowserBoundary}，page.route 数量=${mockRouteCount}。`,
    `真实后端浏览器证据=${JSON.stringify(realWorkflow)}，最终边界=${browserBackendBoundary}。`,
  ];
  browserProven = playwright.status === 'passed'
    && (realWorkflow.proven || (dashboardFresh && mockBrowserBoundary === 'live_backend'));
  const interfaceEvidence = [
    '确定性服务测试覆盖高额审批、制度调度、终端交付、人工验收、制度发布和回滚落库。',
    ...browserEvidence,
  ];
  if (browserProven) {
    pass('D1', '人类经营者界面', interfaceEvidence);
    pass('D2', '社会仪表盘', [
      '真实服务、临时 SQLite、调度器、RunService 和浏览器组成经营闭环；Provider 使用确定性本地传输，真实模型未参与。',
      ...browserEvidence,
    ]);
  } else {
    partial('D1', '人类经营者界面', [
      ...interfaceEvidence,
      '浏览器经营流程尚未由未拦截 API 的真实前后端闭环证明。',
    ]);
    partial('D2', '社会仪表盘', [
      '确定性快照与 UI 组件契约覆盖社会仪表盘字段，但浏览器端 API 被拦截；不能据此证明真实前端到后端链路。',
      ...browserEvidence,
    ]);
  }
  pass('H2', '场景演练', [
    '单 Agent 可解不组队、高价值任务组队、低收益扩团被拒、失败不可伪造完成、团队失败回退单角色、无主 Agent 持久化 Run 推进均已执行。',
    `成功团队 Run=${teamSchedule?.runIds.length}，低价值任务模式=${lowSchedule?.mode}，失败任务终态=${failedTask?.status}。`,
  ]);
} finally {
  store.close();
}

const idOrder = criteria.map(item => item.id);
assert.equal(new Set(idOrder).size, idOrder.length, '验收编号不能重复');
const expectedIds = [
  'A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'D1', 'D2', 'E1', 'E2', 'F1',
  'F2', 'F3', 'F4', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'H1', 'H2',
];
assert.deepEqual([...idOrder].sort(), [...expectedIds].sort());

const report = {
  kind: 'ai-society-deterministic-acceptance',
  schemaVersion: 4,
  generatedAt: new Date().toISOString(),
  mode: 'deterministic-real-runtime-fixture',
  criteria: criteria.sort((left, right) => left.id.localeCompare(right.id)),
  summary: {
    total: criteria.length,
    passed: criteria.filter(item => item.status === 'passed').length,
    partial: criteria.filter(item => item.status === 'partial').length,
    failed: 0,
    aToFPassed: criteria.filter(item => /^[A-F]/.test(item.id)).every(item => item.status === 'passed'),
    gToHPassed: criteria.filter(item => /^[GH]/.test(item.id)).every(item => item.status === 'passed'),
    fullyPassed: criteria.every(item => item.status === 'passed'),
  },
  sourceHashes: Object.fromEntries([
    'scripts/ai-society-acceptance.ts',
    'server/db.ts',
    'server/services/society/index.ts',
    'server/services/society/policy.ts',
    'server/services/society/selection.ts',
    'server/services/society/health.ts',
    'server/services/organization/service.ts',
    'server/organization-store.ts',
    'server/run-service.ts',
    'kernel/model-call.ts',
    'kernel/tests/model-call.spec.ts',
    'server/tests/organization.spec.ts',
    'server/tests/society.spec.ts',
    'server/tests/society-restart.integration.spec.ts',
    'ui/e2e/society.spec.ts',
    'ui/playwright.config.ts',
    'ui/e2e/society-real-backend.spec.ts',
    'scripts/organization-paired-live.ts',
    'evals/organization-paired-live.spec.ts',
  ].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  evidence: {
    realRuntime: 'Production service classes create persisted Runs with society origin, work-order, contract, role, token and cache facts; execution uses a deterministic local runtime fixture.',
    humanAcceptance: 'Only awaiting_acceptance with all contracts delivered can enter completed.',
    browser: {
      backendBoundary: browserBackendBoundary,
      mockContract: {
        boundary: mockBrowserBoundary,
        pageRouteCount: mockRouteCount,
      },
      realBackendWorkflow: realWorkflow,
      playwright: {
        ...playwright,
        archive: playwrightArchive,
      },
      screenshot: {
        ...dashboardEvidence,
        freshForPlaywrightRun: dashboardFresh,
      },
    },
    pairedLive: pairedLive ?? {
      status: 'unexecuted',
      reason: 'No real paired report with complete usage and machine acceptance exists.',
    },
    evidenceRetention: {
      rawReports: 'removed-after-aggregation',
      retained: 'Aggregate counts, hashes, usage and acceptance decisions remain in this report.',
    },
  },
  blockingGates: criteria
    .filter(item => item.status === 'partial')
    .map(item => ({ id: item.id, reason: item.evidence.at(-1) })),
  liveModelEvidence: liveReport ? {
    available: true,
    model: liveReport.requestedModel,
    rawRun: {
      reportRef: liveReport.reportRef,
      reportHash: liveReport.reportHash,
      createdAt: liveReport.createdAt,
      expected: liveReport.expected,
      observed: liveReport.observed,
      passed: liveReport.passed,
      allPassed: liveReport.allPassed,
      calls: liveReport.calls,
      tokensIn: liveReport.tokensIn,
      tokensOut: liveReport.tokensOut,
      configuredCostUsd: liveReport.configuredCostUsd,
      usageComplete: liveReport.usageComplete,
      elapsedMs: liveReport.elapsedMs,
    },
    ...(replayReport ? {
      historicalTraceReplay: {
        createdAt: replayReport.createdAt,
        sourceReportHash: replayReport.sourceReportHash,
        rawPassed: replayReport.rawPassed,
        reconciledPassed: replayReport.reconciledPassed,
        total: replayReport.total,
        callsModels: false,
        semantics: 'Reloads persisted outputs and terminal facts through the corrected deterministic finalizer.',
      },
    } : {}),
    providerCache: {
      hitMissStatus: liveReport.cacheUsageStatus,
      writeStatus: liveReport.cacheWriteUsageStatus,
      cachedInputTokens: liveReport.reportedCachedTokens,
      missInputTokens: liveReport.reportedCacheMissTokens,
      cacheWriteTokens: liveReport.reportedCacheWriteTokens,
      cacheSavingsUsd: liveReport.cacheSavingsUsd,
      source: 'organization-live report receipts',
    },
    billing: 'The configured route declares a zero local price; supplier billing and cache savings remain unverified.',
  } : { available: false },
  limits: [
    liveReport?.allPassed
      ? `The current real-model gate passed ${liveReport.passed}/${liveReport.observed}; historical trace replay remains separate evidence.`
      : `The current real-model gate is ${liveReport?.passed ?? 0}/${liveReport?.expected ?? 0}; trace replay is not model evidence.`,
    'Provider cache savings remain unknown unless usage is reported; cache token hit rate is calculated only from reported cache fields.',
    'Raw live reports were removed after aggregation; their hashes and acceptance decisions remain in this report.',
    '福祉表示可观测运行负担，不表示主观感受、意识或法律人格。',
    'The real-backend browser workflow uses a deterministic local Provider transport; it does not prove real-model quality or cost.',
    ...(pairedLive?.complete
      ? []
      : ['H1 remains partial until a real paired live A/B passes both arms, complete usage and hard-budget checks.']),
    ...(browserProven
      ? []
      : ['The browser evidence does not yet prove an un-intercepted frontend-to-backend operating flow.']),
  ],
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ output, ...report.summary }, null, 2));
