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

const baseUrl = option('--base-url') ?? process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
const model = option('--model') ?? process.env.EVAL_MODEL;
const budgetUsd = Number(option('--budget-usd') ?? process.env.EVAL_BUDGET_USD);
const inputUsdPerMillion = Number(process.env.EVAL_INPUT_USD_PER_MILLION);
const outputUsdPerMillion = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION);
if (!baseUrl || !apiKey || !model || !Number.isFinite(budgetUsd) || budgetUsd <= 0
  || !process.env.EVAL_INPUT_USD_PER_MILLION || !process.env.EVAL_OUTPUT_USD_PER_MILLION
  || !Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion < 0 || !Number.isFinite(outputUsdPerMillion) || outputUsdPerMillion < 0) {
  console.log('[eval:live] 需要独立 EVAL_BASE_URL/EVAL_API_KEY/EVAL_MODEL、正数 EVAL_BUDGET_USD 和输入/输出每百万 token 测试价格；未发送模型请求。');
  process.exit(2);
}
if (option('--judge-model') && option('--judge-model') !== model) {
  console.error('[eval:live] 本命令要求 judge 使用相同模型与显式测试价格。');
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
  budgetUsd,
  prices: { [model]: { inputUsdPerMillion, outputUsdPerMillion } },
  cases: selected.slice(0, limit),
  ...(option('--judge-model') ? { judgeModel: option('--judge-model') } : {}),
});

for (const item of report.cases) {
  const mark = item.pass ? 'PASS' : 'FAIL';
  console.log(`${mark} ${item.name}  score=${item.score}  ${item.latencyMs}ms`);
  if (item.reason) console.log(`  reason: ${item.reason}`);
  if (item.error) console.log(`  error: ${item.error}`);
}
console.log(`\n[eval:live/text-smoke] ${report.cases.filter((item) => item.pass).length}/${report.cases.length} 通过 · passRate=${(report.passRate * 100).toFixed(1)}% · avgScore=${report.averageScore.toFixed(2)} · tokens=${report.totalTokensIn}/${report.totalTokensOut} · cost≤$${report.costUsd.toFixed(6)}/$${report.budgetUsd}；文本冒烟结果不代表运行时发布门禁。`);

const reportPath = option('--report');
if (reportPath) {
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2), 'utf8');
  console.log(`[eval:live] 报告写入 ${reportPath}`);
}

process.exit(report.passRate >= 0.8 ? 0 : 1);
