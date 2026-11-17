import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProvider } from '../core/chat/provider';
import type { RunRecord } from '../kernel/run';
import type { ProviderDef } from '../kernel/types';
import { Store } from '../server/db';
import { ExperienceError, ExperienceService } from '../server/experience';

const root = resolve(import.meta.dirname, '..');
const baseUrl = process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
const model = process.env.EVAL_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.log('[eval:experience:live] 需要 EVAL_BASE_URL、EVAL_API_KEY、EVAL_MODEL；未发送模型请求。');
  process.exit(2);
}

const reportDir = resolve(process.env.EVAL_REPORT_DIR ?? join(root, 'evals', 'reports', 'experience-live', new Date().toISOString().replace(/[:.]/g, '-')));
if (existsSync(join(reportDir, 'manifest.json'))) throw new Error('EVAL_REPORT_DIR must be new');
mkdirSync(reportDir, { recursive: true });

const providerId = 'experience-live';
const inputPrice = Number(process.env.EVAL_INPUT_USD_PER_MILLION ?? 0);
const outputPrice = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION ?? 0);
const timeoutMs = Number(process.env.EVAL_REQUEST_TIMEOUT_MS ?? 120_000);
if (![inputPrice, outputPrice, timeoutMs].every(value => Number.isFinite(value) && value >= 0) || timeoutMs < 1_000) {
  throw new Error('EVAL_EXPERIENCE_CONFIGURATION_INVALID');
}

const provider: ProviderDef = createProvider({
  id: providerId,
  baseUrl,
  apiKey,
  model,
  protocol: process.env.EVAL_PROTOCOL ?? 'openai',
  inputPrice,
  outputPrice,
  requestTimeoutMs: timeoutMs,
});

interface Capture {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  outputChars: number;
  reasoningChars: number;
  finish?: string;
  tail: string;
}

function capturingProvider(capture: Capture): ProviderDef {
  return {
    ...provider,
    async *chat(messages, options) {
      capture.attempts++;
      for await (const chunk of provider.chat(messages, options)) {
        if (chunk.type === 'delta') {
          capture.outputChars += chunk.text.length;
          capture.tail = (capture.tail + chunk.text).slice(-500);
        } else if (chunk.type === 'reasoning') {
          capture.reasoningChars += chunk.text.length;
        } else if (chunk.type === 'usage') {
          if (Number.isSafeInteger(chunk.input)) capture.inputTokens = Math.max(capture.inputTokens, chunk.input ?? 0);
          if (Number.isSafeInteger(chunk.output)) capture.outputTokens = Math.max(capture.outputTokens, chunk.output ?? 0);
        } else if (chunk.type === 'done') {
          capture.finish = chunk.reason;
        }
        yield chunk;
      }
    },
  };
}

interface CaseDefinition {
  id: number;
  name: string;
  expected: 'positive' | 'neutral_or_negative' | 'negative' | 'unavailable';
  expectedText?: RegExp;
  setup: (store: Store) => RunRecord[];
}

const passVerification = { status: 'passed', objective: '完成', checks: [{ ok: true, reason: '结果可解析' }], evidence: [] };
const failVerification = { status: 'failed', objective: '失败', checks: [{ ok: false, reason: '结果不可用' }], evidence: [] };

function addRun(store: Store, input: {
  objective: string;
  status?: RunRecord['status'];
  verification?: unknown;
  answer?: string;
} = { objective: '完成普通任务' }): RunRecord {
  const session = store.createSession(model!, providerId, 'default');
  const now = Date.now();
  const id = randomUUID();
  const record: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId: 'default', depth: 0,
    objective: input.objective, providerId, model: model!, status: 'running',
    authorization: { workspace: process.cwd(), profile: 'standard', revision: 0, readOnly: false },
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now - 100, updatedAt: now,
  };
  store.runs.create(record);
  store.runs.update(record, {
    status: input.status ?? 'completed',
    answer: input.answer ?? '任务结果和来源可检查。',
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  }, 'done', { status: input.status ?? 'completed' });
  return store.runs.get(id, 'default')!;
}

function addInvalidTool(store: Store, run: RunRecord, suffix: string, code = 'INVALID_ARGS'): void {
  store.runs.startTool(run.id, suffix, 'read_file', 'missing.txt', { sideEffect: 'read' });
  store.runs.finishTool(run.id, suffix, {
    ok: false,
    error: '参数或目标无效',
    failure: { code, retryable: true, outcome: 'not_started' },
  });
}

