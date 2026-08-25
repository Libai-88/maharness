/**
 * scripts/agent-eval.ts —— Agent 级回归评测（Record/Replay + Golden 断言）
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
import { ReplayProvider, RecordingProvider, type Recording } from '../core/chat/replay-provider';
import { createProvider, discoverProviders } from '../core/chat/provider';

const WEBAGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = join(WEBAGENT_DIR, 'evals', 'cases');

interface EvalChunk { type: string; [k: string]: unknown }
interface EvalRequest { chunks: EvalChunk[] }
interface EvalExpect {
  repeats?: number;
  toolSequence?: string[];
  answerContains?: string[];
  llmCalls?: number;
  cachedOn?: number[];
  noErrors?: boolean;
}
interface EvalCase {
  name: string;
  description?: string;
  sandbox?: { files?: Record<string, string> };
  messages: { role: string; content: string }[];
  requests: EvalRequest[];
  expect: EvalExpect;
}

function loadCases(): EvalCase[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf-8')) as EvalCase;
    if (!c.name) c.name = f.replace(/\.json$/, '');
    return c;
  });
}

/** 子序列匹配：expect 中的每个工具都按顺序出现在实际序列中 */
function subSequence(actual: string[], expect: string[]): boolean {
  let i = 0;
  for (const a of actual) if (i < expect.length && a === expect[i]) i++;
  return i === expect.length;
}

async function runCase(c: EvalCase, verbose: boolean): Promise<{ pass: boolean; detail: string[] }> {
  const detail: string[] = [];
  const sandboxDir = mkdtempSync(join(tmpdir(), 'mharness-eval-sandbox-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'mharness-eval-data-'));
  const pluginsDir = mkdtempSync(join(tmpdir(), 'mharness-eval-plugins-'));
  const kernel = new Kernel(WEBAGENT_DIR, { sandboxRoot: sandboxDir }, { dataDir, userPluginsDir: pluginsDir });
  const failures: string[] = [];
  const toolSeq: string[] = [];
  const answers: string[] = [];
  const cachedFlags: number[] = []; // 命中 L1 缓存第几次运行（1-based）
  try {
    // 场景夹具：写入沙箱文件
    for (const [rel, content] of Object.entries(c.sandbox?.files ?? {})) {
      const full = join(sandboxDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    await kernel.start();
    const provider = new ReplayProvider({ version: 1, requests: c.requests as unknown as Recording['requests'] });
    const runner = new AgentRunner(kernel, kernel.bus);
    const repeats = c.expect.repeats ?? 1;
    for (let r = 1; r <= repeats; r++) {
      const messages = c.messages.map((m) => ({ role: m.role as 'user', content: m.content }));
      let answer = '';
      let noErrors = true;
      const ac = new AbortController();
      for await (const ev of runner.run({
        provider,
        model: 'replay',
        messages,
        traceId: `${c.name}-run${r}`,
        scope: c.name,          // 同一场景同 scope：L1 会话级缓存可跨 run 命中
        sessionId: c.name,
        signal: ac.signal,
      })) {
        if (ev.type === 'tool_start') toolSeq.push(ev.name);
        else if (ev.type === 'assistant_done') { answer = ev.content; if (ev.cached) cachedFlags.push(r); }
        else if (ev.type === 'error') { noErrors = false; detail.push(`  [run${r}] error: ${ev.error}`); }
      }
      answers.push(answer);
      if (c.expect.noErrors && !noErrors) failures.push(`run${r} 出现 error 事件`);
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
    if (c.expect.llmCalls !== undefined && provider.callCount !== c.expect.llmCalls) {
      failures.push(`LLM 调用次数：期望 ${c.expect.llmCalls}，实际 ${provider.callCount}`);
    }
    if (c.expect.cachedOn) {
      for (const r of c.expect.cachedOn) {
        if (!cachedFlags.includes(r)) failures.push(`第 ${r} 次运行未命中 L1 缓存（命中运行: ${cachedFlags.join(',') || '无'}）`);
      }
    }
    if (verbose) {
      detail.push(`  工具序列: ${toolSeq.join(' → ') || '（无）'}`);
      detail.push(`  LLM 调用: ${provider.callCount} 次 · 回答: ${answers[answers.length - 1]?.slice(0, 60) ?? '(空)'}`);
    }
  } catch (err) {
    failures.push(`执行异常: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { await kernel.stop(); } catch { /* 忽略 */ }
    rmSync(sandboxDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pluginsDir, { recursive: true, force: true });
  }
  return { pass: failures.length === 0, detail };
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

  let passed = 0;
  let failed = 0;
  for (const c of selected) {
    const { pass, detail } = await runCase(c, verbose);
    if (pass) {
      passed++;
      console.log(`  ✅ ${c.name}`);
    } else {
      failed++;
      console.log(`  ❌ ${c.name}`);
      for (const d of detail) console.log(d);
    }
  }
  console.log(`\n[eval] ${passed} 通过 / ${failed} 失败（共 ${selected.length}）`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[eval] 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
