import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../server/db';
import { OrganizationService } from '../server/services/organization/service';

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(root, process.env.EVAL_REPORT_DIR ?? 'evals/reports/organization-live/20261117-social-os-v4');
const sourcePath = join(reportDir, 'report.json');
if (!existsSync(sourcePath)) throw new Error(`Missing live report: ${sourcePath}`);
const replayDir = resolve(
  root,
  process.env.EVAL_REPLAY_DIR ?? `evals/replays/organization-live/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const outputPath = join(replayDir, 'reconciled.json');
if (existsSync(outputPath)) throw new Error(`Replay output already exists: ${outputPath}`);

type LiveSample = {
  id: number;
  name: string;
  passed: boolean;
  status: string;
  runId?: string;
  checks: Array<{ name: string; passed: boolean }>;
};

type LiveReport = {
  requestedModel: string;
  samples: LiveSample[];
};

const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as LiveReport;
const sourceReportHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function copyDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  if (existsSync(destinationPath)) throw new Error(`Replay database already exists: ${destinationPath}`);
  mkdirSync(resolve(destinationPath, '..'), { recursive: true });
  const database = new Database(sourcePath, { readonly: true });
  try {
    await database.backup(destinationPath);
  } finally {
    database.close();
  }
}

function readCacheUsage(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    const rows = database
      .prepare('SELECT record FROM run_model_calls_v2 ORDER BY rowid')
      .all()
      .map(
        (row) =>
          JSON.parse((row as { record: string }).record) as {
            usageStatus?: string;
            cachedInput?: number;
            missInput?: number;
            cacheWriteTokens?: number;
          },
      );
    const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    const hitMissKnown =
      rows.length > 0 && rows.every((row) => row.usageStatus === 'reported' && valid(row.cachedInput) && valid(row.missInput));
    const writeKnown = rows.length > 0 && rows.every((row) => row.usageStatus === 'reported' && valid(row.cacheWriteTokens));
    return {
      calls: rows.length,
      hitMissStatus: hitMissKnown ? ('known' as const) : ('unknown' as const),
      writeStatus: writeKnown ? ('known' as const) : ('unknown' as const),
      cachedInputTokens: hitMissKnown ? rows.reduce((sum, row) => sum + row.cachedInput!, 0) : null,
      missInputTokens: hitMissKnown ? rows.reduce((sum, row) => sum + row.missInput!, 0) : null,
      cacheWriteTokens: writeKnown ? rows.reduce((sum, row) => sum + row.cacheWriteTokens!, 0) : null,
      cacheSavingsUsd: null,
    };
  } finally {
    database.close();
  }
}

const replay: Array<Record<string, unknown>> = [];
const sourceDatabases: Array<{ caseId: number; source: string; sourceHash: string; replay: string }> = [];
for (const sample of source.samples) {
  if (!sample.runId) {
    replay.push({ id: sample.id, name: sample.name, pass: false, error: 'missing_run_id', cacheUsage: null });
    continue;
  }
  const sourceDatabase = join(reportDir, `case-${sample.id}`, 'runs.sqlite');
  if (!existsSync(sourceDatabase)) {
    replay.push({ id: sample.id, name: sample.name, pass: false, error: 'database_missing', cacheUsage: null });
    continue;
  }
  const replayDatabase = join(replayDir, `case-${sample.id}`, 'runs.sqlite');
  await copyDatabase(sourceDatabase, replayDatabase);
  sourceDatabases.push({
    caseId: sample.id,
    source: sourceDatabase,
    sourceHash: fileHash(sourceDatabase),
    replay: replayDatabase,
  });
  const cacheUsage = readCacheUsage(replayDatabase);
  const store = new Store(replayDatabase);
  try {
    const run = store.runs.get(sample.runId, 'default');
    if (!run) {
      replay.push({ id: sample.id, name: sample.name, pass: false, error: 'run_missing', cacheUsage });
      continue;
    }
    const organization = new OrganizationService({ store });
    const receipt = organization.finalizeRun(run);
    const order = organization.workOrderForRun(run);
    const detail = organization.detail(order.id, 'default');
    const team = detail.teamCycles.at(-1);
    const contracts = detail.contracts.filter((contract) => contract.teamCycleId === team?.id);
    const checks: Array<{ name: string; passed: boolean }> = [
      { name: 'work receipt exists', passed: Boolean(receipt) },
      { name: 'terminal receipt matches work order', passed: receipt?.workOrderId === order.id },
    ];
    if (sample.id !== 1) {
      checks.push(
        { name: 'team cycle exists', passed: Boolean(team) },
        { name: 'two team contracts exist', passed: contracts.length === 2 },
      );
    }
    if (sample.id === 5) {
      checks.push(
        { name: 'failed branches collapse to solo', passed: run.fallbackReason === 'ROLLBACK_TO_SOLO' && team?.status === 'partial' },
        { name: 'collapsed run keeps fallback reason', passed: run.fallbackReason === 'ROLLBACK_TO_SOLO' },
        { name: 'collapsed team remains partial', passed: team?.status === 'partial' },
      );
    }
    const preserved = sample.checks.filter(
      (check) => check.name !== 'work receipt exists' && check.name !== 'failed branches collapse to solo',
    );
    const effective = [...preserved, ...checks];
    replay.push({
      id: sample.id,
      name: sample.name,
      pass: effective.every((check) => check.passed),
      rawPassed: sample.passed,
      checks: effective,
      receiptStatus: receipt?.status ?? null,
      fallbackReason: run.fallbackReason ?? null,
      teamStatus: team?.status ?? null,
      workOrderId: order.id,
      cacheUsage,
    });
  } finally {
    store.close();
  }
}

const hitMissKnown =
  replay.length > 0 &&
  replay.every((item) => (item.cacheUsage as { hitMissStatus?: string } | null | undefined)?.hitMissStatus === 'known');
const cacheWriteKnown =
  replay.length > 0 && replay.every((item) => (item.cacheUsage as { writeStatus?: string } | null | undefined)?.writeStatus === 'known');
const cacheUsages = replay.map(
  (item) => item.cacheUsage as { cachedInputTokens: number; missInputTokens: number; cacheWriteTokens: number } | null,
);

const output = {
  kind: 'organization-live-trace-replay',
  createdAt: new Date().toISOString(),
  requestedModel: source.requestedModel,
  source: sourcePath,
  sourceReportHash,
  sourceDatabases,
  semantics:
    'Replays persisted model outputs and tool calls through the corrected deterministic finalizer. It does not claim a second model run.',
  isolation: 'Each source database is backed up before replay; only the replay copy is finalized.',
  providerCacheUsage: {
    hitMissStatus: hitMissKnown ? 'known' : 'unknown',
    writeStatus: cacheWriteKnown ? 'known' : 'unknown',
    cachedInputTokens: hitMissKnown ? cacheUsages.reduce((sum, item) => sum + (item?.cachedInputTokens ?? 0), 0) : null,
    missInputTokens: hitMissKnown ? cacheUsages.reduce((sum, item) => sum + (item?.missInputTokens ?? 0), 0) : null,
    cacheWriteTokens: cacheWriteKnown ? cacheUsages.reduce((sum, item) => sum + (item?.cacheWriteTokens ?? 0), 0) : null,
    cacheSavingsUsd: null,
    source: 'run_model_calls_v2.record',
  },
  rawPassed: replay.filter((item) => item.rawPassed).length,
  reconciledPassed: replay.filter((item) => item.pass).length,
  total: replay.length,
  samples: replay,
};

mkdirSync(replayDir, { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(
  JSON.stringify(
    {
      output: outputPath,
      rawPassed: output.rawPassed,
      reconciledPassed: output.reconciledPassed,
      total: output.total,
    },
    null,
    2,
  ),
);
