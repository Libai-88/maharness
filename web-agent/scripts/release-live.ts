import { createResultTool } from '../core/chat/result-tool';
import { TokenBudget } from '../evals/strengthening';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kernel } from '../kernel';
import { AgentRunner } from '../core/chat/agent';
import { createProvider } from '../core/chat/provider';
import { Store } from '../server/db';
import { RunService } from '../server/run-service';
import { resolveInSandbox } from '../kernel/sandbox';
import { ReferenceLoop } from '../evals/reference-loop';
import { releaseTasks } from '../evals/release-cases';
import { buildReleaseReport, type ReleaseSample, type ReleaseManifest, type ReleaseVariant } from '../evals/release-report';
import type { AgentLoop, RunOptions } from '../kernel/loop';
import type { KernelLike, ToolDef, LLMMessage } from '../kernel/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiKey = process.env.EVAL_API_KEY;
const baseUrl = process.env.EVAL_BASE_URL;
const modelNames = process.env.EVAL_MODELS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const baselineRoot = process.env.EVAL_BASELINE_ROOT;
if (!apiKey || !baseUrl || !modelNames?.length || !baselineRoot)
  throw new Error('Explicit EVAL_API_KEY, EVAL_BASE_URL, EVAL_MODELS and EVAL_BASELINE_ROOT are required');
if (process.env.EVAL_FREE_CONFIRMED !== 'true') throw new Error('This runner requires explicitly confirmed zero-price test models');
const output = resolve(process.env.EVAL_REPORT_DIR ?? 'evals/reports/release-v2');
mkdirSync(output, { recursive: true });
const samplesPath = join(output, 'samples.jsonl');
const continuing = process.env.EVAL_CONTINUE_UNSTARTED === 'true';
if (existsSync(samplesPath) && !continuing) throw new Error('Report directory already contains samples; use a new directory');
const previous = existsSync(samplesPath)
  ? readFileSync(samplesPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const tokenBudget = new TokenBudget(Number(process.env.EVAL_TOKEN_LIMIT ?? 20_000_000));
const budgetPath = join(output, 'budget.jsonl');
if (continuing && existsSync(budgetPath)) {
  const entries = readFileSync(budgetPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const calls = new Map<string, number>();
  for (const row of entries) calls.set(row.id, row.accounted);
  tokenBudget.spent = [...calls.values()].reduce((sum, value) => sum + value, 0);
}
function sourceHashes() {
  const hashes: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !['reports', 'node_modules'].includes(entry.name) && !/@[0-9a-f]{10}$/.test(entry.name)) visit(path);
      else if (entry.isFile() && /\.(tsx?|mjs)$/.test(entry.name))
        hashes[path] = createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
    }
  }
  for (const directory of ['core', 'kernel', 'server', 'scripts', 'evals', 'ui/src']) visit(directory);
  return hashes;
}
const evaluatedSources = sourceHashes();
const sourcePath = join(output, 'evaluated-sources.json');
if (continuing && JSON.stringify(JSON.parse(readFileSync(sourcePath, 'utf8'))) !== JSON.stringify(evaluatedSources))
  throw new Error('Evaluation source revision changed; cannot combine batches');
if (!continuing) writeFileSync(sourcePath, JSON.stringify(evaluatedSources, null, 2));
const oldKernelModule = await import(pathToFileURL(join(baselineRoot, 'kernel/index.ts')).href);
const oldRunnerModule = await import(pathToFileURL(join(baselineRoot, 'core/chat/agent.ts')).href);
const variants = (process.env.EVAL_VARIANTS?.split(',') ?? ['baseline', 'reference', 'v2']) as ReleaseVariant[];
if (
  !variants.length ||
  new Set(variants).size !== variants.length ||
  variants.some((variant) => !['baseline', 'reference', 'v2'].includes(variant))
)
  throw new Error('EVAL_VARIANTS must contain distinct baseline, reference or v2 values');
const tasks = releaseTasks();
const catalogSha256 = createHash('sha256')
  .update(readFileSync(join(root, 'kernel/tool-discovery.ts')))
  .digest('hex');
