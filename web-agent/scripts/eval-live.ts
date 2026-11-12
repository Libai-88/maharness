/**
 * 真实模型 live 评测：一次采样 + LLM-as-judge。
 * 没有 API key 时明确跳过（exit 2），不伪装成通过；CI 仍使用确定性的 eval:ci。
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runLiveEval, type LiveEvalCase } from '../evals/live';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const baseUrl = option('--base-url') ?? process.env.EVAL_BASE_URL ?? process.env.NEWAPI_BASE_URL;
const apiKey = process.env.EVAL_API_KEY ?? process.env.NEWAPI_API_KEY;
const model = option('--model') ?? process.env.EVAL_MODEL ?? process.env.NEWAPI_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.log('[eval:live] 未配置 EVAL_BASE_URL/EVAL_API_KEY/EVAL_MODEL（或 NEWAPI_*），已跳过真实模型评测。');
  process.exit(2);
}

const casesPath = resolve(option('--cases') ?? 'evals/live-cases.json');
const raw = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases?: LiveEvalCase[] };
const cases = Array.isArray(raw.cases) ? raw.cases : [];
if (!cases.length) {
  console.error(`[eval:live] ${casesPath} 没有 cases`);
  process.exit(2);
}
const selected = option('--case') ? cases.filter((item) => item.name === option('--case')) : cases;
const limit = Math.max(1, Math.trunc(Number(option('--limit')) || selected.length));

const report = await runLiveEval({
  baseUrl,
  apiKey,
  model,
  cases: selected.slice(0, limit),
  ...(option('--judge-model') ? { judgeModel: option('--judge-model') } : {}),
});

for (const item of report.cases) {
  const mark = item.pass ? 'PASS' : 'FAIL';
  console.log(`${mark} ${item.name}  score=${item.score}  ${item.latencyMs}ms`);
  if (item.reason) console.log(`  reason: ${item.reason}`);
  if (item.error) console.log(`  error: ${item.error}`);
}
console.log(`\n[eval:live] ${report.cases.filter((item) => item.pass).length}/${report.cases.length} 通过 · passRate=${(report.passRate * 100).toFixed(1)}% · avgScore=${report.averageScore.toFixed(2)} · tokens=${report.totalTokensIn}/${report.totalTokensOut}`);

const reportPath = option('--report');
if (reportPath) {
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[eval:live] 报告写入 ${reportPath}`);
}

process.exit(report.passRate >= 0.8 ? 0 : 1);
