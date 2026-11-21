import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProvider } from '../core/chat/provider';
import type { RunRecord } from '../kernel/run';
import type { ProviderDef } from '../kernel/types';
import { Store } from '../server/db';
import { ExperienceService } from '../server/experience';

/**
 * Experience review v2 real-model acceptance.
 *
 * Differences from `experience-live.ts`:
 *  - fixtures carry realistic tool calls, failures and recovery facts;
 *  - the reviewer route is explicit (EVAL_REVIEWER_MODEL), never the task model;
 *  - scoring uses verdict agreement + evidence validity + suggestion usefulness,
 *    not keyword regexes on summary text.
 *
 * Env: EVAL_BASE_URL, EVAL_API_KEY, EVAL_REVIEWER_MODEL, optionally
 *      EVAL_TASK_MODEL (defaults to reviewer), EVAL_REASONING=1,
 *      EVAL_REPORT_DIR, EVAL_CASES, EVAL_REQUEST_TIMEOUT_MS.
 */
const baseUrl = process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
const reviewerModel = process.env.EVAL_REVIEWER_MODEL;
const taskModel = process.env.EVAL_TASK_MODEL ?? reviewerModel;
if (!baseUrl || !apiKey || !reviewerModel) {
  console.log('[eval:experience-v2] 需要 EVAL_BASE_URL、EVAL_API_KEY、EVAL_REVIEWER_MODEL；未发送模型请求。');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(process.env.EVAL_REPORT_DIR ?? join(root, 'evals', 'reports', 'experience-v2', new Date().toISOString().replace(/[:.]/g, '-')));
if (existsSync(join(reportDir, 'manifest.json'))) throw new Error('EVAL_REPORT_DIR must be new');
mkdirSync(reportDir, { recursive: true });

const timeoutMs = Number(process.env.EVAL_REQUEST_TIMEOUT_MS ?? 180_000);
const provider: ProviderDef = createProvider({
  id: 'experience-v2',
  baseUrl,
  apiKey,
  model: reviewerModel,
  protocol: process.env.EVAL_PROTOCOL ?? 'openai',
  inputPrice: 0,
  outputPrice: 0,
  requestTimeoutMs: timeoutMs,
  models: [{
    modelId: reviewerModel,
    contextWindow: 1_048_576,
    maxOutput: 1_048_576,
    vision: false,
    tools: true,
    reasoning: process.env.EVAL_REASONING === '1',
    priceIn: 0,
    priceOut: 0,
    enabled: true,
    source: 'manual',
  }],
});

interface CaseDefinition {
  id: string;
  name: string;
  expectedVerdict: 'positive' | 'neutral' | 'negative';
  expectSuggestion: boolean;
  setup(store: Store): RunRecord[];
}

function addRun(store: Store, input: {
  objective: string;
  status?: RunRecord['status'];
  answer?: string;
  verification?: unknown;
  toolCalls?: Array<{ name: string; args: string; ok: boolean; code?: string; sideEffect?: 'read' | 'write' }>;
  events?: Array<{ type: string; data: Record<string, unknown> }>;
  artifacts?: Array<{ ref: string; kind?: string }>;
}): RunRecord {
  const session = store.createSession(taskModel!, provider.id, 'default');
  const now = Date.now();
  const id = randomUUID();
  const record: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId: 'default', depth: 0,
    objective: input.objective, providerId: provider.id, model: taskModel!,
    status: 'running',
    authorization: { workspace: process.cwd(), profile: 'standard', revision: 0, readOnly: false },
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now - 1_000, updatedAt: now,
  };
  store.runs.create(record);
  const pendingArtifacts = [...(input.artifacts ?? [])];
  input.toolCalls?.forEach((call, index) => {
    const suffix = `call-${index}`;
    store.runs.startTool(id, suffix, call.name, call.args, { sideEffect: call.sideEffect ?? 'read' });
    const artifact = pendingArtifacts.shift();
    store.runs.finishTool(id, suffix, call.ok
      ? {
        ok: true,
        data: { done: true },
        ...(artifact ? {
          evidence: [{
            source: 'filesystem' as const,
            detail: `${artifact.ref} 已生成`,
            artifact: true,
            ref: artifact.ref,
            kind: artifact.kind ?? 'file',
            label: artifact.ref,
          }],
        } : {}),
      }
      : { ok: false, error: '工具执行失败', failure: { code: call.code ?? 'INVALID_ARGS', retryable: true, outcome: 'not_started' } });
  });
  for (const event of input.events ?? []) store.runs.append(id, event.type, event.data);
  store.runs.update(record, {
    status: input.status ?? 'completed',
    answer: input.answer ?? '已完成任务并说明来源。',
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  }, 'done', { status: input.status ?? 'completed' });
  return store.runs.get(id, 'default')!;
}