writeFileSync(join(output, 'runtime-fingerprints.json'), JSON.stringify({ catalogSha256, variants }, null, 2));
const manifest: ReleaseManifest = {
  cases: tasks.map(({ id, category }) => ({ id, category })),
  models: modelNames.map((model, i) => ({ tier: 'route-' + (i + 1), requestedModel: model, identity: 'route' })),
};
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      ...manifest,
      repetitions: 3,
      baselineRoot,
      baselineAgentSha256: createHash('sha256')
        .update(readFileSync(join(baselineRoot, 'core/chat/agent.ts')))
        .digest('hex'),
      v2AgentSha256: createHash('sha256')
        .update(readFileSync(join(root, 'core/chat/agent.ts')))
        .digest('hex'),
      referenceLoopSha256: createHash('sha256')
        .update(readFileSync(join(root, 'evals/reference-loop.ts')))
        .digest('hex'),
      taskSetSha256: createHash('sha256')
        .update(readFileSync(join(root, 'evals/release-cases.ts')))
        .digest('hex'),
      tokenLimit: tokenBudget.limit,
      sourceRevision: createHash('sha256').update(JSON.stringify(evaluatedSources)).digest('hex'),
      shuffleSeed: 20261114,
      maxCallsPerSample: 32,
      maxTurns: 30,
      maxOutputTokens: 2048,
      budgetUsd: 0,
      contextWindow: 60000,
      pricing: 'explicitly confirmed free; percentage cost overhead is unmeasurable',
    },
    null,
    2,
  ),
);

interface Call {
  id: string;
  models: string[];
  input?: number;
  output?: number;
  status?: number;
  error?: string;
}
interface Capture {
  calls: Call[];
  pending: Promise<void>[];
}
const captures = new AsyncLocalStorage<Capture>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const capture = captures.getStore();
  if (!capture) return originalFetch(url, init);
  if (capture.calls.length >= 32) throw new Error('EVAL_CALL_LIMIT');
  const id = randomUUID();
  const reservedTokens = typeof init?.body === 'string' ? Math.min(60000, Buffer.byteLength(init.body, 'utf8') + 2048) + 2048 : 62048;
  const settle = tokenBudget.reserve(reservedTokens);
  appendFileSync(budgetPath, JSON.stringify({ id, state: 'reserved', accounted: reservedTokens }) + '\n');
  let settled = false;
  const finish = (actual?: number) => {
    if (settled) return;
    settled = true;
    settle(actual);
    appendFileSync(
      budgetPath,
      JSON.stringify({ id, state: actual === undefined ? 'conservative' : 'reported', accounted: actual ?? reservedTokens }) + '\n',
    );
  };
  const receipt: Call = { id, models: [] };
  capture.calls.push(receipt);
  try {
    const response = await originalFetch(url, init);
    receipt.status = response.status;
    capture.pending.push(
      response
        .clone()
        .text()
        .then((text) => {
          for (const line of text.split(String.fromCharCode(10))) {
            const value = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
            if (!value || value === '[DONE]') continue;
            try {
              const data = JSON.parse(value);
              if (typeof data.model === 'string' && !receipt.models.includes(data.model)) receipt.models.push(data.model);
              if (data.usage && Number.isSafeInteger(data.usage.prompt_tokens))
                receipt.input = Math.max(receipt.input ?? 0, data.usage.prompt_tokens);
              if (data.usage && Number.isSafeInteger(data.usage.completion_tokens))
                receipt.output = Math.max(receipt.output ?? 0, data.usage.completion_tokens);
            } catch {
              /* Ignore non-JSON SSE control lines. */
            }
          }
          finish(receipt.input !== undefined && receipt.output !== undefined ? receipt.input + receipt.output : undefined);
        })
        .catch((error) => {
          receipt.error = error instanceof Error ? error.name : 'STREAM_FAILED';
          finish();
        }),
    );
    return response;
  } catch (error) {
    receipt.error = error instanceof Error ? error.name : 'REQUEST_FAILED';
    finish();
    throw error;
  }
};