const cases: CaseDefinition[] = [
  {
    id: 1, name: '正常成功', expected: 'positive',
    setup: store => [addRun(store, { objective: '读取资料并给出可核对摘要', verification: passVerification })],
  },
  {
    id: 2, name: '参数循环', expected: 'neutral_or_negative', expectedText: /参数|重复|循环|契约/,
    setup: store => {
      const run = addRun(store, { objective: '读取目标文件' });
      addInvalidTool(store, run, 'bad-1');
      addInvalidTool(store, run, 'bad-2');
      return [run];
    },
  },
  {
    id: 3, name: '结果不可用', expected: 'negative', expectedText: /产物|不可用|解析|结果/,
    setup: store => {
      const run = addRun(store, { objective: '生成并检查交付文件' });
      store.runs.append(run.id, 'artifact_invalid', { reason: '生成文件重新解析失败' });
      return [run];
    },
  },
  {
    id: 4, name: '上下文丢失', expected: 'negative', expectedText: /上下文|断点|连续性|恢复/,
    setup: store => {
      const run = addRun(store, { objective: '继续之前的检查' });
      store.runs.append(run.id, 'checkpoint_incomplete', { error: '恢复时缺少上下文边界' });
      return [run];
    },
  },
  {
    id: 5, name: '无谓审批等待', expected: 'neutral_or_negative', expectedText: /审批|授权|等待/,
    setup: store => {
      const run = addRun(store, { objective: '只读查看配置' });
      store.runs.append(run.id, 'approval_required', { name: 'read_file', summary: '只读调用进入审批' });
      return [run];
    },
  },
  {
    id: 6, name: '失败后恢复', expected: 'neutral_or_negative', expectedText: /恢复|重试|失败/,
    setup: store => {
      const run = addRun(store, { objective: '遇到错误后继续完成任务' });
      addInvalidTool(store, run, 'recovered-1');
      store.runs.append(run.id, 'tool_recovered', { name: 'read_file', outcome: 'not_started' });
      return [run];
    },
  },
  {
    id: 7, name: '虚假成功', expected: 'negative', expectedText: /虚假|验收|失败|未通过/,
    setup: store => [addRun(store, { objective: '完成任务并保留结果', verification: failVerification })],
  },
  {
    id: 8, name: '跨任务重复摩擦', expected: 'neutral_or_negative', expectedText: /重复|再次|跨.*运行|同类/,
    setup: store => {
      const first = addRun(store, { objective: '第一次读取配置' });
      const second = addRun(store, { objective: '第二次读取配置' });
      addInvalidTool(store, first, 'repeat-1');
      addInvalidTool(store, second, 'repeat-2');
      return [first, second];
    },
  },
  {
    id: 9, name: '模型不可用', expected: 'unavailable',
    setup: store => [addRun(store, { objective: '原模型已不可用' })],
  },
];

const selectedIds = process.env.EVAL_CASES?.split(',').map(Number).filter(Number.isFinite);
const selected = selectedIds?.length ? cases.filter(item => selectedIds.includes(item.id)) : cases;
type Result = {
  id: number; name: string; passed: boolean; expected: string; verdict?: string; status?: string;
  path?: string; calls?: number; inputTokens?: number; outputTokens?: number; costUsd?: number;
  elapsedMs: number; evidenceRefsValid: boolean; error?: string; summary?: string;
};

