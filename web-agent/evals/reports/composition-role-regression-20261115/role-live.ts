import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../../kernel';
import { TaskPlugins } from '../../../core/self-extend/runtime';
import { AgentRunner } from '../../../core/chat/agent';
import { abortableDelay } from '../../../core/chat/tool-executor';
import { createProvider } from '../../../core/chat/provider';
import { Store } from '../../../server/db';
import { RunService } from '../../../server/run-service';
import { TokenBudget } from '../../../evals/strengthening';
import type { ProviderDef } from '../../../kernel/types';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const folder = dirname(fileURLToPath(import.meta.url));
const key = process.env.EVAL_API_KEY, url = process.env.EVAL_BASE_URL;
const models = process.env.EVAL_MODELS?.split(',').map(value => value.trim()).filter(Boolean);
if (!key || !url || models?.length !== 2 || process.env.EVAL_FREE_CONFIRMED !== 'true') throw new Error('Explicit free gateway and two routes required');
const samplesPath = join(folder, 'samples.jsonl');
try { readFileSync(samplesPath); throw new Error('Refusing to overwrite role regression samples'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
mkdirSync(folder, { recursive: true });
const budget = new TokenBudget(Number(process.env.EVAL_TOKEN_LIMIT));
const hashes: Record<string, string> = {};
const visit = (directory: string) => { for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
  const path = directory + '/' + item.name;
  if (item.isDirectory() && !['reports', 'node_modules'].includes(item.name) && !/@[0-9a-f]{10}$/.test(item.name)) visit(path);
  else if (item.isFile() && /\.(tsx?|mjs)$/.test(item.name)) hashes[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
} };
for (const directory of ['core', 'kernel', 'server', 'evals', 'scripts', 'ui/src']) visit(directory);
writeFileSync(join(folder, 'evaluated-sources.json'), JSON.stringify(hashes, null, 2));
writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ kind: 'hybrid-role-timeout-regression', models, repetitions: 3, expectedSamples: 6,
  parent: 'deterministic fixture; no parent gateway requests', child: 'live configured model route', initialChildDelayMs: 35000,
  ordinaryToolTimeoutMs: 30000, maxChildRequests: 4, maxOutputTokens: 512, requestTimeoutMs: 120000, sampleTimeoutMs: 300000,
  tokenLimit: budget.limit, sourceRevision: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), comparativePerformanceEvidence: false }, null, 2));
type Receipt = { id: string; input?: number; output?: number; status?: number; error?: string };
const storage = new AsyncLocalStorage<{ receipts: Receipt[]; pending: Promise<unknown>[] }>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (target, init) => {
  const capture = storage.getStore();
  if (!capture) return originalFetch(target, init);
  if (capture.receipts.length >= 4) throw new Error('EVAL_CALL_LIMIT');
  const reserved = typeof init?.body === 'string' ? Math.min(60000, Buffer.byteLength(init.body) + 512) + 512 : 61024;
  const settle = budget.reserve(reserved); const receipt: Receipt = { id: randomUUID() }; capture.receipts.push(receipt);
  const record = (state: string, accounted: number) => appendFileSync(join(folder, 'budget.jsonl'), JSON.stringify({ id: receipt.id, state, accounted }) + '\n');
  record('reserved', reserved);
  let settled = false;
  const finish = () => { if (settled) return; settled = true; const actual = receipt.input !== undefined && receipt.output !== undefined ? receipt.input + receipt.output : undefined;
    settle(actual); record(actual === undefined ? 'conservative' : 'reported', actual ?? reserved); };
  try {
    const response = await originalFetch(target, init); receipt.status = response.status;
    capture.pending.push(response.clone().text().then(text => {
      for (const line of text.split('\n')) { const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!raw || raw === '[DONE]') continue;
        try { const data = JSON.parse(raw); if (Number.isSafeInteger(data.usage?.prompt_tokens)) receipt.input = Math.max(receipt.input ?? 0, data.usage.prompt_tokens);
          if (Number.isSafeInteger(data.usage?.completion_tokens)) receipt.output = Math.max(receipt.output ?? 0, data.usage.completion_tokens); } catch {}
      }
      finish();
    }).catch(error => { receipt.error = error instanceof Error ? error.name : 'STREAM_FAILED'; finish(); }));
    return response;
  } catch (error) { receipt.error = error instanceof Error ? error.name : 'REQUEST_FAILED'; finish(); throw error; }
};

