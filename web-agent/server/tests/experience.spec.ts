import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../db';
import { buildFactLedger, ExperienceError, ExperienceService } from '../experience';
import { setMaintenanceModelScope, type ModelCallRecord } from '../../kernel/model-call';
import type { RunRecord } from '../../kernel/run';
import type { ProviderDef } from '../../kernel/types';
import { estimateTokens } from '../../kernel/tokens';

const DIMENSIONS = [
  'capability_discovery', 'tool_contract_clarity', 'result_actionability', 'state_credibility',
  'error_recovery', 'execution_efficiency', 'context_continuity', 'authorization_control',
  'result_usability', 'reuse_intention',
];

function addRun(store: Store, input: {
  objective?: string;
  providerId?: string;
  model?: string;
  tenantId?: string;
  status?: RunRecord['status'];
  verification?: unknown;
  answer?: string;
  workspace?: string;
} = {}): RunRecord {
  const tenantId = input.tenantId ?? 'default';
  const providerId = input.providerId ?? 'fixture';
  const model = input.model ?? 'fixture-model';
  const session = store.createSession(model, providerId, tenantId);
  const now = Date.now();
  const id = randomUUID();
  const run: RunRecord = {
    id, rootId: id, sessionId: session.id, tenantId, depth: 0,
    objective: input.objective ?? '整理一份可检查的结果',
    providerId, model, status: 'running', authorization: { workspace: input.workspace ?? process.cwd(), profile: 'standard', revision: 0, readOnly: false },
    cost: 0, tokensIn: 0, tokensOut: 0, createdAt: now - 100, updatedAt: now,
  };
  store.runs.create(run);
  store.runs.update(run, {
    status: input.status ?? 'completed',
    answer: input.answer ?? '已经生成结果。',
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  }, 'done', { status: input.status ?? 'completed' });
  return store.runs.get(id, tenantId)!;
}

function finalOutput(refs: string[], score = 5): string {
  return JSON.stringify({
    scores: DIMENSIONS.map(id => ({ id, score, reason: '事实与证据支持该判断。', evidenceRefs: refs.slice(0, 1) })),
    observations: [{ kind: 'positive', summary: '任务结果可直接检查。', evidenceRefs: refs.slice(0, 1) }],
    suggestions: [{
      title: '保留当前结果反馈', detail: '继续在结果旁展示可核对来源。', category: 'result-feedback',
      impact: 'medium', confidence: 0.9, evidenceRefs: refs.slice(0, 1),
    }],
    reuseIntent: score,
    confidence: 0.9,
    evidenceGaps: [],
  });
}

