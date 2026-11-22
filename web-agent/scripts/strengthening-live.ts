import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kernel } from '../kernel';
import { AgentRunner, annotateToolDef } from '../core/chat/agent';
import { createProvider } from '../core/chat/provider';
import { Store } from '../server/db';
import { RunService } from '../server/run-service';
import { resolveInSandbox } from '../kernel/sandbox';
import { ReferenceLoop } from '../evals/reference-loop';
import { strengtheningTasks, TokenBudget, buildStrengtheningReport, type StrengtheningSample } from '../evals/strengthening';
import { createResultTool } from '../core/chat/result-tool';
import { historyTools } from '../kernel/history-tools';
import type { ReleaseManifest, ReleaseVariant } from '../evals/release-report';
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
const output = resolve(process.env.EVAL_REPORT_DIR ?? 'evals/reports/strengthening-v2');
mkdirSync(output, { recursive: true });
const samplesPath = join(output, 'samples.jsonl');
const continuing = process.env.EVAL_CONTINUE_UNSTARTED === 'true';
if (existsSync(samplesPath) && !continuing) throw new Error('Report directory already contains samples; use a new directory');
if (continuing && !existsSync(samplesPath)) throw new Error('No previous sample ledger to continue');
if (continuing && existsSync(join(output, 'continuation-audit.json'))) throw new Error('This interrupted batch has already been continued');
const previousLedgerSha256 = continuing ? createHash('sha256').update(readFileSync(samplesPath)).digest('hex') : undefined;
const previousSamples: StrengtheningSample[] = continuing
  ? readFileSync(samplesPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const previousSources = continuing
  ? (JSON.parse(readFileSync(join(output, 'evaluated-sources.json'), 'utf8')) as Record<string, string>)
  : undefined;
const previousProgress = continuing
  ? (JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8')) as { tokensAccounted: number })
  : undefined;
const oldKernelModule = await import(pathToFileURL(join(baselineRoot, 'kernel/index.ts')).href);
const oldRunnerModule = await import(pathToFileURL(join(baselineRoot, 'core/chat/agent.ts')).href);
const variants = (process.env.EVAL_VARIANTS?.split(',') ?? ['baseline', 'reference', 'v2']) as ReleaseVariant[];
if (
  !variants.length ||
  new Set(variants).size !== variants.length ||
  variants.some((variant) => !['baseline', 'reference', 'v2'].includes(variant))
)
  throw new Error('EVAL_VARIANTS must contain distinct baseline, reference or v2 values');
const tasks = strengtheningTasks();
if (modelNames.length !== 2 || new Set(modelNames).size !== 2 || variants.length !== 3)
  throw new Error('Strengthening requires two routes and all three variants');
const tokenBudget = new TokenBudget(Number(process.env.EVAL_TOKEN_LIMIT ?? 1_000_000));
if (previousProgress) tokenBudget.spent = previousProgress.tokensAccounted + 100000; // Conservative allowance for the two interrupted workers without complete receipts.
function sourceSnapshot() {
  const hashes: Record<string, string> = {};
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!['reports', 'node_modules', 'data', 'dist', 'vendor'].includes(entry.name) && !/@[0-9a-f]{10}$/.test(entry.name)) walk(path);
      } else if (/\.(ts|mjs|json|tsx)$/.test(entry.name))
        hashes[path.slice(root.length + 1).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  for (const dir of ['core', 'kernel', 'server', 'evals', 'scripts', 'ui/src']) walk(join(root, dir));
  hashes['package.json'] = createHash('sha256')
    .update(readFileSync(join(root, 'package.json')))
    .digest('hex');
  return hashes;
}
const evaluatedSources = sourceSnapshot();
writeFileSync(
  join(output, continuing ? 'evaluated-sources-continuation.json' : 'evaluated-sources.json'),
  JSON.stringify(evaluatedSources, null, 2),
);
const catalogSha256 = createHash('sha256')
  .update(readFileSync(join(root, 'kernel/tool-discovery.ts')))
  .digest('hex');
writeFileSync(
  join(output, continuing ? 'runtime-fingerprints-continuation.json' : 'runtime-fingerprints.json'),
  JSON.stringify({ catalogSha256, variants }, null, 2),
);
const manifest: ReleaseManifest = {
  cases: tasks.map(({ id, category }) => ({ id, category })),
  models: modelNames.map((model, i) => ({ tier: 'tier-' + (i + 1), requestedModel: model, identity: 'route' })),
};
writeFileSync(
  join(output, continuing ? 'manifest-continuation.json' : 'manifest.json'),
  JSON.stringify(
    {
      ...manifest,
      kind: 'strengthening-comparison',
      repetitions: 1,
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
        .update(readFileSync(join(root, 'evals/strengthening.ts')))
        .digest('hex'),
      maxCallsPerSample: 12,
      maxTurns: 12,
      maxOutputTokens: 1024,
      maxSampleMs: 120000,
      totalTokenLimit: tokenBudget.limit,
      budgetUsd: 0,
      contextWindow: 60000,
      pricing: 'explicitly confirmed free; percentage cost overhead is unmeasurable',
    },
    null,
    2,
  ),
);

interface Call {
  models: string[];
  input?: number;
  output?: number;
  status?: number;
  error?: string;
  reservedTokens?: number;
  accounting?: string;
}
interface Capture {
  calls: Call[];
  pending: Promise<void>[];
  modelInvocations: number;
  retryEvents: number;
}
const captures = new AsyncLocalStorage<Capture>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const capture = captures.getStore();
  if (!capture) return originalFetch(url, init);
  if (capture.calls.length >= 12) throw new Error('EVAL_CALL_LIMIT');
  const body = typeof init?.body === 'string' ? init.body : '';
  const reservedTokens = Buffer.byteLength(body, 'utf8') + 2048 + 1024;
  const settle = tokenBudget.reserve(reservedTokens);
  const receipt: Call = { models: [], reservedTokens };
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
        })
        .catch((error) => {
          receipt.error = error instanceof Error ? error.name : 'STREAM_FAILED';
        })
        .finally(() => {
          const complete = receipt.input !== undefined && receipt.output !== undefined;
          settle(complete ? receipt.input! + receipt.output! : undefined);
          receipt.accounting = complete ? 'reported' : 'conservative-reservation';
        }),
    );
    return response;
  } catch (error) {
    settle();
    receipt.accounting = 'conservative-reservation';
    receipt.error = error instanceof Error ? error.name : 'REQUEST_FAILED';
    throw error;
  }
};

