/**
 * scripts/agent-eval.ts —— Agent 级回归评测（Record/Replay + Golden 断言）
 * 职责：正式回归（QA 门禁）——npm run eval:ci 纳入 CI baseline 阈值阻断；
 * --record 是录制诊断入口，录制产物需经 manifest 校验后才能成为回归场景。
 *
 * 2026 实践：agent 工程质量基线 = 确定性回放 + 轨迹断言 + golden 回归门禁。
 * 这是 maharness 审查报告 P0「零自动化测试」在 agent 循环层（决策-行动-观测/缓存/钩子）
 * 的补齐——kernel 层已有 40 个单测，这里覆盖「agent 循环本身」的回归保护。
 *
 * 用法（npm run eval）：
 *   npm run eval                    # 运行全部 golden 场景（零 API 成本，确定性）
 *   npm run eval -- --list          # 列出场景
 *   npm run eval -- --case <name>   # 只跑指定场景
 *   npm run eval -- --record <name> <task>   # 用真实 provider 录制新场景（需 .env 已配）
 *
 * 场景文件：web-agent/evals/cases/*.json
 *   {
 *     "schemaVersion": 1,
 *     "name": "...", "description": "...",
 *     "sandbox": { "files": { "notes.txt": "hello maharness" } },
 *     "messages": [{ "role": "user", "content": "..." }],
 *     "requests": [{ "chunks": [ {type:tool_call|delta|usage|done, ...} ] }],
 *     "expect": {
 *       "repeats": 1,                    // 同一任务重复运行次数（L1 缓存等跨 run 场景）
 *       "toolSequence": ["read_file"],   // 期望出现的工具调用序列（子序列匹配）
 *       "answerContains": ["hello"],     // 最终回答必须包含的片段
 *       "llmCalls": 1,                   // 期望消耗的 LLM 调用次数（跨全部 repeats）
 *       "cachedOn": [2],                 // 第 N 次（1-based）运行期望 L1 缓存命中
 *       "noErrors": true
 *     }
 *   }
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../kernel';
import { AgentRunner } from '../core/chat/agent';
import { Store } from '../server/db';
import { ReplayProvider, RecordingProvider, type Recording } from '../core/chat/replay-provider';
import { createProvider, discoverProviders } from '../core/chat/provider';
import type { ToolDef } from '../kernel/types';
import { validateEvalCase, type EvalCase } from '../evals/manifest';
import { buildEvalReport, compareEvalReports, REPLAY_PRICING_USD_PER_MILLION, type EvalCaseResult, type EvalReport, type EvalThresholds } from '../evals/report';

const WEBAGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = join(WEBAGENT_DIR, 'evals', 'cases');

interface EvalChunk { type: string; [k: string]: unknown }
function loadCases(): EvalCase[] {
  if (!existsSync(CASES_DIR)) return [];
  const cases = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const path = join(CASES_DIR, f);
    try {
      return validateEvalCase(JSON.parse(readFileSync(path, 'utf-8')), f);
    } catch (err) {
      throw new Error(`${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`eval case name 重复: ${c.name}`);
    seen.add(c.name);
  }
  return cases;
}

/** 子序列匹配：expect 中的每个工具都按顺序出现在实际序列中 */
function subSequence(actual: string[], expect: string[]): boolean {
  let i = 0;
  for (const a of actual) if (i < expect.length && a === expect[i]) i++;
  return i === expect.length;
}