const passVerification = {
  status: 'passed', objective: '交付可核对结果',
  checks: [{ ok: true, reason: '产物与来源均可核对' }],
  evidence: [{ source: 'filesystem', detail: 'out.md 已生成', traceStepId: 'trace-1' }],
};
const failVerification = {
  status: 'failed', objective: '交付可核对结果',
  checks: [{ ok: false, reason: '验收未通过' }],
  evidence: [],
};

const cases: CaseDefinition[] = [
  {
    id: 'clean-success',
    name: '干净成功',
    expectedVerdict: 'positive',
    expectSuggestion: false,
    setup: store => [addRun(store, {
      objective: '读取配置并生成摘要',
      answer: '摘要已生成，来源为 config.json 第 1-20 行。',
      verification: passVerification,
      toolCalls: [
        { name: 'read_file', args: 'config.json', ok: true },
        { name: 'write_file', args: 'out.md', ok: true, sideEffect: 'write' },
      ],
      artifacts: [{ ref: 'out.md' }],
    })],
  },
  {
    id: 'retry-loop',
    name: '参数循环',
    expectedVerdict: 'neutral',
    expectSuggestion: true,
    setup: store => [addRun(store, {
      objective: '读取目标文件',
      answer: '多次尝试后仍未读取成功。',
      toolCalls: [
        { name: 'read_file', args: 'missing.txt', ok: false, code: 'INVALID_ARGS' },
        { name: 'read_file', args: 'missing.txt', ok: false, code: 'INVALID_ARGS' },
        { name: 'read_file', args: 'missing.txt', ok: false, code: 'INVALID_ARGS' },
      ],
    })],
  },
  {
    id: 'unusable-result',
    name: '结果不可用',
    expectedVerdict: 'negative',
    expectSuggestion: true,
    setup: store => [addRun(store, {
      objective: '生成并检查交付文件',
      answer: '文件已生成。',
      events: [{ type: 'artifact_invalid', data: { reason: '产物重新解析失败' } }],
      toolCalls: [{ name: 'write_file', args: 'report.docx', ok: true, sideEffect: 'write' }],
      artifacts: [{ ref: 'report.docx' }],
    })],
  },
  {
    id: 'context-loss',
    name: '上下文丢失',
    expectedVerdict: 'negative',
    expectSuggestion: true,
    setup: store => [addRun(store, {
      objective: '继续之前的检查',
      answer: '已继续。',
      events: [{ type: 'checkpoint_incomplete', data: { error: '恢复时缺少上下文边界' } }],
    })],
  },
  {
    id: 'false-success',
    name: '虚假成功',
    expectedVerdict: 'negative',
    expectSuggestion: true,
    setup: store => [addRun(store, {
      objective: '完成任务并保留结果',
      answer: '任务已完成。',
      verification: failVerification,
    })],
  },
  {
    id: 'recovered-failure',
    name: '失败后恢复',
    expectedVerdict: 'neutral',
    expectSuggestion: false,
    setup: store => [addRun(store, {
      objective: '遇到错误后继续完成任务',
      answer: '首次读取失败，重试后完成。',
      verification: passVerification,
      toolCalls: [
        { name: 'read_file', args: 'notes.md', ok: false, code: 'INVALID_ARGS' },
        { name: 'read_file', args: 'notes.md', ok: true },
      ],
      events: [{ type: 'tool_recovered', data: { name: 'read_file', outcome: 'not_started' } }],
    })],
  },
  {
    id: 'approval-friction',
    name: '无谓审批等待',
    expectedVerdict: 'neutral',
    expectSuggestion: true,
    setup: store => [addRun(store, {
      objective: '只读查看配置',
      answer: '等待审批后读取完成。',
      toolCalls: [{ name: 'read_file', args: 'config.json', ok: true }],
      events: [{ type: 'approval_required', data: { name: 'read_file', summary: '只读调用进入审批' } }],
    })],
  },
];

const selected = process.env.EVAL_CASES
  ? cases.filter(item => process.env.EVAL_CASES!.split(',').includes(item.id))
  : cases;

interface SampleResult {
  id: string;
  name: string;
  passed: boolean;
  expectedVerdict: string;
  verdict?: string;
  status?: string;
  evidenceValid: boolean;
  suggestionUseful: boolean;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  error?: string;
}