const source = `export default {id:'math-role',name:'Math Role',version:'1.0.0',onLoad(ctx:import('../../kernel/types').PluginContext){ctx.register({kind:'role',role:{id:'math-check',name:'Math Check',description:'Arithmetic',systemPrompt:'Calculate the user expression and reply with only its numeric result.',tools:'readonly'}});}};`;
const manifest = { apiVersion: 2, id: 'math-role', name: 'Math Role', version: '1.0.0', entry: 'index.ts', permissions: { capabilities: { role: ['math-check'] } } };
const jobs = models.flatMap(model => [1, 2, 3].map(repetition => ({ model, repetition })));
const samples: Record<string, unknown>[] = [];
async function execute(model: string, repetition: number) {
  const data = mkdtempSync(join(tmpdir(), 'maharness-role-regression-'));
  const kernel = new Kernel(root, { 'agent.toolTimeoutMs': 30000 }, { dataDir: data, userPluginsDir: join(data, 'plugins') });
  const store = new Store(':memory:'); let service: RunService | undefined;
  const capture = storage.getStore()!; const started = Date.now();
  const sample: Record<string, unknown> = { model, repetition, passed: false, workspace: data };
  appendFileSync(join(folder, 'started.jsonl'), JSON.stringify({ model, repetition, started }) + '\n');
  try {
    await kernel.plugins.register(join(root, 'core/self-extend')); await kernel.plugins.enable('self-extend');
    const plugins = new TaskPlugins(kernel); const tools = kernel.plugins.tools();
    const native = createProvider({ id: 'role-regression', baseUrl: url!, apiKey: key!, model, inputPrice: 0, outputPrice: 0, requestTimeoutMs: 120000 });
    let delayed = false, mainTurn = 0;
    const child: ProviderDef = { ...native, async *chat(messages, options) {
      if (!delayed) { delayed = true; await abortableDelay(35000, options.signal); }
      yield* native.chat(messages, { ...options, maxTokens: 512, temperature: 0 });
    } };
    const actions = [['create_plugin', { id: 'math-role', source, manifest }], ['enable_plugin', { id: 'math-role' }], ['invoke_plugin', { kind: 'role', name: 'math-check', objective: '3*4' }]] as const;
    const parent: ProviderDef = { id: native.id, label: 'deterministic parent fixture', defaultModel: model, prices: { in: 0, out: 0 }, async *chat() {
      const action = actions[mainTurn++];
      if (action) yield { type: 'tool_call', toolCall: { id: 'fixture-' + mainTurn, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } } };
      else yield { type: 'delta', text: 'Role invocation fixture finished.' };
      yield { type: 'usage', input: 1, output: 1 }; yield { type: 'done' };
    } };
    service = new RunService({ store, plugins, executionSlots: 1, tools: () => tools, workspace: () => data, provider: () => ({ id: native.id, model }),
      prepare: run => ({ provider: run.parentId ? child : parent, model, traceId: '', tools, messages: [], maxTurns: 8, contextWindow: 60000,
        systemPrompt: run.parentId ? 'Calculate the user expression. Return only the numeric result.' : 'Deterministic role integration fixture.' }),
      runner: () => new AgentRunner(kernel, kernel.bus) });
    service.setPluginDevelopment('default', { enabled: true, permissions: ['workspace.read', 'workspace.write', 'delegate'], dependencies: [] }, 0);
    const session = store.createSession(model, native.id); const run = service.create(session, { message: 'Exercise the registered role.', principalRole: 'admin' });
    const timeout = AbortSignal.timeout(300000);
    while (['queued', 'running', 'waiting_approval', 'stopping'].includes(service.get(run.id, 'default').status)) {
      if (timeout.aborted) service.cancel(run.id, 'default');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = service.get(run.id, 'default'); const children = store.runs.children(run.id, 'default');
    const calls = store.runs.toolCalls(run.id) as { name: string; status: string; startedAt: number; finishedAt?: number }[];
    const invocation = calls.find(call => call.name === 'invoke_plugin');
    const elapsed = invocation?.finishedAt === undefined ? undefined : invocation.finishedAt - invocation.startedAt;
    const assertions = [
      { name: 'parent completed', passed: result.status === 'completed' },
      { name: 'role child completed with actual result 12', passed: children.length === 1 && children[0].status === 'completed' && children[0].answer?.trim() === '12' },
      { name: 'delegation outlasted ordinary tool deadline', passed: invocation?.status === 'succeeded' && elapsed !== undefined && elapsed >= 35000 },
      { name: 'child gateway request observed', passed: capture.receipts.length > 0 },
    ];
    Object.assign(sample, { assertions, passed: assertions.every(check => check.passed), status: result.status, error: result.error, invocationElapsedMs: elapsed, children });
    writeFileSync(join(folder, model.replaceAll('/', '_') + '-' + repetition + '.json'), JSON.stringify({ events: store.runs.events(run.id, 0, 10000), tools: calls, children }, null, 2));
  } catch (error) { sample.error = String(error); }
  finally { await service?.shutdown(); store.close(); await kernel.stop(); await Promise.allSettled(capture.pending); }
  Object.assign(sample, { elapsedMs: Date.now() - started, receipts: capture.receipts, usageComplete: capture.receipts.length > 0 && capture.receipts.every(receipt => receipt.input !== undefined && receipt.output !== undefined) });
  samples.push(sample); appendFileSync(samplesPath, JSON.stringify(sample) + '\n');
  writeFileSync(join(folder, 'progress.json'), JSON.stringify({ completed: samples.length, expected: 6, tokensAccounted: budget.spent, tokensHeld: budget.held, tokenLimit: budget.limit }));
  console.log(`[role-regression] ${samples.length}/6 ${model}#${repetition} passed=${sample.passed}`);
}
let cursor = 0;
try { await Promise.all([0, 1].map(async () => { while (cursor < jobs.length && !budget.stopped) { const job = jobs[cursor++]; await storage.run({ receipts: [], pending: [] }, () => execute(job.model, job.repetition)); } })); }
finally { globalThis.fetch = originalFetch; }
const current: Record<string, string> = {};
for (const path of Object.keys(hashes)) current[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
const report = { kind: 'hybrid-role-timeout-regression', expected: 6, observed: samples.length, passed: samples.filter(sample => sample.passed).length,
  sourceRevisionCurrent: JSON.stringify(hashes) === JSON.stringify(current), tokensAccounted: budget.spent, tokenLimit: budget.limit, notComparativePerformanceEvidence: true };
writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
process.exitCode = report.observed === 6 && report.passed === 6 && report.sourceRevisionCurrent ? 0 : 2;
