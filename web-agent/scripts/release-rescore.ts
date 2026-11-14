import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseTasks } from '../evals/release-cases';
import type { ReleaseSample } from '../evals/release-report';

const folder = resolve(process.argv[2] ?? 'evals/reports/release-v2');
if (existsSync(join(folder, 'scoring-audit.json'))) throw new Error('Scoring audit already exists; preserve the existing revision');
const raw = readFileSync(join(folder, 'samples.jsonl'));
const rows = raw.toString('utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line) as ReleaseSample & { workspace: string });
const tasks = new Map(releaseTasks().map(task => [task.id, task]));
const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const artifacts: unknown[] = [];
const changes: unknown[] = [];
const tempRoot = realpathSync(tmpdir());
const outputNames = ['solution.mjs', 'result.json', 'release.md', 'summary.json', 'checklist.md', 'comparison.md', 'guide.md', 'project.json', 'ledger.jsonl', 'receipt.json', 'target.txt'];
for (const row of rows) {
  const task = tasks.get(row.caseId);
  if (!task) throw new Error('Unknown task: ' + row.caseId);
  const workspace = realpathSync(row.workspace);
  const location = relative(tempRoot, workspace);
  if (isAbsolute(location) || !/^maharness-release-[^\\/]+$/.test(location)) throw new Error('Unexpected evaluation workspace');
  const key = [row.tier, row.caseId, row.variant, row.repetition];
  const files: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(task.files), ...outputNames])) {
    const file = join(workspace, name);
    if (!existsSync(file)) continue;
    const target = relative(workspace, realpathSync(file));
    if (isAbsolute(target) || target.startsWith('..') || !lstatSync(file).isFile()) throw new Error('Artifact escaped evaluation workspace');
    const bytes = readFileSync(file);
    files[name] = { sha256: hash(bytes), bytes: bytes.length, ...(bytes.length <= 1_000_000 ? { content: bytes.toString('utf8') } : {}) };
  }
  artifacts.push({ key, files });
  let checks: ReleaseSample['assertions'];
  try { checks = task.check(workspace); }
  catch (error) { checks = [{ name: 'artifact grading', passed: false }]; files.gradingError = error instanceof Error ? error.message : String(error); }
  const checkedNames = new Set(checks.map(check => check.name));
  const next = [...row.assertions.filter(check => !checkedNames.has(check.name)), ...checks];
  const normalized = (list: typeof next) => list.map(check => `${check.name}:${check.passed}`).sort().join('|');
  if (normalized(next) !== normalized(row.assertions)) changes.push({ key, before: row.assertions, after: next });
  row.assertions = next;
}
const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join(String.fromCharCode(10)) + String.fromCharCode(10);
const scored = lines(rows);
writeFileSync(join(folder, 'scored-samples.jsonl'), scored);
writeFileSync(join(folder, 'artifact-evidence.jsonl'), lines(artifacts));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(folder, 'scoring-audit.json'), JSON.stringify({
  kind: 'artifact-rescore', reason: 'JSON object key order does not change its value; array ordering, value types and duplicate effects remain significant',
  samples: rows.length, originalSamplesSha256: hash(raw), scoredSamplesSha256: hash(scored),
  graderSha256: hash(readFileSync(join(root, 'evals/release-cases.ts'))),
  modelRequestsReplayed: 0, toolCallsReplayed: 0, codeAssertionsReexecuted: rows.filter(row => tasks.get(row.caseId)?.category === 'code').length,
  changedSamples: changes,
}, null, 2));
const manifestPath = join(folder, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.sampleFile = 'scored-samples.jsonl';
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ samples: rows.length, rescored: changes.length, originalSamplesSha256: hash(raw) }));