const results: Result[] = [];
for (const item of selected) {
  const started = Date.now();
  const store = new Store(':memory:');
  const capture: Capture = { attempts: 0, inputTokens: 0, outputTokens: 0, outputChars: 0, reasoningChars: 0, tail: '' };
  try {
    const runs = item.setup(store);
    if (item.id === 9) {
      const service = new ExperienceService({ store, providers: () => [], emit: () => undefined });
      const estimate = service.estimate({ runIds: [runs[0]!.id] }, 'default');
      let blocked = false;
      try { service.create({ runIds: [runs[0]!.id] }, 'default'); }
      catch (error) { blocked = error instanceof ExperienceError && error.code === 'ORIGINAL_MODEL_UNAVAILABLE'; }
      results.push({
        id: item.id, name: item.name, passed: !estimate.available && estimate.requiresExplicitModel && blocked,
        expected: item.expected, status: 'blocked_without_model', calls: 0, inputTokens: 0, outputTokens: 0,
        costUsd: 0, elapsedMs: Date.now() - started, evidenceRefsValid: true,
        summary: '未调用模型，要求人类显式选择替代模型',
      });
      continue;
    }

    const service = new ExperienceService({ store, providers: () => [capturingProvider(capture)], emit: () => undefined });
    const review = service.create({ runIds: runs.map(run => run.id) }, 'default');
    const timeout = setTimeout(() => service.cancel(review.id, 'default'), timeoutMs + 5_000);
    try { await service.settled(review.id); } finally { clearTimeout(timeout); }
    const finished = service.review(review.id, 'default');
    const validRefs = new Set(finished.evidenceIndex.map(evidence => evidence.id));
    const evidenceRefsValid = [...finished.dimensions, ...finished.observations, ...finished.suggestions]
      .flatMap(value => value.evidenceRefs)
      .every(ref => validRefs.has(ref));
    const verdictPass = item.expected === 'positive'
      ? finished.verdict === 'positive'
      : item.expected === 'negative'
        ? finished.verdict === 'negative'
        : finished.verdict === 'neutral' || finished.verdict === 'negative';
    const summary = [
      ...finished.observations.map(value => value.summary),
      ...finished.suggestions.map(value => `${value.title} ${value.detail}`),
    ].join('\n');
    results.push({
      id: item.id, name: item.name,
      passed: finished.status === 'completed' && verdictPass && evidenceRefsValid
        && (!item.expectedText || item.expectedText.test(summary)),
      expected: item.expected, verdict: finished.verdict, status: finished.status, path: finished.path,
      calls: capture.attempts,
      inputTokens: capture.inputTokens || finished.budget.inputTokens,
      outputTokens: capture.outputTokens || finished.budget.outputTokens,
      costUsd: (capture.inputTokens * inputPrice + capture.outputTokens * outputPrice) / 1e6,
      elapsedMs: Date.now() - started, evidenceRefsValid,
      ...(finished.error ? {
        error: `${finished.error}; finish=${capture.finish ?? 'unknown'} outputChars=${capture.outputChars} reasoningChars=${capture.reasoningChars} tail=${JSON.stringify(capture.tail.slice(-180))}`,
      } : {}),
      summary,
    });
  } catch (error) {
    results.push({
      id: item.id, name: item.name, passed: false, expected: item.expected,
      calls: capture.attempts, inputTokens: capture.inputTokens, outputTokens: capture.outputTokens,
      costUsd: (capture.inputTokens * inputPrice + capture.outputTokens * outputPrice) / 1e6,
      elapsedMs: Date.now() - started, evidenceRefsValid: false,
      error: `${String(error).replaceAll(apiKey, '[REDACTED]').replaceAll(baseUrl, '[configured-gateway]')}; finish=${capture.finish ?? 'unknown'} outputChars=${capture.outputChars} reasoningChars=${capture.reasoningChars} tail=${JSON.stringify(capture.tail.slice(-180))}`,
    });
  } finally {
    store.close();
  }
}

const report = {
  kind: 'ai-user-experience-real-model',
  createdAt: new Date().toISOString(),
  provider: { id: provider.id, model, pricingUsdPerMillion: { input: inputPrice, output: outputPrice }, billingVerified: false },
  samples: results,
  passed: results.filter(item => item.passed).length,
  total: results.length,
  modelCalls: results.reduce((sum, item) => sum + (item.calls ?? 0), 0),
  inputTokens: results.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
  outputTokens: results.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
  costUsd: results.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
  limitations: ['只验证 AI 用户复盘本身，不验证实际任务执行质量。', '汇总的 provider/model 为配置路由，不代表固定上游模型版本。'],
};
writeFileSync(join(reportDir, 'manifest.json'), JSON.stringify({ kind: report.kind, createdAt: report.createdAt, provider: provider.id, model, pricingUsdPerMillion: report.provider.pricingUsdPerMillion, cases: selected.map(item => item.id) }, null, 2));
writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
for (const item of results) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.id} ${item.name} status=${item.status ?? 'error'} verdict=${item.verdict ?? '-'} tokens=${(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} cost=$${(item.costUsd ?? 0).toFixed(6)} ${item.elapsedMs}ms`);
console.log(`[eval:experience:live] ${report.passed}/${report.total} 通过 · calls=${report.modelCalls} · tokens=${report.inputTokens}/${report.outputTokens} · cost=$${report.costUsd.toFixed(6)} · report=${reportDir}`);
process.exit(report.passed >= Math.ceil(report.total * 8 / 9) ? 0 : 1);
