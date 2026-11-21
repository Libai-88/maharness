import 'dotenv/config';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRunner } from '../core/chat/agent';
import { createProvider } from '../core/chat/provider';
import { globalApprovalBoard } from '../core/chat/approvals';
import { EvaluationBudget, budgetedEvaluationProvider } from '../evals/provider-budget';
import { Kernel } from '../kernel';
import type { RunOptions } from '../kernel/loop';
import type { RunRecord } from '../kernel/run';
import { decryptPurposeSecret, isPurposeEncrypted } from '../kernel/secret-box';
import type { ProviderDef, ToolDef, ToolResult } from '../kernel/types';
import { Store } from '../server/db';
import { OrganizationService } from '../server/services/organization/service';
import { RunService } from '../server/run-service';
import { decryptSecret } from '../server/secrets';

const root = resolve(import.meta.dirname, '..');
const ARTIFACT_A = 'analysis-a.md';
const ARTIFACT_B = 'review-b.md';
const DEFAULT_OBJECTIVE = '从材料中提取三项事实，分别生成 analysis-a.md 和 review-b.md。';
const DEFAULT_MATERIAL = 'ALPHA=17\nBETA=29\nGAMMA=41\n';

export interface PairedLiveConfig {
  reportDir: string;
  providerId: string;
  model: string;
  objective: string;
  material: string;
  valueUsd: number;
  soloBudgetUsd: number;
  teamBudgetUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export type PairedEvidenceMode = 'configured-provider' | 'test-double';

export interface PairedArmReport {
  arm: 'solo' | 'team';
  runId?: string;
  status: 'unexecuted' | 'completed' | 'failed';
  answer: string;
  error?: string;
  elapsedMs: number;
  modelCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  usageComplete: boolean;
  budgetCompliant: boolean;
  checks: Array<{ name: string; passed: boolean }>;
  artifacts: string[];
  artifactHashes: Record<string, string>;
  childRunIds: string[];
  teamCycleId?: string;
  contractIds: string[];
}

export interface PairedLiveReport {
  kind: 'organization-paired-live';
  createdAt: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'unexecuted';
  evidenceMode: PairedEvidenceMode;
  runnerFingerprint: string;
  providerId: string;
  model: string;
  objectiveHash: string;
  materialHash: string;
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
  arms: { solo?: PairedArmReport; team?: PairedArmReport };
  comparison: {
    quality: { solo: number; team: number; marginal: number };
    costUsd: { solo: number; team: number; marginal: number };
    tokens: { solo: number; team: number; marginal: number };
    elapsedMs: { solo: number; team: number; marginal: number };
    coordination: { costUsd: number; tokens: number; elapsedMs: number };
    risk: { solo: number; team: number; marginal: number };
    netBenefitUsd: { solo: number; team: number; marginal: number };
    teamPreferred: boolean;
  } | null;
  reason: string;
  limitations: string[];
}

function validPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
}

export function validatePairedLiveConfig(config: PairedLiveConfig): void {
  if (!config.providerId.trim() || !config.model.trim()) throw new Error('providerId and model are required');
  if (!config.objective.trim() || !config.material.trim()) throw new Error('objective and material are required');
  validPositive(config.valueUsd, 'valueUsd');
  validPositive(config.soloBudgetUsd, 'soloBudgetUsd');
  validPositive(config.teamBudgetUsd, 'teamBudgetUsd');
  if (!Number.isFinite(config.inputUsdPerMillion) || config.inputUsdPerMillion < 0)
    throw new Error('inputUsdPerMillion must be non-negative');
  if (!Number.isFinite(config.outputUsdPerMillion) || config.outputUsdPerMillion < 0)
    throw new Error('outputUsdPerMillion must be non-negative');
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 3) throw new Error('maxCalls must be at least 3');
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 32)
    throw new Error('maxOutputTokens must be at least 32');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000) throw new Error('timeoutMs is invalid');
  if (!config.reportDir.trim()) throw new Error('reportDir is required');
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function runtimeSources(): string[] {
  const entry = join(root, 'scripts/organization-paired-live.ts');
  const sources = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (!absolute.startsWith(root) || sources.has(absolute)) return;
    sources.add(absolute);
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]+)\1/g)) {
      const target = resolve(dirname(absolute), match[2]!);
      const withoutJs = target.replace(/\.jsx?$/, '');
      for (const candidate of [
        target,
        `${withoutJs}.ts`,
        `${withoutJs}.tsx`,
        `${target}.ts`,
        `${target}.tsx`,
        join(target, 'index.ts'),
        join(target, 'index.tsx'),
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          visit(candidate);
          break;
        }
      }
    }
  };
  visit(entry);
  return [...sources].sort();
}