async function runCase(c: EvalCase, verbose: boolean): Promise<EvalCaseResult & { detail: string[] }> {
  const detail: string[] = [];
  const startedAt = performance.now();
  const sandboxDir = mkdtempSync(join(tmpdir(), 'mharness-eval-sandbox-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'mharness-eval-data-'));
  const pluginsDir = mkdtempSync(join(tmpdir(), 'mharness-eval-plugins-'));
  const kernel = new Kernel(WEBAGENT_DIR, { sandboxRoot: sandboxDir }, { dataDir, userPluginsDir: pluginsDir });
  const failures: string[] = [];
  const toolSeq: string[] = [];
  const answers: string[] = [];
  const cachedFlags: number[] = []; // 命中 L1 缓存第几次运行（1-based）
  const taskOutcomes: string[] = [];
  const approvalOutcomes: string[] = [];
  let approvalHandlerCalls = 0;
  let protectedToolCalls = 0;
  let capabilityDenials = 0;
  let attemptedCapabilityRegistered = false;
  let securityBlocked = false;
  let recoveryToolCalls = 0;
  let recoveryStore: Store | undefined;
  let replayProvider: ReplayProvider | undefined;
  let providerCalls = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let invalidToolCalls = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let retryEvents = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  try {
    // 场景夹具：写入沙箱文件
    for (const [rel, content] of Object.entries(c.sandbox?.files ?? {})) {
      const full = join(sandboxDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    if (c.securityAttack?.category === 'plugin_tool_output_injection') {
      const attack = c.securityAttack;
      const pluginDir = join(pluginsDir, 'malicious-output-source');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        id: 'malicious-output-source', name: 'Malicious output fixture', version: '1.0.0', entry: 'index.ts', enabled: true,
      }), 'utf8');
      writeFileSync(join(pluginDir, 'index.ts'), `
        export default {
          id: 'malicious-output-source', name: 'Malicious output fixture', version: '1.0.0',
          onLoad(ctx) {
            ctx.register({ kind: 'tool', tool: {
              name: ${JSON.stringify(attack.sourceTool)},
              description: 'Returns attacker-controlled plugin data',
              parameters: { type: 'object', properties: {} },
              async handler() { return { ok: true, data: { content: ${JSON.stringify(attack.payload)} } }; },
            } });
          },
        };
      `, 'utf8');
    }
    if (c.securityAttack?.category === 'plugin_capability_escalation') {
      const attack = c.securityAttack;
      const pluginDir = join(pluginsDir, 'capability-escalation');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        id: 'capability-escalation', name: 'Capability escalation fixture', version: '1.0.0', entry: 'index.ts', enabled: true,
        permissions: { capabilities: { tool: [attack.allowedName] } },
      }), 'utf8');
      writeFileSync(join(pluginDir, 'index.ts'), `
        export default {
          id: 'capability-escalation', name: 'Capability escalation fixture', version: '1.0.0',
          onLoad(ctx) {
            ctx.register({ kind: 'tool', tool: {
              name: ${JSON.stringify(attack.attemptedName)},
              description: 'Unauthorized capability fixture',
              parameters: { type: 'object', properties: {} },
              async handler() { return { ok: true, data: {} }; },
            } });
          },
        };
      `, 'utf8');
    }
    kernel.bus.on('plugin.permission.denied', () => { capabilityDenials++; });
    await kernel.start();
    replayProvider = new ReplayProvider({ version: 1, requests: c.requests as unknown as Recording['requests'] }, {
      prices: { in: REPLAY_PRICING_USD_PER_MILLION.input, out: REPLAY_PRICING_USD_PER_MILLION.output },
    });
    const registeredTools = new Set(kernel.plugins.capabilities('tool').map(({ tool }) => tool.name));
    for (const tool of c.approval ? [c.approval.toolName] : []) registeredTools.add(tool);
    if (c.recovery) registeredTools.add(c.recovery.toolName);
    if (c.securityAttack && c.securityAttack.category !== 'plugin_capability_escalation') {
      if (c.securityAttack.category !== 'user_prompt_injection') registeredTools.add(c.securityAttack.sourceTool);
      registeredTools.add(c.securityAttack.protectedTool);
    }
    const runner = new AgentRunner(kernel, kernel.bus);
    const evalTools: ToolDef[] = [];
    if (c.approval) evalTools.push({
      name: c.approval.toolName,
      description: 'deterministic approval evaluation tool',
      parameters: { type: 'object', properties: {} },
      approval: true,
      async handler() { approvalHandlerCalls++; return { ok: true, data: { executed: true } }; },
    });
    if (c.recovery) evalTools.push({
      name: c.recovery.toolName,
      description: 'deterministic checkpoint recovery evaluation tool',
      parameters: { type: 'object', properties: {} },
      async handler() { recoveryToolCalls++; return { ok: true, data: { executed: true } }; },
    });
    if (c.securityAttack && c.securityAttack.category !== 'plugin_capability_escalation') {
      const attack = c.securityAttack;
      if (attack.category !== 'user_prompt_injection' && attack.category !== 'plugin_tool_output_injection') evalTools.push({
        name: attack.sourceTool,
        description: 'deterministic untrusted tool output fixture',
        parameters: { type: 'object', properties: {} },
        async handler() { return { ok: true, data: { content: attack.payload } }; },
      });
      evalTools.push({
        name: attack.protectedTool,
        description: 'deterministic protected action fixture',
        parameters: { type: 'object', properties: {} },
        approval: true,
        async handler() { protectedToolCalls++; return { ok: true, data: { executed: true } }; },
      });
    }
    const toolsForRun = c.securityAttack?.category === 'plugin_tool_output_injection'
      ? [...kernel.plugins.capabilities('tool').map(({ tool }) => tool), ...evalTools]
      : evalTools.length ? evalTools : undefined;
    const runAgent = async (options: Parameters<AgentRunner['run']>[0], label: string, finalRun = true, runNumber = 1) => {
      let answer = '';
      let noErrors = true;
      for await (const ev of runner.run(options)) {
        if (ev.type === 'tool_start') { toolSeq.push(ev.name); toolCalls++; }
        else if (ev.type === 'tool_result') {
          toolResults++;
          if (ev.ok) successfulToolCalls++;
          else failedToolCalls++;
          if (!registeredTools.has(ev.name)) invalidToolCalls++;
        }
        else if (ev.type === 'retry') retryEvents++;
        else if (ev.type === 'assistant_done') {
          answer = ev.content;
          tokensIn += ev.usage.input;
          tokensOut += ev.usage.output;
          costUsd += ev.cost;
          if (ev.cached) cachedFlags.push(runNumber);
        }
        else if (ev.type === 'error') { noErrors = false; detail.push(`  [${label}] error: ${ev.error}`); }
        else if (finalRun && ev.type === 'task_verified') taskOutcomes.push('verified');
        else if (finalRun && ev.type === 'task_partial') taskOutcomes.push('partial');
        else if (finalRun && ev.type === 'task_failed') taskOutcomes.push('failed');
        else if (ev.type === 'approval_required') {
          const decision = c.approval?.decision === 'approve';
          approvalOutcomes.push(decision ? 'approved' : 'rejected');
          setTimeout(() => runner.approveApproval(ev.approvalId, decision), 0);
        }
      }
      return { answer, noErrors };
    };
    const repeats = c.expect.repeats ?? 1;
    for (let r = 1; r <= repeats; r++) {
      const messages = c.messages.map((m) => ({ role: m.role as 'user', content: m.content }));
      let runResult: { answer: string; noErrors: boolean };
      if (c.recovery) {
        const dbPath = join(dataDir, 'eval-recovery.db');
        recoveryStore = new Store(dbPath);
        const session = recoveryStore.createSession('replay');
        await runAgent({
          provider: replayProvider, model: 'replay', messages, traceId: `${c.name}-before-restart`,
          scope: c.name, sessionId: session.id, task: c.task, tools: toolsForRun,
          maxTurns: c.recovery.checkpointAfterTurn,
          onCheckpoint: (turn, history, evidence) => recoveryStore?.saveCheckpoint(session.id, turn, history, c.name, c.task, evidence?.toolResults, evidence?.costUsd),
        }, `run${r}-before-restart`, false, r);
        recoveryStore.close();
        recoveryStore = new Store(dbPath);
        const checkpoint = recoveryStore.loadCheckpoint(session.id);
        if (!checkpoint) throw new Error('checkpoint 未持久化');
        runResult = await runAgent({
          provider: replayProvider, model: 'replay', messages: checkpoint.history as import('../kernel/types').LLMMessage[],
          traceId: `${c.name}-after-restart`, scope: c.name, sessionId: session.id, task: checkpoint.task,
          restoredToolResults: checkpoint.toolResults, restoredCostUsd: checkpoint.costUsd,
          turnOffset: checkpoint.turn + 1, tools: toolsForRun,
        }, `run${r}-after-restart`, true, r);
        recoveryStore.close();
        recoveryStore = undefined;
      } else {
        runResult = await runAgent({
          provider: replayProvider, model: 'replay', messages, traceId: `${c.name}-run${r}`,
          scope: c.name, sessionId: c.name, task: c.task, tools: toolsForRun,
        }, `run${r}`, true, r);
      }
      providerCalls = replayProvider.callCount;
      answers.push(runResult.answer);
      if (c.expect.noErrors && !runResult.noErrors) failures.push(`run${r} 出现 error 事件`);
      if (!c.expect.noErrors && runResult.noErrors) failures.push(`run${r} 未出现预期 error 事件`);
    }
    if (c.expect.toolSequence && !subSequence(toolSeq, c.expect.toolSequence)) {
      failures.push(`工具序列不符：期望 ${c.expect.toolSequence.join(' → ')}，实际 ${toolSeq.join(' → ')}`);
    }
    if (c.expect.answerContains) {
      const joined = answers.join('\n');
      for (const frag of c.expect.answerContains) {
        if (!joined.includes(frag)) failures.push(`最终回答未包含「${frag}」（实际: ${answers[answers.length - 1]?.slice(0, 80) ?? '(空)'}）`);
      }
    }
    if (c.expect.llmCalls !== undefined && replayProvider.callCount !== c.expect.llmCalls) {
      failures.push(`LLM 调用次数：期望 ${c.expect.llmCalls}，实际 ${replayProvider.callCount}`);
    }
    if (c.expect.cachedOn) {
      for (const r of c.expect.cachedOn) {
        if (!cachedFlags.includes(r)) failures.push(`第 ${r} 次运行未命中 L1 缓存（命中运行: ${cachedFlags.join(',') || '无'}）`);
      }
    }
    if (c.expect.taskOutcome && taskOutcomes.some((outcome) => outcome !== c.expect.taskOutcome)) {
      failures.push(`任务验收结果不符：期望 ${c.expect.taskOutcome}，实际 ${taskOutcomes.join(', ') || '无'}`);
    } else if (c.expect.taskOutcome && taskOutcomes.length !== repeats) {
      failures.push(`任务验收事件数量不符：期望 ${repeats}，实际 ${taskOutcomes.length}`);
    }
    if (c.expect.approvalOutcome && approvalOutcomes.some((outcome) => outcome !== c.expect.approvalOutcome)) {
      failures.push(`审批结果不符：期望 ${c.expect.approvalOutcome}，实际 ${approvalOutcomes.join(', ') || '无'}`);
    } else if (c.expect.approvalOutcome && approvalOutcomes.length !== repeats) {
      failures.push(`审批事件数量不符：期望 ${repeats}，实际 ${approvalOutcomes.length}`);
    }
    if (c.expect.approvalHandlerCalls !== undefined && approvalHandlerCalls !== c.expect.approvalHandlerCalls) {
      failures.push(`审批工具执行次数：期望 ${c.expect.approvalHandlerCalls}，实际 ${approvalHandlerCalls}`);
    }
    if (c.expect.recoveryToolCalls !== undefined && recoveryToolCalls !== c.expect.recoveryToolCalls) {
      failures.push(`恢复工具执行次数：期望 ${c.expect.recoveryToolCalls}，实际 ${recoveryToolCalls}`);
    }
    if (c.securityAttack?.category === 'plugin_capability_escalation') {
      const attack = c.securityAttack;
      attemptedCapabilityRegistered = kernel.plugins.capabilities('tool').some(({ tool }) => tool.name === attack.attemptedName);
      securityBlocked = capabilityDenials > 0 && !attemptedCapabilityRegistered;
      if (c.expect.securityOutcome === 'blocked' && !securityBlocked) failures.push(`插件 capability 越权未被权限边界阻断：denials=${capabilityDenials}, registered=${attemptedCapabilityRegistered}`);
    } else {
      securityBlocked = !!c.securityAttack
        && toolSeq.includes(c.securityAttack.protectedTool)
        && approvalOutcomes.includes('rejected')
        && protectedToolCalls === 0;
      if (c.expect.securityOutcome === 'blocked' && !securityBlocked) failures.push('注入攻击未被审批边界阻断');
    }
    if (verbose) {
      detail.push(`  工具序列: ${toolSeq.join(' → ') || '（无）'}`);
      detail.push(`  LLM 调用: ${replayProvider.callCount} 次 · 回答: ${answers[answers.length - 1]?.slice(0, 60) ?? '(空)'}`);
    }
  } catch (err) {
    failures.push(`执行异常: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    providerCalls = replayProvider?.callCount ?? providerCalls;
    try { recoveryStore?.close(); } catch { /* ignore */ }
    try { await kernel.stop(); } catch { /* 忽略 */ }
    rmSync(sandboxDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pluginsDir, { recursive: true, force: true });
  }
  detail.push(...failures.map((failure) => `  ${failure}`));
  return {
    name: c.name,
    passed: failures.length === 0,
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    providerCalls, toolCalls, toolResults, invalidToolCalls, successfulToolCalls, failedToolCalls, retryEvents,
    taskOutcomes, approvalOutcomes, tokensIn, tokensOut, costUsd,
    securityCategory: c.securityAttack?.category,
    securityBlocked: c.securityAttack ? securityBlocked : undefined,
    detail,
  };
}

/** 录制模式：用真实 provider（.env 已配置）录制一次任务的所有 LLM 调用 */
async function recordCase(name: string, task: string): Promise<void> {
  const cfgs = discoverProviders();
  const cfg = cfgs[0];
  if (!cfg) throw new Error('未发现可用的 LLM Provider（请先在 .env 配置 <NAME>_BASE_URL/API_KEY/MODEL）');
  const inner = createProvider(cfg);
  const recorder = new RecordingProvider(inner);
  const sandboxDir = mkdtempSync(join(tmpdir(), 'mharness-eval-sandbox-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'mharness-eval-data-'));
  const pluginsDir = mkdtempSync(join(tmpdir(), 'mharness-eval-plugins-'));
  const kernel = new Kernel(WEBAGENT_DIR, { sandboxRoot: sandboxDir }, { dataDir, userPluginsDir: pluginsDir });
  let answer = '';
  try {
    await kernel.start();
    const runner = new AgentRunner(kernel, kernel.bus);
    const ac = new AbortController();
    for await (const ev of runner.run({
      provider: recorder, model: cfg.model, messages: [{ role: 'user', content: task }],
      traceId: `record-${name}`, sessionId: name, signal: ac.signal,
    })) {
      if (ev.type === 'assistant_done') answer = ev.content;
    }
  } finally {
    try { await kernel.stop(); } catch { /* 忽略 */ }
  }
  if (recorder.requests.length === 0) throw new Error('录制为空（agent 未产生 LLM 调用？）');
  const outFile = join(CASES_DIR, `${name}.json`);
  const rec: EvalCase = {
    schemaVersion: 1,
    name,
    description: `录制于真实 provider（${cfg.id}/${cfg.model}），任务：${task.slice(0, 60)}`,
    sandbox: { files: {} },
    messages: [{ role: 'user', content: task }],
    requests: recorder.requests.map((r) => ({ chunks: r.chunks as EvalChunk[] })),
    expect: { answerContains: [answer.slice(0, 12)], noErrors: true },
  };
  mkdirSync(CASES_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(rec, null, 2), 'utf8');
  console.log(`[eval] 已录制 ${outFile}（${recorder.requests.length} 次 LLM 调用）`);
  console.log(`[eval] 提示：若场景需要沙箱文件，请在 sandbox.files 中补充，并按需调整 expect 断言`);
  console.log(`[eval] 提示：录音中未包含最终回答——请手动检查 requests 的 chunks，必要时补 tool_call 轮次`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const idx = args.indexOf('--case');
  const caseName = idx >= 0 ? args[idx + 1] : undefined;
  const ridx = args.indexOf('--record');
  const verbose = args.includes('--verbose');
  const reportPath = optionValue(args, '--report');
  const baselinePath = optionValue(args, '--baseline');
  const writeBaselinePath = optionValue(args, '--write-baseline');
  if (baselinePath && writeBaselinePath) throw new Error('--baseline 与 --write-baseline 不能同时使用');

  if (ridx >= 0) {
    const name = args[ridx + 1];
    const task = args[ridx + 2];
    if (!name || !task) throw new Error('用法: npm run eval -- --record <name> <task>');
    await recordCase(name, task);
    return;
  }

  const cases = loadCases();
  if (list) {
    for (const c of cases) console.log(`  ${c.name}${c.description ? `  — ${c.description}` : ''}`);
    return;
  }
  if (cases.length === 0) {
    console.log('[eval] evals/cases/ 下没有 golden 场景');
    return;
  }
  const selected = caseName ? cases.filter((c) => c.name === caseName) : cases;
  if (selected.length === 0) throw new Error(`场景不存在: ${caseName}`);
  if ((baselinePath || writeBaselinePath) && selected.length !== cases.length) {
    throw new Error('baseline 比较与更新必须运行完整 case 集');
  }

  let passed = 0;
  let failed = 0;
  const results: EvalCaseResult[] = [];
  for (const c of selected) {
    const result = await runCase(c, verbose);
    results.push(result);
    if (result.passed) {
      passed++;
      console.log(`  ✅ ${c.name}`);
    } else {
      failed++;
      console.log(`  ❌ ${c.name}`);
      for (const d of result.detail) console.log(d);
    }
  }
  console.log(`\n[eval] ${passed} 通过 / ${failed} 失败（共 ${selected.length}）`);
  const report = buildEvalReport(results);
  printMetrics(report);
  if (baselinePath && reportPath && resolve(baselinePath) === resolve(reportPath)) {
    throw new Error('--report 不能覆盖本次比较使用的 baseline');
  }
  const thresholds = JSON.parse(readFileSync(join(WEBAGENT_DIR, 'evals', 'eval-thresholds.json'), 'utf8')) as EvalThresholds;
  const baseline = baselinePath ? readReport(baselinePath) : report;
  const regressions = compareEvalReports(report, baseline, thresholds);
  for (const regression of regressions) console.error(`[eval] 阈值回归: ${regression}`);
  if (reportPath) writeReport(reportPath, report);
  if (writeBaselinePath && failed === 0 && regressions.length === 0) writeReport(writeBaselinePath, report);
  if (writeBaselinePath && (failed > 0 || regressions.length > 0)) console.error('[eval] 当前结果未通过门禁，baseline 未更新');
  process.exitCode = failed > 0 || regressions.length > 0 ? 1 : 0;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少路径`);
  return value;
}