const results: SampleResult[] = [];
for (const item of selected) {
  const started = Date.now();
  const store = new Store(':memory:');
  try {
    const runs = item.setup(store);
    const service = new ExperienceService({
      store,
      providers: () => [provider],
      emit: () => undefined,
    });
    const review = service.create({
      runIds: runs.map(run => run.id),
      providerId: provider.id,
      model: reviewerModel!,
    }, 'default');
    const timeout = setTimeout(() => service.cancel(review.id, 'default'), timeoutMs + 5_000);
    try { await service.settled(review.id); } finally { clearTimeout(timeout); }
    const finished = service.review(review.id, 'default');
    const validRefs = new Set(finished.evidenceIndex.map(evidence => evidence.id));
    const evidenceValid = [...finished.dimensions, ...finished.observations, ...finished.suggestions]
      .flatMap(value => value.evidenceRefs)
      .every(ref => validRefs.has(ref));
    const suggestionUseful = finished.suggestions.length > 0
      && finished.suggestions.every(suggestion => suggestion.title.trim().length > 0 && suggestion.detail.trim().length >= 4);
    if (process.env.EVAL_DEBUG === '1') {
      console.log(JSON.stringify({
        id: item.id,
        suggestions: finished.suggestions.map(s => ({ title: s.title, detail: s.detail.slice(0, 60), refs: s.evidenceRefs.length })),
        observations: finished.observations.length,
      }));
    }
    const verdictMatches = finished.verdict === item.expectedVerdict;
    results.push({
      id: item.id,
      name: item.name,
      passed: finished.status === 'completed' && verdictMatches && evidenceValid
        && (item.expectSuggestion ? suggestionUseful : true),
      expectedVerdict: item.expectedVerdict,
      verdict: finished.verdict,
      status: finished.status,
      evidenceValid,
      suggestionUseful,
      calls: finished.calls,
      inputTokens: finished.budget.inputTokens,
      outputTokens: finished.budget.outputTokens,
      elapsedMs: Date.now() - started,
      ...(finished.error ? { error: finished.error } : {}),
    });
    console.log(`${results.at(-1)!.passed ? 'PASS' : 'FAIL'} ${item.id} verdict=${finished.verdict} status=${finished.status} evidence=${evidenceValid} suggestion=${suggestionUseful}`);
  } catch (error) {
    results.push({
      id: item.id,
      name: item.name,
      passed: false,
      expectedVerdict: item.expectedVerdict,
      evidenceValid: false,
      suggestionUseful: false,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? `${error.message}
${error.stack ?? ''}` : String(error),
    });
    console.log(`FAIL ${item.id} error=${error instanceof Error ? error.message : String(error)}`);
  } finally {
    store.close();
  }
}

const completed = results.filter(item => item.status === 'completed');
const evidenceValidRate = completed.length ? completed.filter(item => item.evidenceValid).length / completed.length : 0;
const verdictAgreement = results.filter(item => item.verdict === item.expectedVerdict).length / Math.max(1, results.length);
const suggestionRate = completed.length
  ? completed.filter(item => item.suggestionUseful).length / completed.length : 0;
const passRate = results.filter(item => item.passed).length / Math.max(1, results.length);

const report = {
  kind: 'ai-user-experience-v2',
  createdAt: new Date().toISOString(),
  reviewer: { providerId: provider.id, model: reviewerModel, reasoning: process.env.EVAL_REASONING === '1' },
  taskModel,
  samples: results,
  metrics: {
    passRate,
    verdictAgreement,
    evidenceValidRate,
    suggestionRate,
    formatValidRate: results.length ? completed.length / results.length : 0,
  },
  thresholds: { passRate: 0.8, verdictAgreement: 0.8, evidenceValidRate: 1, suggestionRate: 0.6 },
  passed: passRate >= 0.8 && verdictAgreement >= 0.8 && evidenceValidRate === 1 && suggestionRate >= 0.6,
};

mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, 'manifest.json'), JSON.stringify({
  kind: report.kind, createdAt: report.createdAt, reviewer: report.reviewer, taskModel,
  cases: selected.map(item => item.id),
}, null, 2));
writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`[eval:experience-v2] ${results.filter(item => item.passed).length}/${results.length} 通过 · 裁决一致=${(verdictAgreement * 100).toFixed(0)}% · 证据有效=${(evidenceValidRate * 100).toFixed(0)}% · 建议可用=${(suggestionRate * 100).toFixed(0)}% · report=${reportDir}`);
if (!report.passed) process.exitCode = 1;