function reviewProvider(options: { malformed?: boolean; hold?: boolean; score?: number; seen?: string[][] } = {}): ProviderDef & { calls: () => number } {
  let calls = 0;
  return {
    id: 'fixture', label: 'Fixture', defaultModel: 'fixture-model', priceSource: 'configured',
    models: [{
      modelId: 'fixture-model', contextWindow: 32_000, maxOutput: 4_096,
      vision: false, tools: false, reasoning: false, priceIn: 1, priceOut: 2,
      enabled: true, source: 'manual',
    }],
    calls: () => calls,
    async *chat(messages, chatOptions) {
      calls++;
      options.seen?.push(messages.map(message => message.content ?? ''));
      if (options.hold) {
        await new Promise<void>(resolve => {
          if (chatOptions.signal?.aborted) resolve();
          else chatOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      const payload = JSON.parse(String(messages.at(-1)?.content ?? '{}')) as {
        mode?: string;
        evidence?: Array<{ ref: string }>;
        evidenceIndex?: Array<{ id: string }>;
      };
      if (payload.mode === 'evidence_plan') {
        yield { type: 'delta', text: JSON.stringify({
          evidenceRefs: (payload.evidenceIndex ?? []).slice(0, 6).map(item => item.id),
          evidenceGaps: [],
          hypotheses: ['检查产物和验收事实'],
        }) };
      } else if (options.malformed) {
        yield { type: 'delta', text: 'not json' };
      } else {
        const refs = (payload.evidence ?? []).map(item => item.ref);
        yield { type: 'delta', text: finalOutput(refs.length ? refs : (payload.evidenceIndex ?? []).map(item => item.id), options.score ?? 5) };
      }
      yield { type: 'usage', input: 100, output: 50 };
      yield { type: 'done' };
    },
  };
}

function services(store: Store, provider: ProviderDef) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const experience = new ExperienceService({
    store, providers: () => [provider],
    emit: (type, data) => events.push({ type, data }),
  });
  return { experience, events };
}

describe('AI 用户复盘', () => {
  test('schema 9 升级到 10 并建立体验表', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-experience-migration-'));
    const file = join(root, 'review.db');
    try {
      const initial = new Store(file);
      initial.close();
      const raw = new Database(file);
      raw.exec(`
        DROP TABLE experience_reviews_v1;
        DROP TABLE experience_findings_v1;
        DROP TABLE experience_audits_v1;
        DROP TABLE experience_regressions_v1;
        PRAGMA user_version=9;
      `);
      raw.close();
      const migrated = new Store(file);
      try {
        assert.equal(migrated.schemaVersion, 10);
        assert.deepEqual(migrated.experience.listReviews('default'), []);
      } finally { migrated.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('事实账本压缩长结果、聚合同类异常并拦截虚假成功与未知副作用', () => {
    const store = new Store(':memory:');
    try {
      const run = addRun(store, {
        verification: { status: 'partial', objective: 'x', checks: [{ ok: false, reason: '未通过' }], evidence: [] },
      });
      store.runs.startTool(run.id, 'a', 'read_file', 'same.txt', { sideEffect: 'read' });
      store.runs.finishTool(run.id, 'a', { ok: true, data: { text: 'x'.repeat(20_000) } });
      store.runs.startTool(run.id, 'b', 'read_file', 'same.txt', { sideEffect: 'read' });
      store.runs.finishTool(run.id, 'b', { ok: true, data: { text: 'x'.repeat(20_000) } });
      store.runs.startTool(run.id, 'c', 'write_file', 'out.txt', { sideEffect: 'write' });
      store.runs.finishTool(run.id, 'c', {
        ok: false, error: 'unknown',
        failure: { code: 'WRITE_INTERRUPTED', retryable: false, outcome: 'unknown' },
      });
      const facts = buildFactLedger(store, 'default', [run]);
      assert.equal(facts.gates.noFalseSuccess, false);
      assert.equal(facts.gates.noUnknownSideEffects, false);
      assert.equal(facts.totals.duplicateTools, 1);
      assert.equal(facts.anomalies.some(item => item.code === 'FALSE_SUCCESS' && item.severity === 'P0'), true);
      assert.equal(facts.anomalies.some(item => item.code === 'UNKNOWN_SIDE_EFFECT' && item.severity === 'P0'), true);
      assert.ok(estimateTokens(JSON.stringify(facts)) <= 1_200);
      assert.doesNotMatch(JSON.stringify(facts), /x{1000}/);
    } finally { store.close(); }
  });

  test('正常任务走快速路径、只发送选定证据并落在总 token 上限内', async () => {
    const store = new Store(':memory:');
    const seen: string[][] = [];
    const provider = reviewProvider({ seen });
    const { experience } = services(store, provider);
    try {
      const run = addRun(store, {
        verification: { status: 'passed', objective: '完成', checks: [{ ok: true, reason: '证据存在' }], evidence: [] },
      });
      store.runs.startTool(run.id, 'long', 'read_file', 'long.txt', { sideEffect: 'read' });
      store.runs.finishTool(run.id, 'long', { ok: true, data: { text: 'FULL_TRACE_MARKER'.repeat(2_000) } });
      const review = experience.create({ runIds: [run.id], requestKey: 'normal' }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'completed', JSON.stringify({ error: finished.error, evidenceGaps: finished.evidenceGaps, evidence: finished.evidence.length, tokenUse: finished.budget.inputTokens + finished.budget.outputTokens }));
      assert.equal(finished.path, 'fast');
      assert.equal(finished.verdict, 'positive');
      assert.equal(finished.calls, 1);
      assert.ok(finished.budget.inputTokens + finished.budget.outputTokens <= 3_800);
      assert.ok(finished.evidence.length <= 4);
      assert.equal(provider.calls(), 1);
      assert.doesNotMatch(JSON.stringify(seen), /FULL_TRACE_MARKER{20}/);
      assert.equal(finished.dimensions.every(item => item.evidenceRefs.length === 1), true);
    } finally { store.close(); }
  });

  test('异常与多运行复盘使用预设聚焦预算并限制同类模型选择', () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const failed = addRun(store, {
        verification: { status: 'failed', objective: '失败', checks: [{ ok: false, reason: '错误' }], evidence: [] },
      });
      const focused = experience.estimate({ runIds: [failed.id] }, 'default');
      assert.equal(focused.path, 'focused');
      assert.equal(focused.inputTokenLimit, 8_000);
      assert.equal(focused.outputTokenLimit, 1_200);
      assert.equal(focused.totalTokenLimit, 9_200);

      const first = addRun(store);
      const second = addRun(store);
      const multi = experience.estimate({ runIds: [first.id, second.id] }, 'default');
      assert.equal(multi.path, 'focused');
      assert.equal(multi.inputTokenLimit, 10_000);
      assert.equal(multi.outputTokenLimit, 1_500);
      assert.equal(multi.totalTokenLimit, 11_500);
      assert.throws(
        () => experience.estimate({ runIds: [first.id, addRun(store, { model: 'another-model' }).id] }, 'default'),
        (error: unknown) => error instanceof ExperienceError && error.code === 'MIXED_MODELS',
      );
      assert.throws(
        () => experience.estimate({ runIds: [first.id, addRun(store, { workspace: `${process.cwd()}-other` }).id] }, 'default'),
        (error: unknown) => error instanceof ExperienceError && error.code === 'MIXED_WORKSPACES',
      );
    } finally { store.close(); }
  });

  test('多运行事实按代表性摩擦聚类且始终不超过事实账本上限', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const runs = Array.from({ length: 10 }, (_, index) => {
        const run = addRun(store, { objective: `长任务-${index}-` + '目标说明'.repeat(1_000) });
        store.runs.startTool(run.id, `bad-${index}`, 'read_file', `missing-${index}.txt`, { sideEffect: 'read' });
        store.runs.finishTool(run.id, `bad-${index}`, {
          ok: false,
          error: `错误 ${index}`,
          failure: { code: `E${String(index).padStart(2, '0')}`, retryable: true, outcome: 'not_started' },
        });
        return run;
      });
      const review = experience.create({ runIds: runs.map(run => run.id) }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'completed', JSON.stringify({ error: finished.error, evidenceGaps: finished.evidenceGaps, evidence: finished.evidence.length, tokenUse: finished.budget.inputTokens + finished.budget.outputTokens }));
      assert.equal(finished.path, 'focused');
      assert.equal(finished.facts.truncated, true);
      assert.ok(finished.facts.anomalies.length <= 5);
      assert.ok(estimateTokens(JSON.stringify(finished.facts)) <= 1_200);
      assert.ok(finished.budget.inputTokens + finished.budget.outputTokens <= 11_500);
    } finally { store.close(); }
  });

  test('上下文中断、无谓审批等待、失败恢复与跨运行重复摩擦进入事实轨道', () => {
    const store = new Store(':memory:');
    try {
      const first = addRun(store, { objective: '读取配置文件' });
      store.runs.startTool(first.id, 'bad-1', 'read_file', 'missing.txt', { sideEffect: 'read' });
      store.runs.finishTool(first.id, 'bad-1', {
        ok: false, error: '参数不完整',
        failure: { code: 'INVALID_ARGS', retryable: true, outcome: 'not_started' },
      });
      store.runs.append(first.id, 'checkpoint_incomplete', { error: '恢复时缺少上下文边界' });

      const second = addRun(store, { objective: '再次读取配置文件' });
      store.runs.append(second.id, 'approval_required', { name: 'read_file', summary: '只读调用也进入审批' });
      store.runs.startTool(second.id, 'bad-2', 'read_file', 'missing.txt', { sideEffect: 'read' });
      store.runs.finishTool(second.id, 'bad-2', {
        ok: false, error: '参数不完整',
        failure: { code: 'INVALID_ARGS', retryable: true, outcome: 'not_started' },
      });
      store.runs.append(second.id, 'tool_recovered', { name: 'read_file', outcome: 'not_started' });

      const facts = buildFactLedger(store, 'default', [first, second]);
      assert.equal(facts.totals.approvalWaits, 1);
      assert.equal(facts.totals.recoveries, 1);
      assert.equal(facts.anomalies.some(item => item.code === 'CONTEXT_LOSS' && item.severity === 'P1'), true);
      const repeated = facts.anomalies.find(item => item.code === 'INVALID_TOOL_CONTRACT');
      assert.equal(repeated?.occurrences, 2);
      assert.equal(repeated?.evidenceRefs.length, 2);
    } finally { store.close(); }
  });

  test('聚焦路径实际执行证据规划和结论两步模型调用', async () => {
    const store = new Store(':memory:');
    const seen: string[][] = [];
    const provider = reviewProvider({ seen });
    const { experience } = services(store, provider);
    try {
      const run = addRun(store, {
        verification: { status: 'failed', objective: '失败', checks: [{ ok: false, reason: '未产出' }], evidence: [] },
      });
      store.runs.append(run.id, 'tool_recovered', { name: 'read_file', outcome: 'not_started' });
      const review = experience.create({ runIds: [run.id], requestKey: 'focused-series' }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'completed');
      assert.equal(finished.path, 'focused');
      assert.equal(finished.calls, 2);
      assert.equal(provider.calls(), 2);
      assert.ok(finished.budget.inputTokens + finished.budget.outputTokens <= 9_200);
      assert.match(seen[0]!.join('\n'), /evidence_plan/);
      assert.match(seen[1]!.join('\n'), /review_input/);
      assert.equal(finished.dimensions.every(item => item.evidenceRefs.length > 0), true);
    } finally { store.close(); }
  });

  test('P0 事实不能被模型的满分评价抵消', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider({ score: 5 });
    const { experience } = services(store, provider);
    try {
      const run = addRun(store, {
        verification: { status: 'failed', objective: '失败', checks: [{ ok: false, reason: '没有结果' }], evidence: [] },
      });
      const review = experience.create({ runIds: [run.id] }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'completed');
      assert.equal(finished.dimensions.every(item => item.score === 5), true);
      assert.equal(finished.verdict, 'negative');
      assert.equal(finished.facts.anomalies.some(item => item.severity === 'P0'), true);
    } finally { store.close(); }
  });

  test('幂等、租户隔离和原模型不可用均按显式边界处理', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const run = addRun(store);
      const first = experience.create({ runIds: [run.id], requestKey: 'same' }, 'default');
      const second = experience.create({ runIds: [run.id], requestKey: 'same' }, 'default');
      assert.equal(second.id, first.id);
      await experience.settled(first.id)!;
      assert.throws(
        () => experience.review(first.id, 'tenant-b'),
        (error: unknown) => error instanceof ExperienceError && error.code === 'REVIEW_NOT_FOUND',
      );
      const unavailableStore = new Store(':memory:');
      try {
        const unavailableRun = addRun(unavailableStore);
        const offline = new ExperienceService({ store: unavailableStore, providers: () => [], emit: () => undefined });
        const estimate = offline.estimate({ runIds: [unavailableRun.id] }, 'default');
        assert.equal(estimate.available, false);
        assert.equal(estimate.requiresExplicitModel, true);
        assert.throws(
          () => offline.create({ runIds: [unavailableRun.id] }, 'default'),
          (error: unknown) => error instanceof ExperienceError && error.code === 'ORIGINAL_MODEL_UNAVAILABLE',
        );
      } finally { unavailableStore.close(); }
    } finally { store.close(); }
  });

  test('取消会中断模型调用且不留成功状态', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider({ hold: true });
    const { experience } = services(store, provider);
    try {
      const run = addRun(store);
      const review = experience.create({ runIds: [run.id] }, 'default');
      while (experience.review(review.id, 'default').status !== 'running') {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      experience.cancel(review.id, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'cancelled');
      assert.equal(finished.completedAt, undefined);
    } finally { store.close(); }
  });

  test('模型输出不合格时直接失败，不自动重试消耗 token', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider({ malformed: true });
    const { experience } = services(store, provider);
    try {
      const run = addRun(store);
      const review = experience.create({ runIds: [run.id] }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      assert.equal(finished.status, 'failed');
      assert.match(finished.error ?? '', /JSON/);
      assert.equal(provider.calls(), 1);
      assert.equal(finished.calls, 1);
    } finally { store.close(); }
  });

  test('复盘调用进入 maintenance 模型账本并保留 usage 与 purpose', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    const controller = new AbortController();
    const cleanup = setMaintenanceModelScope({
      runId: '',
      signal: controller.signal,
      acquire: async () => () => undefined,
      start: (record: ModelCallRecord) => store.runs.startModelCall(record),
      finish: (record: ModelCallRecord) => { store.runs.finishModelCall(record); },
    });
    try {
      const run = addRun(store);
      const review = experience.create({ runIds: [run.id] }, 'default');
      await experience.settled(review.id)!;
      const calls = store.runs.modelCalls('');
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.purpose, 'experience_review');
      assert.equal(calls[0]!.status, 'completed');
      assert.equal(calls[0]!.input, 100);
      assert.equal(calls[0]!.output, 50);
    } finally {
      cleanup();
      store.close();
    }
  });

  test('同一建议跨复盘累计来源与出现次数，并可由人类提交已验证模式', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const firstRun = addRun(store);
      const firstReview = experience.create({ runIds: [firstRun.id] }, 'default');
      await experience.settled(firstReview.id)!;
      const first = experience.review(firstReview.id, 'default');
      const finding = experience.adoptSuggestion(first.id, first.suggestions[0]!.id, 'default');

      const secondRun = addRun(store);
      const secondReview = experience.create({ runIds: [secondRun.id] }, 'default');
      await experience.settled(secondReview.id)!;
      const second = experience.review(secondReview.id, 'default');
      const repeated = experience.adoptSuggestion(second.id, second.suggestions[0]!.id, 'default');
      assert.equal(repeated.id, finding.id);
      assert.equal(repeated.occurrences, 2);
      assert.deepEqual(new Set(repeated.reviewIds), new Set([firstReview.id, secondReview.id]));
      assert.deepEqual(new Set(repeated.sourceRunIds), new Set([firstRun.id, secondRun.id]));
      assert.equal(experience.findings('default').length, 1);

      let submitted: { name: string; findingId: string } | undefined;
      const evolved = experience.evolveFinding(finding.id, 'default', input => {
        submitted = input;
        return { id: 'proposal123' };
      });
      assert.equal(submitted?.findingId, finding.id);
      assert.match(submitted?.name ?? '', /^experience-/);
      assert.equal(evolved.evolutionProposalId, 'proposal123');
    } finally { store.close(); }
  });

  test('历史体验问题缺少复盘列表时仍可提交已验证模式', () => {
    const store = new Store(':memory:');
    try {
      const finding = {
        id: 'legacy-finding', tenantId: 'default', reviewId: 'legacy-review',
        suggestionId: 'legacy-suggestion', fingerprint: 'legacy-fingerprint',
        title: '历史问题', detail: '旧记录只保存原始复盘引用', category: 'result-feedback',
        severity: 'P2', status: 'closed', evidenceRefs: [], sourceRunIds: [],
        occurrences: 2, createdAt: 1, updatedAt: 1,
      } as Parameters<typeof store.experience.putFinding>[0];
      store.experience.putFinding(finding);
      const { experience } = services(store, reviewProvider());
      let submitted = false;
      const evolved = experience.evolveFinding(finding.id, 'default', () => {
        submitted = true;
        return { id: 'legacy-proposal' };
      });
      assert.equal(submitted, true);
      assert.equal(evolved.evolutionProposalId, 'legacy-proposal');
    } finally { store.close(); }
  });

  test('回归通过必须绑定真实验证运行，失败会重开问题', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const source = addRun(store);
      const review = experience.create({ runIds: [source.id] }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      const finding = experience.adoptSuggestion(review.id, finished.suggestions[0]!.id, 'default');
      experience.updateFinding(finding.id, 'default', 'triaged');
      experience.reproduceFinding(finding.id, 'default');
      experience.updateFinding(finding.id, 'default', 'fixing');
      experience.updateFinding(finding.id, 'default', 'verifying');

      const failedRun = addRun(store, {
        verification: { status: 'failed', objective: '验证', checks: [{ ok: false, reason: '问题仍存在' }], evidence: [] },
      });
      assert.throws(
        () => experience.recordRegressionResult(finding.id, 'default', {
          outcome: 'passed', runId: failedRun.id, summary: '人工判断通过',
        }),
        (error: unknown) => error instanceof ExperienceError && error.code === 'REGRESSION_PASS_CONFLICTS_WITH_VERIFICATION',
      );

      const verificationRun = addRun(store, {
        verification: { status: 'passed', objective: '验证', checks: [{ ok: true, reason: '问题消失' }], evidence: [] },
      });
      const result = experience.recordRegressionResult(finding.id, 'default', {
        outcome: 'passed', runId: verificationRun.id, summary: '隔离重放通过，问题未再出现',
      });
      assert.equal(result.regression.status, 'passed');
      assert.equal(result.regression.verificationRunId, verificationRun.id);
      assert.equal(result.finding.status, 'closed');
      assert.equal(result.finding.sourceRunIds.includes(verificationRun.id), true);
      assert.equal(result.regression.evidenceRefs.some(ref => ref.startsWith(`run:${verificationRun.id}:`)), true);

      experience.updateFinding(finding.id, 'default', 'reopened');
      experience.updateFinding(finding.id, 'default', 'triaged');
      experience.updateFinding(finding.id, 'default', 'reproduced');
      experience.updateFinding(finding.id, 'default', 'fixing');
      experience.updateFinding(finding.id, 'default', 'verifying');
      const failed = experience.recordRegressionResult(finding.id, 'default', {
        outcome: 'failed', runId: failedRun.id, summary: '隔离重放仍复现原问题',
      });
      assert.equal(failed.regression.status, 'failed');
      assert.equal(failed.finding.status, 'reopened');
    } finally { store.close(); }
  });

  test('建议采纳去重、回归案例和人工校准保留原始 AI 评分', async () => {
    const store = new Store(':memory:');
    const provider = reviewProvider();
    const { experience } = services(store, provider);
    try {
      const run = addRun(store);
      const review = experience.create({ runIds: [run.id] }, 'default');
      await experience.settled(review.id)!;
      const finished = experience.review(review.id, 'default');
      const suggestion = finished.suggestions[0]!;
      const finding = experience.adoptSuggestion(review.id, suggestion.id, 'default');
      assert.equal(finding.status, 'new');
      assert.equal(experience.adoptSuggestion(review.id, suggestion.id, 'default').id, finding.id);
      assert.equal(experience.findings('default').length, 1);
      experience.updateFinding(finding.id, 'default', 'triaged');
      const reproduced = experience.reproduceFinding(finding.id, 'default', '再次执行后保持来源可见');
      assert.equal(reproduced.finding.status, 'reproduced');
      assert.equal(reproduced.regression.status, 'ready');
      const before = JSON.stringify(experience.review(review.id, 'default').dimensions);
      experience.updateFinding(finding.id, 'default', 'fixing');
      experience.updateFinding(finding.id, 'default', 'verifying');
      assert.throws(
        () => experience.updateFinding(finding.id, 'default', 'closed'),
        (error: unknown) => error instanceof ExperienceError && error.code === 'FINDING_CLOSURE_EVIDENCE_REQUIRED',
      );
      const closed = experience.updateFinding(
        finding.id,
        'default',
        'closed',
        '人工例外：当前问题已由人工确认关闭。',
      );
      assert.equal(closed.status, 'closed');
      const calibration = experience.calibrate(review.id, 'default', {
        verdict: 'disagree', summary: '人工验收发现输出内容需进一步确认', dimensions: finished.dimensions,
      });
      assert.equal(calibration.source, 'human');
      assert.equal(JSON.stringify(experience.review(review.id, 'default').dimensions), before);
      assert.equal(experience.audits(review.id, 'default').filter(item => item.source === 'human').length, 1);
    } finally { store.close(); }
  });
});