async function execute(tier: string, model: string, variant: ReleaseVariant, task: (typeof tasks)[number], repetition: number) {
  const sandbox = mkdtempSync(join(tmpdir(), 'maharness-release-'));
  for (const [path, content] of Object.entries(task.files)) {
    const file = join(sandbox, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const defaults = {
    sandboxRoot: sandbox,
    'agent.maxTurns': 30,
    'agent.toolTimeoutMs': 15000,
    'cache.l1Enabled': false,
    'agent.thinkInEnglish': false,
    'context.maxTokens': 60000,
  };
  const kernel = new Kernel(sandbox, defaults);
  const oldKernel = variant === 'baseline' ? new oldKernelModule.Kernel(sandbox, defaults) : undefined;
  const sample: ReleaseSample = {
    caseId: task.id,
    tier,
    variant,
    repetition,
    completed: false,
    assertions: [],
    observedModels: [],
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costSource: 'free',
    unnecessaryConfirmations: 0,
    duplicateEffects: 0,
    permissionViolations: 0,
    eventGaps: 0,
  };
  const capture = captures.getStore()!;
  const toolRecords: { name: string; ok: boolean; outcome?: string }[] = [];
  let faultObserved = false;
  let restored = false;
  let interrupted = false;
  let answer = '';
  let store: Store | undefined;
  let service: RunService | undefined;
  let runner: AgentLoop;
  const abort = AbortSignal.timeout(300000);
  const startedAt = new Date().toISOString();
  try {
    await kernel.plugins.register(join(root, 'core/tools-fs'));
    await kernel.plugins.enable('tools-fs');
    const filesystem = kernel.plugins
      .tools()
      .filter((tool) => ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep'].includes(tool.name));
    const tools: ToolDef[] = filesystem.map((tool) => ({
      ...tool,
      async handler(args, ctx) {
        const input = args as { path?: string };
        const reading = tool.name === 'read_file' && input.path === 'source.json';
        if (
          !faultObserved &&
          ((reading && task.fault !== 'version-conflict') ||
            (task.fault === 'version-conflict' && ['edit_file', 'write_file'].includes(tool.name) && input.path === 'target.txt'))
        ) {
          faultObserved = !!task.fault;
          if (task.fault === 'transient-read')
            return {
              ok: false,
              error: 'Temporary read failure; file is available on another read',
              failure: { code: 'TEMPORARY_READ', outcome: 'not_started', retryable: true },
            };
          if (task.fault === 'missing-path')
            return {
              ok: false,
              error: 'File lookup unavailable; inspect directory and retry source.json',
              failure: { code: 'FILE_NOT_FOUND', outcome: 'not_started', retryable: false },
            };
          if (task.fault === 'schema-read') return { ok: true, data: { invalid: true } };
          if (task.fault === 'truncated-read')
            return {
              ok: true,
              truncated: true,
              data: {
                text: '{"value":',
                path: 'source.json',
                size: 12,
                totalLines: 1,
                startLine: 1,
                endLine: 1,
                truncated: true,
                nextOffset: 1,
              },
            };
          if (task.fault === 'version-conflict')
            return {
              ok: false,
              error: 'File changed; read target.txt then retry with current content',
              failure: { code: 'FILE_VERSION_CONFLICT', outcome: 'not_started', retryable: false },
            };
        }
        const result = await tool.handler(args, ctx);
        toolRecords.push({ name: tool.name, ok: result.ok, outcome: result.failure?.outcome });
        return result;
      },
    }));
    tools.push({
      name: 'append_record',
      version: '2.0.0',
      description: 'Append one order to ledger.jsonl. Not idempotent: inspect ledger before repeating.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, amount: { type: 'number' } },
        required: ['id', 'amount'],
        additionalProperties: false,
      },
      permissions: ['workspace.write'],
      sideEffect: 'write',
      outputSchema: { type: 'object', properties: { appended: { type: 'boolean' } }, required: ['appended'] },
      async handler(args, ctx) {
        appendFileSync(resolveInSandbox(ctx.sandboxRoot, 'ledger.jsonl'), JSON.stringify(args) + String.fromCharCode(10));
        toolRecords.push({ name: 'append_record', ok: true });
        return { ok: true, data: { appended: true } };
      },
    });
    tools.push(createResultTool());
    const providerSource = createProvider({
      id: 'eval-' + randomUUID(),
      baseUrl: baseUrl!,
      apiKey: apiKey!,
      model,
      inputPrice: 0,
      outputPrice: 0,
      requestTimeoutMs: 120000,
    });
    const provider = {
      ...providerSource,
      async *chat(messages: LLMMessage[], opts: Parameters<typeof providerSource.chat>[1]) {
        yield* providerSource.chat(messages, {
          ...opts,
          maxTokens: 2048,
          temperature: 0,
          signal: opts.signal ? AbortSignal.any([opts.signal, abort]) : abort,
        });
      },
    };
    const makeRunner = (): AgentLoop =>
      variant === 'reference'
        ? new ReferenceLoop(kernel as unknown as KernelLike)
        : variant === 'baseline'
          ? new oldRunnerModule.AgentRunner(oldKernel, oldKernel.bus)
          : new AgentRunner(kernel as unknown as KernelLike, kernel.bus);
    runner = makeRunner();
    let maxTurns = task.category === 'recovery' ? 1 : 30;
    const options = (): RunOptions => ({
      provider,
      model,
      messages: [{ role: 'user', content: task.prompt }],
      contextMessages: [
        {
          role: 'system',
          content: `运行环境: Windows。工作区: ${sandbox}。工具路径相对工作区。授权: 工作区普通读写。`,
          context: { id: 'authorization', source: 'runtime-authorization', scope: 'runtime', trust: 'core', retention: 'required' },
        },
      ],
      tools,
      traceId: randomUUID(),
      sandboxRoot: sandbox,
      maxTurns,
      contextWindow: 60000,
      principalRole: 'admin',
      signal: abort,
    });
    if (variant === 'baseline') {
      const checkpointPath = join(kernel.paths.data, 'evaluation-checkpoint.json');
      mkdirSync(kernel.paths.data, { recursive: true });
      let checkpoint: { turn: number; history: LLMMessage[] } | undefined;
      const run = async (opts: RunOptions) => {
        let error: string | undefined;
        for await (const event of runner.run({
          ...opts,
          onCheckpoint: (turn, history) => {
            checkpoint = { turn, history };
            writeFileSync(checkpointPath, JSON.stringify(checkpoint));
          },
        })) {
          if (event.type === 'assistant_done') {
            sample.completed = true;
            answer = event.content;
          }
          if (event.type === 'error') error = event.error;
          if (event.type === 'approval_required') {
            sample.unnecessaryConfirmations++;
            runner.approveApproval(event.approvalId, false);
          }
        }
        return error;
      };
      const error = await run(options());
      if (task.category === 'recovery' && !sample.completed && checkpoint) {
        interrupted = true;
        checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
        runner = makeRunner();
        maxTurns = 30;
        restored = true;
        sample.runtimeError = await run({ ...options(), messages: checkpoint!.history, turnOffset: checkpoint!.turn + 1 });
      } else sample.runtimeError = error;
    } else {
      const database = join(kernel.paths.data, 'evaluation.db');
      mkdirSync(dirname(database), { recursive: true });
      store = new Store(database);
      const session = store.createSession(provider.id, model);
      const createService = () =>
        new RunService({
          store: store!,
          runner: () => runner,
          workspace: () => sandbox,
          provider: () => ({ id: provider.id, model }),
          tools: () => tools,
          prepare: () => ({ ...options(), systemPrompt: '你是具备工具能力的 maharness Agent。基于工具返回回答事实问题，不编造结果。' }),
        });
      service = createService();
      const record = service.create(session, { message: task.prompt, principalRole: 'admin' });
      const wait = async () => {
        while (!['completed', 'interrupted', 'failed', 'cancelled'].includes(service!.get(record.id, 'default').status)) {
          if (abort.aborted) service!.cancel(record.id, 'default');
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      };
      await wait();
      if (task.category === 'recovery' && service.get(record.id, 'default').status === 'interrupted') {
        interrupted = true;
        await service.shutdown();
        store.close();
        store = new Store(database);
        maxTurns = 30;
        runner = makeRunner();
        service = createService();
        restored = true;
        service.resume(record.id, 'default', 'admin');
        await wait();
      }
      const result = service.get(record.id, 'default');
      sample.completed = result.status === 'completed';
      answer = result.answer ?? '';
      if (!sample.completed) sample.runtimeError = result.error ?? result.status;
      const events = store.runs.events(record.id, 0, 10000);
      sample.eventGaps = events.filter((event, index) => event.seq !== index + 1).length;
      const durable = store.runs.toolCalls(record.id) as { id: string; status: string }[];
      sample.assertions.push({
        name: 'durable tool results',
        passed: durable.length > 0 && durable.every((call) => call.status !== 'running' && !!store!.runs.readTool(record.id, call.id)),
      });
    }
    sample.assertions.push(...task.check(sandbox));
    if (task.category === 'recovery')
      sample.assertions.push({ name: 'interrupted and resumed from persisted checkpoint', passed: interrupted && restored });
    if (task.fault && task.fault !== 'invalid-json') sample.assertions.push({ name: 'fault exercised', passed: faultObserved });
    if (task.category === 'recovery') {
      const ledger = join(sandbox, 'ledger.jsonl');
      const entries = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean) : [];
      sample.duplicateEffects = Math.max(0, entries.length - 1);
    }
  } catch (error) {
    sample.runtimeError = error instanceof Error ? error.message : String(error);
  } finally {
    await service?.shutdown();
    store?.close();
    await kernel.stop();
    await oldKernel?.stop();
    await Promise.allSettled(capture.pending);
  }
  sample.calls = capture.calls.length;
  sample.observedModels = [...new Set(capture.calls.flatMap((call) => call.models))];
  sample.tokensIn = capture.calls.reduce((sum, call) => sum + (call.input ?? 0), 0);
  sample.tokensOut = capture.calls.reduce((sum, call) => sum + (call.output ?? 0), 0);
  appendFileSync(
    samplesPath,
    JSON.stringify({
      ...sample,
      startedAt,
      endedAt: new Date().toISOString(),
      workspace: sandbox,
      answer,
      toolRecords,
      providerCalls: capture.calls,
      usageComplete: capture.calls.every((call) => call.input !== undefined && call.output !== undefined),
      faultObserved,
      interrupted,
      restored,
    }) + String.fromCharCode(10),
  );
  return sample;
}

const jobs = manifest.models.flatMap((model) =>
  tasks.flatMap((task) => [1, 2, 3].flatMap((repetition) => variants.map((variant) => ({ model, task, variant, repetition })))),
);
const samples: ReleaseSample[] = [...previous];
let seed = 20261114;
for (let i = jobs.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1);
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const sampleKey = (row: { tier: string; caseId: string; variant: string; repetition: number }) =>
  JSON.stringify([row.tier, row.caseId, row.variant, row.repetition]);
const started = new Set(samples.map(sampleKey));
if (continuing && existsSync(join(output, 'started.jsonl'))) {
  for (const line of readFileSync(join(output, 'started.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    const key = JSON.parse(line).key;
    if (!started.has(key))
      throw new Error('An already-started sample has unknown outcome; preserve it as invalid before continuing: ' + key);
  }
}
if (started.size !== samples.length) throw new Error('Duplicate existing sample keys');
let cursor = 0;
const limit = process.env.EVAL_PREFLIGHT_ONLY === 'true' ? 3 : jobs.length;
async function worker() {
  while (cursor < limit && !tokenBudget.stopped) {
    const job = jobs[cursor++];
    const key = sampleKey({ tier: job.model.tier, caseId: job.task.id, variant: job.variant, repetition: job.repetition });
    if (started.has(key)) continue;
    started.add(key);
    appendFileSync(join(output, 'started.jsonl'), JSON.stringify({ key, startedAt: new Date().toISOString() }) + '\n');
    const sample = await captures.run({ calls: [], pending: [] }, () =>
      execute(job.model.tier, job.model.requestedModel, job.variant, job.task, job.repetition),
    );
    samples.push(sample);
    console.log(
      `[release] ${samples.length}/${limit} ${sample.tier} ${sample.caseId} ${sample.variant}#${sample.repetition} complete=${sample.completed} assertions=${sample.assertions.filter((item) => item.passed).length}/${sample.assertions.length} calls=${sample.calls} catalog=${catalogSha256.slice(0, 12)}`,
    );
    writeFileSync(
      join(output, 'progress.json'),
      JSON.stringify({
        completed: samples.length,
        expected: jobs.length,
        tokensAccounted: tokenBudget.spent,
        tokensHeld: tokenBudget.held,
        tokenLimit: tokenBudget.limit,
        updatedAt: new Date().toISOString(),
      }),
    );
  }
}
try {
  await Promise.all(Array.from({ length: Math.max(1, Math.min(2, Number(process.env.EVAL_CONCURRENCY) || 2)) }, () => worker()));
} finally {
  globalThis.fetch = originalFetch;
}
const report = buildReleaseReport(manifest, samples, []);
const revisionCurrent = JSON.stringify(sourceHashes()) === JSON.stringify(evaluatedSources);
writeFileSync(
  join(output, 'report.json'),
  JSON.stringify(
    {
      ...report,
      performanceRevisionCurrent: revisionCurrent,
      tokensAccounted: tokenBudget.spent,
      tokensHeld: tokenBudget.held,
      tokenLimit: tokenBudget.limit,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.readyForRelease ? 0 : 2;
