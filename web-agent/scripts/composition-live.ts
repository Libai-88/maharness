import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kernel } from '../kernel';
import { TaskPlugins } from '../core/self-extend/runtime';
import { AgentRunner } from '../core/chat/agent';
import { createProvider } from '../core/chat/provider';
import { Store } from '../server/db';
import { RunService } from '../server/run-service';
import { compositionCases } from '../evals/composition-cases';
import { TokenBudget } from '../evals/strengthening';
import type { AgentLoop, RunOptions } from '../kernel/loop';
import type { ToolDef } from '../kernel/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.EVAL_API_KEY, url = process.env.EVAL_BASE_URL, baseline = process.env.EVAL_BASELINE_ROOT;
const models = process.env.EVAL_MODELS?.split(',').map(value => value.trim()).filter(Boolean);
if (!key || !url || !baseline || models?.length !== 2 || new Set(models).size !== 2 || process.env.EVAL_FREE_CONFIRMED !== 'true') throw new Error('Explicit gateway, two free routes and baseline source required');
const output = resolve(process.env.EVAL_REPORT_DIR ?? 'evals/reports/composition'); mkdirSync(output, { recursive: true });
const samplesFile = join(output, 'samples.jsonl');
const continuing = process.env.EVAL_CONTINUE_UNSTARTED === 'true';
if (existsSync(samplesFile) && !continuing) throw new Error('Use a new evaluation directory');
function hashes() {
  const result: Record<string, string> = {};
  const walk = (dir: string) => { for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir + '/' + item.name;
    if (item.isDirectory() && !['reports', 'node_modules'].includes(item.name) && !/@[0-9a-f]{10}$/.test(item.name)) walk(path);
    else if (item.isFile() && /\.(tsx?|mjs)$/.test(item.name)) result[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  } };
  for (const dir of ['core', 'kernel', 'server', 'evals', 'scripts', 'ui/src']) walk(dir); return result;
}
const sourceHashes = hashes(), sourcePath = join(output, 'evaluated-sources.json');
if (continuing && JSON.stringify(JSON.parse(readFileSync(sourcePath, 'utf8'))) !== JSON.stringify(sourceHashes)) throw new Error('Evaluation source revision changed; cannot combine batches');
if (!continuing) writeFileSync(sourcePath, JSON.stringify(sourceHashes, null, 2));
const old = await import(pathToFileURL(join(baseline, 'kernel/index.ts')).href);
const oldAgent = await import(pathToFileURL(join(baseline, 'core/chat/agent.ts')).href);
const tokenBudget = new TokenBudget(Number(process.env.EVAL_TOKEN_LIMIT ?? 10_000_000));
if (continuing && existsSync(join(output, 'budget.jsonl'))) {
  const calls = new Map<string, number>();
  for (const line of readFileSync(join(output, 'budget.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)) { const row = JSON.parse(line); calls.set(row.id, row.accounted); }
  tokenBudget.spent = [...calls.values()].reduce((sum, value) => sum + value, 0);
}
interface Receipt { id: string; models: string[]; input?: number; output?: number; status?: number; error?: string; }
interface Capture { receipts: Receipt[]; pending: Promise<unknown>[]; }
const storage = new AsyncLocalStorage<Capture>(), fetchOriginal = globalThis.fetch;
globalThis.fetch = async (target, init) => {
  const capture = storage.getStore(); if (!capture) return fetchOriginal(target, init);
  if (capture.receipts.length >= 24) throw new Error('EVAL_CALL_LIMIT');
  const held = typeof init?.body === 'string' ? Math.min(60000, Buffer.byteLength(init.body) + 4096) + 4096 : 64096;
  const settle = tokenBudget.reserve(held); const receipt: Receipt = { id: randomUUID(), models: [] }; capture.receipts.push(receipt);
  const budget = (state: string, accounted: number) => appendFileSync(join(output, 'budget.jsonl'), JSON.stringify({ id: receipt.id, state, accounted }) + '\n'); budget('reserved', held);
  let done = false; const finish = () => { if (done) return; done = true; const actual = receipt.input !== undefined && receipt.output !== undefined ? receipt.input + receipt.output : undefined; settle(actual); budget(actual === undefined ? 'conservative' : 'reported', actual ?? held); };
  try {
    const response = await fetchOriginal(target, init); receipt.status = response.status;
    capture.pending.push(response.clone().text().then(text => {
      for (const line of text.split('\n')) { const json = line.startsWith('data:') ? line.slice(5).trim() : line.trim(); try {
        const data = JSON.parse(json); if (typeof data.model === 'string' && !receipt.models.includes(data.model)) receipt.models.push(data.model);
        if (Number.isSafeInteger(data.usage?.prompt_tokens)) receipt.input = Math.max(receipt.input ?? 0, data.usage.prompt_tokens);
        if (Number.isSafeInteger(data.usage?.completion_tokens)) receipt.output = Math.max(receipt.output ?? 0, data.usage.completion_tokens);
      } catch { /* SSE control frames */ } }
    }).catch(error => { receipt.error = String(error); }).finally(finish)); return response;
  } catch (error) { receipt.error = String(error); finish(); throw error; }
};
const sdk = `插件导出默认对象 {id,name,version,onLoad(ctx)}，ToolDef 必须包含 name,version,description,permissions,sideEffect,parameters,outputSchema,async handler(args,tctx)。成功返回 {ok:true,data:...}。PluginContext 类型可用 import('../../kernel/types').PluginContext。任务可用 create_plugin、enable_plugin、plugin_status、disable_plugin；能力发现使用 discover_tools/enable_tools。命令、角色、供应商入口通过 discover_tools 查找。任务已获工作区插件开发和读写/网络/委派授权；只能使用纯计算、ctx.storage 与 ToolContext.invoke 宿主工具，不能直接导入文件/进程/网络。模块用本地相对导入；无需安装依赖。manifest 的 apiVersion=2，permissions.capabilities 按实际 kind/名称声明。role/provider/persona/context 的名称是 id；api 是 mount；listener 是 event。工具未提供时可发现并加载。`;
const jobs = models.flatMap(model => compositionCases.flatMap(task => [1, 2, 3].flatMap(repetition => (['baseline', 'v2'] as const).map(variant => ({ model, task, repetition, variant })))));
let seed = 20261115; for (let i = jobs.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
const selectedJobs = process.env.EVAL_PREFLIGHT_ONLY === 'true' ? jobs.filter(job => job.task.id === 'pure-tool' && job.repetition === 1) : jobs;
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ models, cases: compositionCases, repetitions: 3, variants: ['baseline', 'v2'], baseline, expected: 144, seed: 20261115, tokenLimit: tokenBudget.limit, maxTurns: 20, maxRequests: 24, maxOutput: 4096, timeoutMs: 600000, requestTimeoutMs: 120000, identity: 'routes, not pinned model versions', baselineAgent: createHash('sha256').update(readFileSync(join(baseline, 'core/chat/agent.ts'))).digest('hex') }, null, 2));
type Sample = { model: string; caseId: string; repetition: number; variant: string; completed: boolean; answer: string; assertions: { name: string; passed: boolean }[]; error?: string; tokensIn: number; tokensOut: number; calls: number; usageComplete: boolean; elapsedMs: number; receipts: Receipt[]; };
const samples: Sample[] = continuing && existsSync(samplesFile) ? readFileSync(samplesFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
const sampleKey = (row: { model: string; caseId: string; repetition: number; variant: string }) => JSON.stringify([row.model, row.caseId, row.repetition, row.variant]);
const finished = new Set(samples.map(sampleKey));
if (finished.size !== samples.length) throw new Error('Duplicate samples');
if (continuing && existsSync(join(output, 'started.jsonl'))) for (const line of readFileSync(join(output, 'started.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
  if (!finished.has(sampleKey(JSON.parse(line)))) throw new Error('Already-started sample has an unknown outcome; cannot replay');
}
async function execute(job: typeof jobs[number]): Promise<void> {
  const { model, task, variant, repetition } = job; const started = Date.now();
  const data = mkdtempSync(join(tmpdir(), 'mh-plugin-eval-'));
  appendFileSync(join(output, 'started.jsonl'), JSON.stringify({ model, caseId: task.id, repetition, variant, started, data }) + '\n');
  if (variant === 'baseline') {
    mkdirSync(join(data, 'core/self-extend'), { recursive: true }); mkdirSync(join(data, 'plugins'));
    for (const file of ['index.ts', 'plugin.json']) writeFileSync(join(data, 'core/self-extend', file), readFileSync(join(baseline!, 'core/self-extend', file)));
    for (const dir of ['kernel', 'node_modules']) symlinkSync(join(baseline!, dir), join(data, dir), 'junction');
  }
  const kernel: Kernel = variant === 'baseline' ? new old.Kernel(data, { sandboxRoot: data }, { dataDir: join(data, 'state') }) : new Kernel(root, { sandboxRoot: data }, { dataDir: data, userPluginsDir: join(data, 'plugins') });
  const store = new Store(':memory:'); let service: RunService | undefined;
  const capture = storage.getStore()!;
  const sample: Sample = { model, caseId: task.id, repetition, variant, completed: false, answer: '', assertions: [], tokensIn: 0, tokensOut: 0, calls: 0, usageComplete: false, elapsedMs: 0, receipts: capture.receipts };
  try {
    await kernel.plugins.register(join(variant === 'baseline' ? data : root, 'core/self-extend')); await kernel.plugins.enable('self-extend');
    if (variant === 'baseline') kernel.plugins.watch();
    const plugins = variant === 'v2' ? new TaskPlugins(kernel) : undefined;
    const timeout = AbortSignal.timeout(600000);
    const original = createProvider({ id: 'composition', baseUrl: url!, apiKey: key!, model, inputPrice: 0, outputPrice: 0, requestTimeoutMs: 120000 });
    const provider = { ...original, async *chat(messages: Parameters<typeof original.chat>[0], options: Parameters<typeof original.chat>[1]) { yield* original.chat(messages, { ...options, temperature: 0, maxTokens: 4096, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout }); } };
    const tools: ToolDef[] = kernel.plugins.tools();
    const options = (): RunOptions => ({ provider, model, messages: [], tools, traceId: '', maxTurns: 20, systemPrompt: '基于工具返回报告事实，不编造结果。', contextWindow: 60000, contextMessages: [{ role: 'user', content: sdk, context: { id: 'sdk-reference', source: 'evaluation-material', scope: 'run', trust: 'reference', retention: 'required' } }] });
    service = new RunService({ store, plugins, tools: () => tools, workspace: () => data, provider: () => ({ id: provider.id, model }), prepare: options, runner: () => (variant === 'baseline' ? new oldAgent.AgentRunner(kernel, kernel.bus) : new AgentRunner(kernel, kernel.bus)) as AgentLoop });
    service.setPluginDevelopment('default', { enabled: true, permissions: ['workspace.read', 'workspace.write', 'network', 'delegate'], dependencies: [] }, 0);
    const session = store.createSession(model, provider.id); const record = service.create(session, { message: task.prompt, principalRole: 'admin' });
    // Both variants receive the same pre-authorized development scope. The baseline's extra approval is measured and explicitly answered.
    const { globalApprovalBoard } = await import('../core/chat/approvals');
    const { globalApprovalBoard: oldBoard } = await import(pathToFileURL(join(baseline!, 'core/chat/approvals.ts')).href);
    while (['queued', 'running', 'waiting_approval', 'stopping'].includes(service.get(record.id, 'default').status)) {
      for (const board of [globalApprovalBoard, oldBoard]) for (const item of board.listPending(record.sessionId)) board.approve(item.id, true);
      if (timeout.aborted) service.cancel(record.id, 'default');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = service.get(record.id, 'default'); sample.completed = result.status === 'completed'; sample.answer = result.answer ?? ''; sample.error = result.error;
    const events = store.runs.events(record.id, 0, 10000);
    const bindings = store.runs.plugins(record.id);
    const oldLoaded = kernel.plugins.list().filter(item => item.manifest.id !== 'self-extend');
    const oldSources = oldLoaded.flatMap(item => {
      const directory = join(data, 'plugins', item.manifest.id);
      return existsSync(directory) ? readdirSync(directory).filter(name => /\.[cm]?[jt]sx?$/.test(name)).map(name => readFileSync(join(directory, name), 'utf8')) : [];
    });
    const calls = store.runs.toolCalls(record.id) as { name: string; status: string; argsSummary: string }[];
    const declared = variant === 'v2' ? bindings.map(binding => binding.manifest) : oldLoaded.map(item => item.manifest);
    sample.assertions.push({ name: 'proof in final answer', passed: sample.answer.includes(task.proof) });
    sample.assertions.push({ name: 'required plugin capability contracts', passed: task.kinds.every(kind => declared.some(manifest => Object.hasOwn(manifest.permissions.capabilities, kind))) });
    if (task.id === 'multi-file') sample.assertions.push({ name: 'multiple source files', passed: variant === 'v2' ? bindings.some(binding => Object.keys(binding.files).length >= 2) : oldSources.length >= 2 });
    if (task.tools) sample.assertions.push({ name: 'new tools used in this run', passed: task.tools.every(name => (store.runs.toolCalls(record.id) as { name: string; status: string }[]).some(call => call.name === name && call.status === 'succeeded')) });
    if (task.id === 'failed-upgrade') sample.assertions.push({ name: 'failed activation preserved working version', passed: variant === 'v2' ? events.some(event => event.type === 'plugin_error') && bindings.some(binding => binding.state === 'stopped') : calls.some(call => call.name === 'enable_plugin' && call.status === 'failed') && calls.some(call => call.name === 'stable_value' && call.status === 'succeeded') });
    if (task.id === 'release-resources') sample.assertions.push({ name: 'explicit release observed', passed: variant === 'v2' ? events.some(event => event.type === 'plugin_released') : calls.some(call => call.name === 'disable_plugin' && call.status === 'succeeded') });
    if (task.id === 'role') sample.assertions.push({ name: 'role delegated', passed: store.runs.children(record.id, 'default').some(child => child.status === 'completed') });
    if (task.id === 'api-panel') sample.assertions.push({ name: 'registered panel source', passed: variant === 'v2' ? bindings.some(binding => Object.values(binding.files).some(source => source.includes('value=29'))) : oldSources.some(source => source.includes('value=29')) });
    sample.assertions.push({ name: 'contiguous events', passed: events.every((event, i) => event.seq === i + 1) });
    writeFileSync(join(output, `${variant}-${model.replaceAll('/', '_')}-${task.id}-${repetition}.json`), JSON.stringify({ events, plugins: bindings.map(({ files, ...binding }) => ({ ...binding, files: Object.keys(files) })), tools: store.runs.toolCalls(record.id) }, null, 2));
  } catch (error) { sample.error = String(error); }
  finally { await service?.shutdown(); store.close(); await kernel.stop(); await Promise.allSettled(capture.pending); }
  sample.calls = capture.receipts.length; sample.tokensIn = capture.receipts.reduce((sum, row) => sum + (row.input ?? 0), 0); sample.tokensOut = capture.receipts.reduce((sum, row) => sum + (row.output ?? 0), 0); sample.usageComplete = capture.receipts.length > 0 && capture.receipts.every(row => row.input !== undefined && row.output !== undefined); sample.elapsedMs = Date.now() - started;
  samples.push(sample); appendFileSync(samplesFile, JSON.stringify(sample) + '\n');
  writeFileSync(join(output, 'progress.json'), JSON.stringify({ completed: samples.length, expected: jobs.length, tokensAccounted: tokenBudget.spent, tokensHeld: tokenBudget.held, tokenLimit: tokenBudget.limit }));
  console.log(`[composition] ${samples.length}/${jobs.length} ${model} ${task.id} ${variant}#${repetition} passed=${sample.completed && sample.assertions.every(item => item.passed)} calls=${sample.calls}`);
}
let cursor = 0;
try { await Promise.all([0, 1].map(async () => { while (cursor < selectedJobs.length && !tokenBudget.stopped) { const job = selectedJobs[cursor++]; if (finished.has(sampleKey({ ...job, caseId: job.task.id }))) continue; await storage.run({ receipts: [], pending: [] }, () => execute(job)); } })); }
finally { globalThis.fetch = fetchOriginal; }
const report = { expected: 144, observed: samples.length, complete: samples.length === 144, sourceRevisionCurrent: JSON.stringify(sourceHashes) === JSON.stringify(hashes()), tokensAccounted: tokenBudget.spent, tokenLimit: tokenBudget.limit,
  models: models.map(model => ({ model, variants: ['baseline', 'v2'].map(variant => { const rows = samples.filter(row => row.model === model && row.variant === variant); return { variant, samples: rows.length, passed: rows.filter(row => row.completed && row.assertions.length > 0 && row.assertions.every(item => item.passed)).length, completeUsage: rows.filter(row => row.usageComplete).length, tokensIn: rows.reduce((sum, row) => sum + row.tokensIn, 0) }; }) })),
  failures: samples.filter(row => !row.completed || !row.assertions.length || row.assertions.some(item => !item.passed)).map(({ receipts: _receipts, answer: _answer, ...row }) => row), readyForRelease: false };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, failures: report.failures.length }, null, 2));
process.exitCode = report.complete && report.sourceRevisionCurrent ? 0 : 2;
