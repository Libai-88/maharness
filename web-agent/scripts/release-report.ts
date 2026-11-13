import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildReleaseReport, type ReleaseManifest, type ReleaseSample, type ReleaseValidation } from '../evals/release-report';

const folder = resolve(process.argv[2] ?? 'evals/reports/release-v2');
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as ReleaseManifest;
const samples = readFileSync(join(folder, 'samples.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(line => line.trim()).map(line => JSON.parse(line) as ReleaseSample & { startedAt: string; endedAt: string; usageComplete?: boolean });
const evidenceFile = join(folder, 'validation-evidence.json');
const validations: ReleaseValidation[] = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : [];
const report = buildReleaseReport(manifest, samples, validations);
const nl = String.fromCharCode(10);
const percentage = (value: number | null) => value === null ? '未知' : (value * 100).toFixed(1) + '%';
const lines = [
  '# maharness v2 真实任务对照评测', '',
  `发布验收：${report.readyForRelease ? '通过' : '未通过'}。完成样本 ${report.observedSamples}/${report.expectedSamples}。`, '',
  ...(manifest.evaluationScope ? [manifest.evaluationScope, ''] : []),
  '三组使用一致的任务材料、工具和模型请求参数。baseline 加载归档运行时，reference 使用最小循环，v2 使用持久任务服务与当前循环。恢复任务从持久断点继续，产物由文件及可执行断言核对。', '',
  '| 模型请求标识 | 组别 | 成功数 / 样本数 | 成功率 | 模型调用中位数 | 输入 / 输出 token 中位数 |',
  '| --- | --- | --- | --- | --- | --- |',
];
for (const model of report.models) for (const variant of ['baseline', 'reference', 'v2'] as const) {
  const metrics = model[variant];
  lines.push(`| ${model.requestedModel} | ${variant} | ${metrics.passed} / ${metrics.samples} | ${percentage(metrics.successRate)} | ${metrics.medianCalls ?? '未知'} | ${metrics.medianTokensIn ?? '未知'} / ${metrics.medianTokensOut ?? '未知'} |`);
}
lines.push('', '## 分类结果', '', '| 模型档 | 分类 | 组别 | 成功 / 样本 |', '| --- | --- | --- | --- |');
for (const model of manifest.models) for (const category of [...new Set(manifest.cases.map(task => task.category))]) for (const variant of ['baseline', 'reference', 'v2'] as const) {
  const caseIds = manifest.cases.filter(task => task.category === category).map(task => task.id);
  const rows = samples.filter(row => row.tier === model.tier && row.variant === variant && caseIds.includes(row.caseId));
  const passed = rows.filter(row => row.completed && !row.runtimeError && row.assertions.length && row.assertions.every(check => check.passed)).length;
  lines.push(`| ${model.tier} | ${category} | ${variant} | ${passed} / ${rows.length} |`);
}
lines.push('', '## 发布门禁', '', '| 检查 | 结果 | 依据 |', '| --- | --- | --- |');
for (const gate of report.gates) lines.push(`| ${gate.id} | ${gate.passed === null ? '无法确认' : gate.passed ? '通过' : '未通过'} | ${gate.detail.replaceAll('|', '/')} |`);
lines.push('', '## 证据边界', '',
  '模型身份来自网关原始响应；仅返回路由别名时，报告不认定固定底层版本。免费模型的真实账单为零，无法以零为分母判断 15% 费用增幅；调用与 token 单独列出。', '',
  `模型请求次数：${samples.reduce((sum, row) => sum + row.calls, 0)}；报告输入 token：${samples.reduce((sum, row) => sum + row.tokensIn, 0)}；报告输出 token：${samples.reduce((sum, row) => sum + row.tokensOut, 0)}。`, '',
  `usage 完整样本：${samples.filter(row => row.usageComplete === true).length}/${samples.length}。缺失 usage 的请求不记为已知 token 成本。`, '',
  '重复副作用统计限于登记订单场景。权限和事件安全结论同时依赖确定性安全、恢复及租户测试。研究任务使用固定本地材料，结果不能外推为开放网络检索质量。运行参数、原始样本、模型响应身份与工具记录分别保存在 manifest.json 和 samples.jsonl。', '',
  '## 未通过样本', '', '| 模型档 | 任务 | 组别 | 次数 | 失败依据 |', '| --- | --- | --- | --- | --- |');
for (const row of samples.filter(row => !row.completed || row.runtimeError || !row.assertions.length || row.assertions.some(check => !check.passed))) {
  const reason = row.runtimeError ?? (row.assertions.filter(check => !check.passed).map(check => check.name).join('；') || '缺少可核对断言');
  lines.push(`| ${row.tier} | ${row.caseId} | ${row.variant} | ${row.repetition} | ${reason.replaceAll('|', '/').replaceAll(nl, ' ')} |`);
}
writeFileSync(join(folder, 'report.json'), JSON.stringify({ ...report, generatedAt: new Date().toISOString(), usageCompleteSamples: samples.filter(row => row.usageComplete === true).length }, null, 2));
writeFileSync(join(folder, 'REPORT.md'), lines.join(nl) + nl);
console.log(JSON.stringify({ readyForRelease: report.readyForRelease, observedSamples: report.observedSamples, expectedSamples: report.expectedSamples, failedGates: report.gates.filter(gate => gate.passed !== true), report: join(folder, 'REPORT.md') }, null, 2));
process.exitCode = report.readyForRelease ? 0 : 2;