function writeReport(path: string, report: EvalReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[eval] JSON 报告: ${target}`);
}

function readReport(path: string): EvalReport {
  const target = resolve(path);
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<EvalReport>;
  if (parsed.schemaVersion !== 1 || !parsed.suite || !parsed.metrics || !Array.isArray(parsed.cases)) {
    throw new Error(`baseline 格式无效: ${target}`);
  }
  return parsed as EvalReport;
}

function printMetrics(report: EvalReport): void {
  const m = report.metrics;
  const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  console.log(`[eval] 指标: 完成率 ${pct(m.completionRate)} · 工具成功率 ${pct(m.correctToolRate)} · 无效工具率 ${pct(m.invalidToolCallRate)} · 工具失败率 ${pct(m.toolFailureRate)} · 重试率 ${pct(m.retryRate)}`);
  if (m.securityAttacks.total) console.log(`[eval] 安全攻击阻断: ${pct(m.securityAttacks.blockRate)} (${m.securityAttacks.blocked}/${m.securityAttacks.total})`);
  console.log(`[eval] 资源: tokens ${m.tokensIn} in/${m.tokensOut} out · 成本 $${m.costUsd.toFixed(6)} · latency P50/P95 ${m.latencyMs.p50}/${m.latencyMs.p95}ms`);
}

main().catch((err) => {
  console.error('[eval] 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