export function pairedLiveRuntimeSources(): string[] {
  return runtimeSources().map(source => relative(root, source).replaceAll('\\', '/'));
}

export function pairedLiveRuntimeFingerprint(): string {
  const digest = createHash('sha256');
  for (const source of runtimeSources()) {
    digest.update(relative(root, source).replaceAll('\\', '/')).update('\0')
      .update(readFileSync(source)).update('\0');
  }
  for (const lockfile of ['package.json', 'package-lock.json']) {
    const file = join(root, lockfile);
    if (existsSync(file)) digest.update(lockfile).update('\0').update(readFileSync(file)).update('\0');
  }
  return digest.digest('hex');
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function evalArtifactTool(workspace: string): ToolDef {
  return {
    name: 'write_paired_artifact',
    version: '1.0.0',
    description: 'Write one required paired-evaluation artifact.',
    discovery: { initial: true, keywords: ['artifact', 'file', 'write', '产物'] },
    permissions: ['workspace.write'],
    risk: 'low',
    approval: false,
    sideEffect: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', enum: [ARTIFACT_A, ARTIFACT_B] },
        content: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    async handler(args: { path?: string; content?: string }): Promise<ToolResult> {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (![ARTIFACT_A, ARTIFACT_B].includes(path)) return { ok: false, error: 'artifact path is not allowed' };
      if (!content.trim()) return { ok: false, error: 'artifact content is empty' };
      const target = join(workspace, path);
      if (existsSync(target) && readFileSync(target, 'utf8') !== content)
        return { ok: false, error: 'artifact already exists with different content' };
      writeFileSync(target, content);
      return {
        ok: true,
        data: { path, bytes: Buffer.byteLength(content) },
        evidence: [{ artifact: true, kind: 'file', label: path, ref: path }],
      };
    },
  };
}

function pairedTeamTool(
  organization: OrganizationService,
  store: Store,
  config: PairedLiveConfig,
): ToolDef {
  return {
    name: 'run_paired_team',
    version: '1.0.0',
    description: 'Create and execute the two required independent paired-evaluation assignments.',
    discovery: { initial: true, keywords: ['team', 'delegate', 'branch', '分工'] },
    permissions: ['workspace.write'],
    delegates: true,
    risk: 'low',
    costHint: 'high',
    sideEffect: 'write',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object' },
    async handler(_args, ctx): Promise<ToolResult> {
      if (!ctx.runId || !ctx.delegate) return { ok: false, error: 'paired team requires a live run' };
      const run = store.runs.get(ctx.runId, ctx.tenantId ?? 'default');
      if (!run) return { ok: false, error: 'paired parent run not found' };
      const branchBudget = round(config.teamBudgetUsd * 0.3);
      const team = organization.createTeam(run, {
        assignments: [
          {
            objective: `从材料提取 ALPHA 与 BETA，写入 ${ARTIFACT_A}`,
            expectedArtifacts: [ARTIFACT_A],
            acceptance: ['文件存在', '包含 ALPHA=17 与 BETA=29'],
            budgetUsd: branchBudget,
            allowedTools: ['write_paired_artifact'],
          },
          {
            objective: `从材料提取 GAMMA，写入 ${ARTIFACT_B}`,
            expectedArtifacts: [ARTIFACT_B],
            acceptance: ['文件存在', '包含 GAMMA=41'],
            budgetUsd: branchBudget,
            allowedTools: ['write_paired_artifact'],
          },
        ],
        singleAgentEstimateUsd: round(config.teamBudgetUsd * 0.6),
        teamEstimateUsd: round(config.teamBudgetUsd * 0.6),
        reason: 'paired evaluation of two independent required artifacts',
      });
      const results = [];
      for (const contract of team.contracts) {
        const branchContent = contract.expectedArtifacts.includes(ARTIFACT_A)
          ? `ALPHA=17\nBETA=29\n`
          : `GAMMA=41\n`;
        const result = await ctx.delegate({
          objective: contract.branchObjective,
          tools: 'all',
          assignmentContractId: contract.id,
          allowedTools: ['write_paired_artifact'],
          instructions: `Use write_paired_artifact exactly once. Write ${contract.expectedArtifacts.join(', ')} with this exact content:\n${branchContent}`,
          maxTurns: config.maxCalls,
        }, ctx.signal);
        results.push(result);
        if (result.error) break;
      }
      return {
        ok: results.every(result => !result.error),
        data: { teamCycleId: team.teamCycle.id, results },
        error: results.find(result => result.error)?.error,
      };
    },
  };
}

function waitForTerminal(service: RunService, runId: string, sessionId: string, timeoutMs: number): Promise<RunRecord> {
  const started = Date.now();
  return new Promise((resolveRun, reject) => {
    const poll = () => {
      try {
        const run = service.get(runId, 'default');
        for (const approval of globalApprovalBoard.listPending(sessionId)) globalApprovalBoard.approve(approval.id, true);
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return resolveRun(run);
        if (Date.now() - started >= timeoutMs) {
          service.cancel(runId, 'default');
          return reject(new Error('PAIRED_EVAL_TIMEOUT'));
        }
        setTimeout(poll, 25);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

function artifactChecks(workspace: string): { checks: Array<{ name: string; passed: boolean }>; artifacts: string[] } {
  const paths = [ARTIFACT_A, ARTIFACT_B];
  const content = Object.fromEntries(paths.map(path => {
    const file = join(workspace, path);
    return [path, existsSync(file) ? readFileSync(file, 'utf8') : ''];
  }));
  return {
    artifacts: paths.filter(path => existsSync(join(workspace, path))),
    checks: [
      { name: `${ARTIFACT_A} exists`, passed: Boolean(content[ARTIFACT_A]) },
      { name: `${ARTIFACT_A} contains ALPHA=17 and BETA=29`, passed: content[ARTIFACT_A].includes('ALPHA=17') && content[ARTIFACT_A].includes('BETA=29') },
      { name: `${ARTIFACT_B} exists`, passed: Boolean(content[ARTIFACT_B]) },
      { name: `${ARTIFACT_B} contains GAMMA=41`, passed: content[ARTIFACT_B].includes('GAMMA=41') },
    ],
  };
}

function artifactEvidence(workspace: string): {
  checks: Array<{ name: string; passed: boolean }>;
  artifacts: string[];
  artifactHashes: Record<string, string>;
} {
  const result = artifactChecks(workspace);
  return {
    ...result,
    artifactHashes: Object.fromEntries(result.artifacts.map(path => [path, hash(readFileSync(join(workspace, path)))])),
  };
}

function aggregateUsage(store: Store, runs: RunRecord[]): {
  modelCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  usageComplete: boolean;
} {
  const calls = runs.flatMap(run => store.runs.modelCalls(run.id, 0, 500));
  const cacheKnown = calls.length > 0 && calls.every(call => call.cachedInput !== undefined);
  const cacheMissKnown = calls.length > 0 && calls.every(call => call.missInput !== undefined);
  const cacheWriteKnown = calls.length > 0 && calls.every(call => call.cacheWriteTokens !== undefined);
  return {
    modelCalls: calls.length,
    costUsd: round(calls.reduce((sum, call) => sum + (call.cost ?? 0), 0)),
    inputTokens: calls.reduce((sum, call) => sum + (call.input ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.output ?? 0), 0),
    cachedInputTokens: cacheKnown ? calls.reduce((sum, call) => sum + (call.cachedInput ?? 0), 0) : null,
    cacheMissTokens: cacheMissKnown ? calls.reduce((sum, call) => sum + (call.missInput ?? 0), 0) : null,
    cacheWriteTokens: cacheWriteKnown ? calls.reduce((sum, call) => sum + (call.cacheWriteTokens ?? 0), 0) : null,
    usageComplete: calls.length > 0 && calls.every(call => call.usageStatus === 'reported'),
  };
}

async function executeArm(
  config: PairedLiveConfig,
  sourceProvider: ProviderDef,
  arm: 'solo' | 'team',
): Promise<PairedArmReport> {
  const started = Date.now();
  const armDir = join(config.reportDir, arm);
  const workspace = join(armDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'material.txt'), config.material, { flag: 'wx' });

  const budget = new EvaluationBudget(arm === 'solo' ? config.soloBudgetUsd : config.teamBudgetUsd);
  const provider = budgetedEvaluationProvider({ ...sourceProvider, outputLimitGuaranteed: true }, {
    model: config.model,
    inputUsdPerMillion: config.inputUsdPerMillion,
    outputUsdPerMillion: config.outputUsdPerMillion,
    maxOutputTokens: config.maxOutputTokens,
    scope: arm,
  }, budget);
  const kernel = new Kernel(root, { sandboxRoot: workspace }, {
    dataDir: join(armDir, 'runtime'),
    userPluginsDir: join(armDir, 'plugins'),
  });
  const store = new Store(join(armDir, 'runs.sqlite'));
  store.runs.setPermission('default', workspace, 'developer');
  const organization = new OrganizationService({ store });
  const artifact = evalArtifactTool(workspace);
  const teamTool = pairedTeamTool(organization, store, config);
  const tools = arm === 'team' ? [teamTool, artifact] : [artifact];
  store.upsertProvider({
    id: config.providerId,
    label: 'paired live evaluation',
    baseUrl: 'runtime-provider',
    apiKey: '',
    model: config.model,
    protocol: sourceProvider.protocol ?? 'openai',
    priceIn: config.inputUsdPerMillion,
    priceOut: config.outputUsdPerMillion,
    enabled: 1,
  });
  const prepare = (record: RunRecord): RunOptions => ({
    provider,
    model: config.model,
    messages: [],
    tools: arm === 'team' && record.parentId ? [artifact] : tools,
    traceId: record.id,
    maxTurns: config.maxCalls,
    contextWindow: 32_000,
    systemPrompt: [
      'You are executing a deterministic paired evaluation.',
      'Use tools for every claimed artifact and never claim completion without successful tool evidence.',
      record.instructions ?? '',
    ].filter(Boolean).join('\n'),
  });
  const service = new RunService({
    store,
    organization,
    tools: () => tools,
    workspace: () => workspace,
    projectRoot: root,
    provider: () => ({ id: config.providerId, model: config.model }),
    prepare,
    historyArchive: false,
    runner: () => {
      const runner = new AgentRunner(kernel, kernel.bus);
      return {
        approveApproval: runner.approveApproval.bind(runner),
        async *run(options) { yield* runner.run(options); },
      };
    },
  });
  let rootRun: RunRecord | undefined;
  try {
    const session = store.createSession(config.model, config.providerId);
    const artifactContract = `验收要求：${ARTIFACT_A} 必须逐字包含 "ALPHA=17" 和 "BETA=29"；${ARTIFACT_B} 必须逐字包含 "GAMMA=41"。不要改写键名或使用中文说明替代这些字符串。`;
    const prompt = arm === 'team'
      ? `${config.objective}\n${artifactContract}\n调用 run_paired_team 一次，创建并执行两个独立分工。子任务完成后直接报告结果，不要再次写入文件。材料：\n${config.material}`
      : `${config.objective}\n${artifactContract}\n分别调用 write_paired_artifact 写入 ${ARTIFACT_A} 和 ${ARTIFACT_B}。每个文件只写一次；两次写入均成功后直接报告，不要重试或再次写入。材料：\n${config.material}`;
    rootRun = service.create(session, {
      message: prompt,
      budgetUsd: arm === 'solo' ? config.soloBudgetUsd : config.teamBudgetUsd,
      budgetPolicy: 'enforce',
      principalRole: 'admin',
      authorization: { workspace, readOnly: false, profile: 'developer' },
      toolNames: arm === 'team' ? [teamTool.name, artifact.name] : [artifact.name],
      deadlineAt: Date.now() + config.timeoutMs,
    });
    const final = await waitForTerminal(service, rootRun.id, session.id, config.timeoutMs);
    const children = store.runs.children(rootRun.id, 'default');
    const detail = organization.detail(organization.workOrderForRun(final).id, 'default');
    const team = detail.teamCycles.at(-1);
    const contracts = team ? detail.contracts.filter(contract => contract.teamCycleId === team.id) : [];
    const files = artifactEvidence(workspace);
    const allRuns = [final, ...children];
    const usage = aggregateUsage(store, allRuns);
    const checks = [
      ...files.checks,
      { name: 'root run completed', passed: final.status === 'completed' },
      { name: arm === 'team' ? 'team has exactly two child runs' : 'solo has no child runs', passed: children.length === (arm === 'team' ? 2 : 0) },
      { name: arm === 'team' ? 'team has two delivered contracts' : 'solo has no team', passed: arm === 'team' ? contracts.length === 2 && contracts.every(contract => contract.status === 'delivered') : detail.teamCycles.length === 0 },
    ];
    const armBudget = arm === 'solo' ? config.soloBudgetUsd : config.teamBudgetUsd;
    return {
      arm,
      runId: final.id,
      status: final.status === 'completed' ? 'completed' : 'failed',
      answer: final.answer ?? '',
      error: final.error,
      elapsedMs: Date.now() - started,
      modelCalls: usage.modelCalls,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheMissTokens: usage.cacheMissTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      usageComplete: usage.usageComplete,
      budgetCompliant: usage.costUsd <= armBudget + 1e-9 && allRuns.every(run => run.budgetUsd === undefined || run.cost <= run.budgetUsd + 1e-9),
      checks,
      artifacts: files.artifacts,
      artifactHashes: files.artifactHashes,
      childRunIds: children.map(run => run.id),
      teamCycleId: team?.id,
      contractIds: contracts.map(contract => contract.id),
    };
  } catch (error) {
    const latestRoot = rootRun ? store.runs.get(rootRun.id, 'default') : undefined;
    const children = latestRoot ? store.runs.children(latestRoot.id, 'default') : [];
    const usage = aggregateUsage(store, latestRoot ? [latestRoot, ...children] : []);
    const files = artifactEvidence(workspace);
    const armBudget = arm === 'solo' ? config.soloBudgetUsd : config.teamBudgetUsd;
    return {
      arm,
      runId: latestRoot?.id,
      status: 'failed',
      answer: latestRoot?.answer ?? '',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
      modelCalls: usage.modelCalls,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheMissTokens: usage.cacheMissTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      usageComplete: usage.usageComplete,
      budgetCompliant: usage.costUsd <= armBudget + 1e-9
        && [latestRoot, ...children].every(run => !run || run.budgetUsd === undefined || run.cost <= run.budgetUsd + 1e-9),
      checks: [],
      artifacts: files.artifacts,
      artifactHashes: files.artifactHashes,
      childRunIds: children.map(run => run.id),
      contractIds: [],
    };
  } finally {
    await service.shutdown();
    store.close();
    await kernel.stop();
  }
}

function emptyReport(
  config: PairedLiveConfig,
  status: PairedLiveReport['status'],
  reason: string,
  evidenceMode: PairedEvidenceMode,
): PairedLiveReport {
  return {
    kind: 'organization-paired-live',
    createdAt: new Date().toISOString(),
    status,
    evidenceMode,
    runnerFingerprint: pairedLiveRuntimeFingerprint(),
    providerId: config.providerId,
    model: config.model,
    objectiveHash: hash(config.objective),
    materialHash: hash(config.material),
    pricing: {
      inputUsdPerMillion: config.inputUsdPerMillion,
      outputUsdPerMillion: config.outputUsdPerMillion,
    },
    arms: {},
    comparison: null,
    reason,
    limitations: [
      'This report is an execution record, not evidence from a replay or fixture.',
      'A passed execution gate does not mean the team is cost-effective; inspect netBenefitUsd.marginal.',
      'Provider cache savings remain null unless the provider reports cost-adjusted cache pricing.',
    ],
  };
}

export async function runPairedLive(
  config: PairedLiveConfig,
  sourceProvider: ProviderDef,
  evidenceMode: PairedEvidenceMode = 'test-double',
): Promise<PairedLiveReport> {
  validatePairedLiveConfig(config);
  if (existsSync(config.reportDir)) throw new Error('reportDir must not already exist');
  mkdirSync(config.reportDir, { recursive: true });
  const solo = await executeArm(config, sourceProvider, 'solo');
  const team = await executeArm(config, sourceProvider, 'team');
  const executionChecks = [solo, team].every(arm =>
    arm.status === 'completed'
    && arm.modelCalls > 0
    && arm.budgetCompliant
    && arm.checks.every(check => check.passed));
  const usageComplete = solo.usageComplete && team.usageComplete;
  const quality = (arm: PairedArmReport) => arm.checks.length
    ? arm.checks.filter(check => check.passed).length / arm.checks.length
    : 0;
  const soloQuality = quality(solo);
  const teamQuality = quality(team);
  const risk = (arm: PairedArmReport) => arm.status === 'completed' && arm.budgetCompliant ? 0 : 1;
  const soloRisk = risk(solo);
  const teamRisk = risk(team);
  const net = (arm: PairedArmReport, armQuality: number) =>
    round(config.valueUsd * armQuality * armQuality - arm.costUsd);
  const soloNet = net(solo, soloQuality);
  const teamNet = net(team, teamQuality);
  const report: PairedLiveReport = {
    ...emptyReport(config, 'inconclusive', 'paired execution finished without complete usage', evidenceMode),
    arms: { solo, team },
    comparison: {
      quality: { solo: soloQuality, team: teamQuality, marginal: teamQuality - soloQuality },
      costUsd: { solo: solo.costUsd, team: team.costUsd, marginal: round(team.costUsd - solo.costUsd) },
      tokens: {
        solo: solo.inputTokens + solo.outputTokens,
        team: team.inputTokens + team.outputTokens,
        marginal: (team.inputTokens + team.outputTokens) - (solo.inputTokens + solo.outputTokens),
      },
      elapsedMs: {
        solo: solo.elapsedMs,
        team: team.elapsedMs,
        marginal: team.elapsedMs - solo.elapsedMs,
      },
      coordination: {
        costUsd: round(team.costUsd - solo.costUsd),
        tokens: (team.inputTokens + team.outputTokens) - (solo.inputTokens + solo.outputTokens),
        elapsedMs: team.elapsedMs - solo.elapsedMs,
      },
      risk: {
        solo: soloRisk,
        team: teamRisk,
        marginal: round(teamRisk - soloRisk),
      },
      netBenefitUsd: { solo: soloNet, team: teamNet, marginal: round(teamNet - soloNet) },
      teamPreferred: teamNet > soloNet,
    },
  };
  if (!executionChecks) {
    report.status = 'failed';
    report.reason = 'one or both arms failed machine acceptance or hard-budget checks';
  } else if (!usageComplete) {
    report.status = 'inconclusive';
    report.reason = 'both arms completed, but one or more provider usages were estimated or unknown';
  } else {
    report.status = 'passed';
    report.reason = 'both arms completed with independent artifact, Run, usage and budget evidence';
  }
  writeFileSync(join(config.reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

export function unexecutedPairedReport(
  config: PairedLiveConfig,
  reason: string,
  evidenceMode: PairedEvidenceMode = 'test-double',
): PairedLiveReport {
  validatePairedLiveConfig(config);
  if (existsSync(config.reportDir)) throw new Error('reportDir must not already exist');
  mkdirSync(config.reportDir, { recursive: true });
  const report = emptyReport(config, 'unexecuted', reason, evidenceMode);
  writeFileSync(join(config.reportDir, 'manifest.json'), JSON.stringify({
    kind: 'organization-paired-live-manifest',
    createdAt: report.createdAt,
    providerId: config.providerId,
    model: config.model,
    objectiveHash: report.objectiveHash,
    materialHash: report.materialHash,
    budgets: { soloUsd: config.soloBudgetUsd, teamUsd: config.teamBudgetUsd },
    execute: false,
  }, null, 2), 'utf8');
  writeFileSync(join(config.reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

function cliConfig(): PairedLiveConfig {
  return {
    reportDir: resolve(root, process.env.EVAL_REPORT_DIR ?? `evals/reports/organization-paired-live/${new Date().toISOString().replace(/[:.]/g, '-')}`),
    providerId: String(process.env.EVAL_PROVIDER_ID ?? ''),
    model: String(process.env.EVAL_MODEL ?? ''),
    objective: String(process.env.EVAL_OBJECTIVE ?? DEFAULT_OBJECTIVE),
    material: String(process.env.EVAL_MATERIAL ?? DEFAULT_MATERIAL),
    valueUsd: Number(process.env.EVAL_VALUE_USD ?? 1),
    soloBudgetUsd: Number(process.env.EVAL_SOLO_BUDGET_USD ?? 0.2),
    teamBudgetUsd: Number(process.env.EVAL_TEAM_BUDGET_USD ?? 0.4),
    inputUsdPerMillion: Number(process.env.EVAL_PRICE_IN ?? NaN),
    outputUsdPerMillion: Number(process.env.EVAL_PRICE_OUT ?? NaN),
    maxCalls: Number(process.env.EVAL_MAX_CALLS ?? 8),
    maxOutputTokens: Number(process.env.EVAL_MAX_OUTPUT_TOKENS ?? 512),
    timeoutMs: Number(process.env.EVAL_TIMEOUT_MS ?? 180_000),
  };
}

async function main(): Promise<void> {
  const config = cliConfig();
  validatePairedLiveConfig(config);
  if (process.env.EVAL_LIVE_CONFIRM !== '1') {
    const report = unexecutedPairedReport(config, 'EVAL_LIVE_CONFIRM=1 is required before any paid model call', 'configured-provider');
    console.log(JSON.stringify({ status: report.status, report: join(config.reportDir, 'report.json') }));
    return;
  }
  const dataDir = process.env.AGENT_DATA_DIR ?? join(root, 'data');
  const source = new Database(join(dataDir, 'agent.db'), { readonly: true });
  const configured = source.prepare(`SELECT id,label,model,base_url AS baseUrl,api_key AS apiKey,protocol FROM providers WHERE id=? AND enabled=1`)
    .get(config.providerId) as { id: string; label: string; model: string; baseUrl: string; apiKey: string; protocol: string } | undefined;
  source.close();
  if (!configured) throw new Error('configured enabled provider not found');
  const master = Buffer.from(readFileSync(join(dataDir, 'secret.key'), 'utf8').trim(), 'hex');
  const apiKey = configured.apiKey
    ? isPurposeEncrypted(configured.apiKey)
      ? decryptPurposeSecret(configured.apiKey, master, `provider:${configured.id}`)
      : decryptSecret(configured.apiKey, master)
    : '';
  if (!apiKey) throw new Error('configured provider credential unavailable');
  const provider = createProvider({
    id: configured.id,
    baseUrl: configured.baseUrl,
    apiKey,
    model: config.model,
    protocol: configured.protocol,
    inputPrice: config.inputUsdPerMillion,
    outputPrice: config.outputUsdPerMillion,
    requestTimeoutMs: config.timeoutMs,
  });
  const report = await runPairedLive(config, provider, 'configured-provider');
  console.log(JSON.stringify({
    status: report.status,
    report: join(config.reportDir, 'report.json'),
    teamPreferred: report.comparison?.teamPreferred,
    marginalNetBenefitUsd: report.comparison?.netBenefitUsd.marginal,
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