async function execute(
  tier: string,
  model: string,
  variant: ReleaseVariant,
  task: ReturnType<typeof strengtheningTasks>[number],
  repetition: number,
) {
  const sandbox = mkdtempSync(join(tmpdir(), 'maharness-release-'));
  for (const [path, content] of Object.entries(task.files)) {
    const file = join(sandbox, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const defaults = {
    sandboxRoot: sandbox,
    'agent.maxTurns': 12,
    'agent.toolTimeoutMs': 15000,
    'cache.l1Enabled': false,
    'agent.thinkInEnglish': false,
    'context.maxTokens': 60000,
  };
  const kernel = new Kernel(sandbox, defaults);
  const oldKernel = variant === 'baseline' ? new oldKernelModule.Kernel(sandbox, defaults) : undefined;
  const sample: StrengtheningSample = {
    caseId: task.id,
    tier,
    variant,
    repetition,
    completed: false,
    usageComplete: false,
    elapsedMs: 0,
    interruptionObserved: false,
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
  const abort = AbortSignal.timeout(120000);
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
    if (task.longObservation)
      tools.push({
        name: 'read_observation',
        version: '2.0.0',
        description: '读取唯一的原始观察材料；返回 text。',
        permissions: [],
        sideEffect: 'read',
        parameters: { type: 'object', properties: {} },
        outputSchema: { type: 'object', required: ['text'] },
        async handler() {
          toolRecords.push({ name: 'read_observation', ok: true });
          return { ok: true, data: { text: '材料段落。'.repeat(650) + '\nproof=TAIL-7294' } };
        },
      });
    const providerSource = createProvider({
      id: 'eval-' + randomUUID(),
      baseUrl: baseUrl!,
      apiKey: apiKey!,
      model,
      inputPrice: 0,
      outputPrice: 0,
      requestTimeoutMs: 45000,
    });
    const provider = {
      ...providerSource,
      async *chat(messages: LLMMessage[], opts: Parameters<typeof providerSource.chat>[1]) {
        capture.modelInvocations++;
        yield* providerSource.chat(messages, {
          ...opts,
          maxTokens: 1024,
          temperature: 0,
          signal: opts.signal ? AbortSignal.any([opts.signal, abort]) : abort,
        });
      },
    };
    let allowInterrupt = !!task.interruptAfter;
    const targetObserved = () =>
      toolRecords.some(
        (record) =>
          record.ok &&
          (task.interruptAfter === 'append'
            ? record.name === 'append_record'
            : task.interruptAfter === 'long'
              ? record.name === 'read_observation'
              : record.name === 'read_file'),
      );
    const makeRunner = (): AgentLoop => {
      const base: AgentLoop =
        variant === 'reference'
          ? new ReferenceLoop(kernel as unknown as KernelLike)
          : variant === 'baseline'
            ? new oldRunnerModule.AgentRunner(oldKernel, oldKernel.bus)
            : new AgentRunner(kernel as unknown as KernelLike, kernel.bus);
      return {
        approveApproval: (id, approved) => base.approveApproval(id, approved),
        async *run(opts) {
          const exposed = [...(opts.tools ?? [])];
          if (variant === 'reference' && opts.historyArchive)
            for (const tool of historyTools(opts.historyArchive)) if (!exposed.some((item) => item.name === tool.name)) exposed.push(tool);
          const schemas = variant === 'reference' ? exposed.map(annotateToolDef).sort((a, b) => a.name.localeCompare(b.name)) : exposed;
          const intercepted = {
            ...opts,
            tools: schemas,
            onCheckpoint: (...args: Parameters<NonNullable<RunOptions['onCheckpoint']>>) => {
              if (allowInterrupt && targetObserved()) {
                allowInterrupt = false;
                interrupted = true;
                sample.interruptionObserved = true;
                opts.onCheckpoint?.(...args);
                throw new Error('EVAL_CHECKPOINT_INTERRUPT');
              }
              opts.onCheckpoint?.(...args);
            },
          };
          try {
            for await (const event of base.run(intercepted)) {
              if (interrupted && !restored && event.type === 'error') {
                yield { type: 'error', kind: 'max-turns', error: 'EVAL_CHECKPOINT_INTERRUPT' };
                return;
              }
              if (event.type === 'retry') capture.retryEvents++;
              yield event;
            }
          } catch (error) {
            if (!(interrupted && !restored && error instanceof Error && error.message === 'EVAL_CHECKPOINT_INTERRUPT')) throw error;
            yield { type: 'error', kind: 'max-turns', error: 'EVAL_CHECKPOINT_INTERRUPT' };
          }
        },
      };
    };
    runner = makeRunner();
    let maxTurns = 12;
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
        maxTurns = 12;
        restored = true;
        sample.runtimeError = await run({
          ...options(),
          messages: [...checkpoint!.history, ...(task.supplement ? [{ role: 'user' as const, content: task.supplement }] : [])],
          turnOffset: checkpoint!.turn + 1,
        });
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
        maxTurns = 12;
        runner = makeRunner();
        service = createService();
        restored = true;
        service.resume(record.id, 'default', 'admin');
        if (task.supplement) service.supplement(record.id, 'default', task.supplement, 'eval-supplement');
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
        passed: durable.length > 0 && durable.every((call) => call.status !== 'started' && !!store!.runs.readTool(record.id, call.id)),
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
  sample.usageComplete = capture.calls.length > 0 && capture.calls.every((call) => call.input !== undefined && call.output !== undefined);
  sample.elapsedMs = Date.now() - Date.parse(startedAt);
  sample.failureStage = sample.runtimeError
    ? /EVAL_.*LIMIT/.test(sample.runtimeError)
      ? 'resource-limit'
      : sample.runtimeError === 'EVAL_CHECKPOINT_INTERRUPT'
        ? 'recovery'
        : 'runtime-or-provider'
    : sample.assertions.some((item) => !item.passed)
      ? 'artifact-assertion'
      : undefined;
  appendFileSync(
    samplesPath,
    JSON.stringify({
      ...sample,
      startedAt,
      endedAt: new Date().toISOString(),
      workspace: sandbox,
      answer,
      modelInvocations: capture.modelInvocations,
      retryEvents: capture.retryEvents,
      extraHttpRequests: Math.max(0, capture.calls.length - capture.modelInvocations),
      toolRecords,
      providerCalls: capture.calls,
      usageComplete: sample.usageComplete,
      faultObserved,
      interrupted,
      restored,
    }) + String.fromCharCode(10),
  );
  return sample;
}

const allJobs = tasks.flatMap((task, taskIndex) =>
  manifest.models.flatMap((model, modelIndex) => {
    const rotated = [...variants.slice((taskIndex + modelIndex) % 3), ...variants.slice(0, (taskIndex + modelIndex) % 3)];
    return rotated.map((variant) => ({ model, task, variant, repetition: 1 }));
  }),
);
const samples: StrengtheningSample[] = [...previousSamples];
const keyOf = (row: { tier: string; caseId: string; variant: ReleaseVariant }) => JSON.stringify([row.tier, row.caseId, row.variant]);
const occupied = new Set(samples.map(keyOf));
if (occupied.size !== samples.length) throw new Error('Duplicate existing samples');
if (continuing) {
  if (existsSync(join(output, 'continuation-audit.json'))) throw new Error('This interrupted batch has already been continued');
  // The original runner admitted two workers and allocated jobs monotonically.
  for (const job of allJobs.slice(0, Math.min(60, previousSamples.length + 2))) {
    const key = JSON.stringify([job.model.tier, job.task.id, job.variant]);
    if (occupied.has(key)) continue;
    const row: StrengtheningSample = {
      caseId: job.task.id,
      tier: job.model.tier,
      variant: job.variant,
      repetition: 1,
      completed: false,
      assertions: [],
      observedModels: [],
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      costSource: 'unknown',
      unnecessaryConfirmations: 0,
      duplicateEffects: 0,
      permissionViolations: 0,
      eventGaps: 0,
      usageComplete: false,
      elapsedMs: 0,
      interruptionObserved: false,
      failureStage: 'harness-abort',
      runtimeError: 'EVAL_HARNESS_ABORT_RECEIPTS_UNKNOWN',
    };
    samples.push(row);
    occupied.add(key);
    appendFileSync(
      samplesPath,
      JSON.stringify({ ...row, callsKnown: false, tokenAccounting: 'covered-by-interrupted-worker-reserve' }) + '\n',
    );
  }
  writeFileSync(
    join(output, 'continuation-audit.json'),
    JSON.stringify(
      {
        previousSamples: previousSamples.length,
        previousLedgerSha256,
        interruptedWorkers: samples.length - previousSamples.length,
        reservedUnknownTokens: 100000,
        reason:
          'Deliberate checkpoint interruption escaped the evaluation adapter; completed and admitted samples are retained without reruns.',
      },
      null,
      2,
    ),
  );
}
const jobs = allJobs.filter((job) => !occupied.has(JSON.stringify([job.model.tier, job.task.id, job.variant])));
let cursor = 0;
async function worker() {
  while (cursor < jobs.length && !tokenBudget.stopped) {
    const job = jobs[cursor++];
    const sample = await captures.run({ calls: [], pending: [], modelInvocations: 0, retryEvents: 0 }, () =>
      execute(job.model.tier, job.model.requestedModel, job.variant, job.task, job.repetition),
    );
    samples.push(sample);
    console.log(
      `[strengthening] ${samples.length}/60 ${sample.tier} ${sample.caseId} ${sample.variant} complete=${sample.completed} assertions=${sample.assertions.filter((item) => item.passed).length}/${sample.assertions.length} calls=${sample.calls} tokens-accounted=${tokenBudget.spent}`,
    );
    writeFileSync(
      join(output, 'progress.json'),
      JSON.stringify({ completed: samples.length, expected: 60, tokensAccounted: tokenBudget.spent, tokensReserved: tokenBudget.held }),
    );
  }
}
try {
  await Promise.all(Array.from({ length: 2 }, () => worker()));
} finally {
  globalThis.fetch = originalFetch;
}
const currentSources = sourceSnapshot();
const isRuntime = (file: string) =>
  (/^(core|kernel|server)\//.test(file) && !file.includes('/tests/') && !file.endsWith('.spec.ts')) ||
  file === 'evals/reference-loop.ts' ||
  file === 'package.json';
const runtimeView = (snapshot: Record<string, string>) => Object.fromEntries(Object.entries(snapshot).filter(([file]) => isRuntime(file)));
const revisionCurrent =
  JSON.stringify(runtimeView(previousSources ?? evaluatedSources)) === JSON.stringify(runtimeView(currentSources)) &&
  JSON.stringify(runtimeView(evaluatedSources)) === JSON.stringify(runtimeView(currentSources));
const procedureConsistent = !continuing;
writeFileSync(
  join(output, 'source-comparison.json'),
  JSON.stringify(
    {
      runtimeCurrent: revisionCurrent,
      procedureConsistent,
      changedFiles: Object.keys({ ...(previousSources ?? evaluatedSources), ...currentSources }).filter(
        (file) => (previousSources ?? evaluatedSources)[file] !== currentSources[file],
      ),
    },
    null,
    2,
  ),
);
const report = buildStrengtheningReport(
  manifest.models.map((model) => model.tier),
  tasks,
  samples,
  revisionCurrent,
  procedureConsistent,
);
writeFileSync(
  join(output, 'report.json'),
  JSON.stringify(
    {
      ...report,
      procedureConsistent,
      routes: manifest.models,
      tokenBudget: { limit: tokenBudget.limit, accounted: tokenBudget.spent, held: tokenBudget.held, stopped: tokenBudget.stopped },
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
const lines = [
  '# maharness 补强评测',
  '',
  `占用样本：${samples.length}/60；有效 ${report.validSamples}；夹具无效 ${report.invalidSamples.length}。运行时源码一致：${revisionCurrent ? '是' : '否'}。工程目标：${report.engineeringTargetsPassed ? '通过' : '未通过'}。`,
  '',
  '| 线路 | 组别 | 成功 / 有效样本 | 无效样本 | 恢复成功 / 有效样本 | 调用中位数 | usage 完整 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];
for (const model of report.models)
  for (const variant of variants) {
    const metrics = model[variant];
    lines.push(
      `| ${manifest.models.find((item) => item.tier === model.model)!.requestedModel} | ${variant} | ${metrics.passed}/${metrics.validSamples} | ${metrics.invalidSamples} | ${metrics.recoveryPassed}/${metrics.recoverySamples} | ${metrics.medianCalls ?? '未知'} | ${metrics.completeUsage}/${metrics.validSamples} |`,
    );
  }
lines.push('', '## 配对开销', '');
for (const model of report.models)
  lines.push(
    `- ${model.model}：双方成功且 usage 完整 ${model.paired.samples} 对；参考 / v2 输入中位数 ${model.paired.referenceTokens ?? '未知'} / ${model.paired.v2Tokens ?? '未知'}，调用中位数 ${model.paired.referenceCalls ?? '未知'} / ${model.paired.v2Calls ?? '未知'}；检查 ${JSON.stringify(model.checks)}。`,
  );
lines.push('', '## 失败样本', '', '| 模型 | 任务 | 组别 | 原因 |', '| --- | --- | --- | --- |');
for (const failed of report.failedSamples)
  lines.push(`| ${failed.model} | ${failed.task} | ${failed.variant} | ${failed.reason.replaceAll('|', '/').replaceAll('\n', ' ')} |`);
lines.push('', '## 夹具无效样本', '', '| 模型 | 任务 | 组别 | 原因 |', '| --- | --- | --- | --- |');
for (const invalid of report.invalidSamples) lines.push(`| ${invalid.model} | ${invalid.task} | ${invalid.variant} | ${invalid.reason} |`);
lines.push(
  '',
  '## 证据范围',
  '',
  '已启动项不补跑；评测夹具错误与中止项作为无效样本保留，相关比较为无法确认。权限只由确定性安全测试验证。每项每组每线路仅运行一次，属于专项验证，不证明统计显著性或完整发布门禁通过。路由标识不证明底层固定模型或能力档位。免费线路无法验证美元费用增幅。usage 缺失时预算按保守预留结算，配对 token 指标排除缺失 usage 的样本。中断点由工具执行后的持久断点触发；数据库与 RunService 重建，不等同于操作系统进程终止。',
  '',
  `全轮预算结算 ${tokenBudget.spent} tokens / 上限 ${tokenBudget.limit}；未执行样本 ${report.missing.length}。已记录请求次数（中止项次数未知） ${samples.reduce((sum, row) => sum + row.calls, 0)}。`,
  '',
  '失败定位：恢复与补充消息参见 server/run-service.ts；工具结果与模型输入参见 core/chat/agent.ts；工具目录参见 kernel/tool-discovery.ts。',
);
writeFileSync(join(output, 'REPORT.md'), lines.join('\n') + '\n');
console.log(
  JSON.stringify(
    {
      engineeringTargetsPassed: report.engineeringTargetsPassed,
      matrixComplete: report.matrixComplete,
      observedSamples: samples.length,
      tokensAccounted: tokenBudget.spent,
      report: join(output, 'REPORT.md'),
    },
    null,
    2,
  ),
);
process.exitCode = report.engineeringTargetsPassed ? 0 : 2;
