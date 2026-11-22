import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentService } from '../core/document/service';
import { searchPapers, verifyCitation } from '../core/academic/references';
import { runPowershell } from '../core/powershell';
import { Store } from '../server/db';
const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, 'evals/reports/workbench', stamp);
mkdirSync(output, { recursive: true });
const samples = join(output, 'samples');
mkdirSync(samples);
function makePdf() {
  const content = 'BT /F1 12 Tf 50 730 Td (Item Amount) Tj 0 -24 Td (Travel 100) Tj 0 -24 Td (Books 200) Tj ET';
  const content2 = 'BT /F1 12 Tf 50 730 Td (Conclusion: total cost is 300.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const scenarios: { id: number; name: string; passed: boolean; durationMs: number; error?: string }[] = [];
async function scenario(id: number, name: string, test: () => Promise<void>) {
  const start = Date.now();
  try {
    await test();
    scenarios.push({ id, name, passed: true, durationMs: Date.now() - start });
  } catch (error) {
    scenarios.push({ id, name, passed: false, durationMs: Date.now() - start, error: String(error) });
  }
}
const store = new Store(':memory:');
const pdf = makePdf();
writeFileSync(join(samples, 'source.pdf'), pdf);
await scenario(1, 'PDF 问答资料与来源页定位', async () => {
  const material = store.materials.register('default', samples, 'source.pdf', root);
  const content = await documentService.read(pdf, 'pdf', { pages: [2] });
  assert.equal(content.blocks[0]?.anchor.page, 2);
  assert.match(content.blocks[0]!.text, /300/);
  const source = `#material=${material.id}&version=${material.version}&block=page%3A2&page=2`;
  writeFileSync(join(samples, 'answer.md'), `总费用为 300。\n\n[来源](${source})\n`);
});
await scenario(2, 'PDF 资料提取到 XLSX', async () => {
  const content = await documentService.read(pdf, 'pdf', { pages: [1] });
  const rows = [
    ...content.blocks
      .map((block) => block.text)
      .join('\n')
      .matchAll(/(Travel|Books)\s+(\d+)/g),
  ].map((match) => [match[1]!, Number(match[2])] as [string, number]);
  assert.equal(rows.length, 2);
  const bytes = await documentService.create({ format: 'xlsx', sheets: [{ name: '费用', rows: [['项目', '金额'], ...rows] }] });
  writeFileSync(join(samples, 'extracted.xlsx'), bytes);
  assert.equal((await documentService.read(bytes, 'xlsx')).blocks.find((block) => block.anchor.cell === 'B3')?.text, '200');
});
await scenario(3, 'DOCX 正文与表格单元格定点修改', async () => {
  const bytes = await documentService.create({
    format: 'docx',
    title: '学习计划',
    paragraphs: [{ text: '每周阅读 2 篇论文。' }],
    tables: [
      [
        ['任务', '状态'],
        ['笔记', '待完成'],
      ],
    ],
  });
  writeFileSync(join(samples, 'source.docx'), bytes);
  const content = await documentService.read(bytes, 'docx');
  const text = content.blocks.find((block) => block.text === '每周阅读 2 篇论文。')!,
    cell = content.blocks.find((block) => block.text === '待完成')!;
  const result = await documentService.patch(bytes, 'docx', content.version, [
    { blockId: text.id, expected: text.text, text: '每周阅读 3 篇论文。' },
    { blockId: cell.id, expected: cell.text, text: '已完成' },
  ]);
  writeFileSync(join(samples, 'edited.docx'), result);
  const after = await documentService.read(result, 'docx');
  assert.ok(after.blocks.some((block) => block.text === '每周阅读 3 篇论文。'));
  assert.ok(after.blocks.some((block) => block.rows?.[1]?.[1] === '已完成'));
});
await scenario(4, 'CSV/XLSX 整理与汇总', async () => {
  const bytes = await documentService.create({
    format: 'csv',
    sheets: [
      {
        name: 'data',
        rows: [
          ['项目', '金额'],
          ['Travel', 100],
          ['Books', 200],
        ],
      },
    ],
  });
  writeFileSync(join(samples, 'source.csv'), bytes);
  const content = await documentService.read(bytes, 'csv');
  const total = content.blocks.slice(1).reduce((sum, block) => sum + Number(block.rows?.[0]?.[1]), 0);
  assert.equal(total, 300);
  const result = await documentService.create({
    format: 'xlsx',
    sheets: [
      {
        name: '汇总',
        rows: [
          ['类别', '合计'],
          ['费用', total],
        ],
      },
    ],
  });
  writeFileSync(join(samples, 'summary.xlsx'), result);
  assert.ok((await documentService.read(result, 'xlsx')).blocks.some((block) => block.text === '300'));
  const contentAfter = await documentService.read(result, 'xlsx');
  const edited = await documentService.patch(result, 'xlsx', contentAfter.version, [
    { blockId: '1!A2', expected: '费用', text: '费用合计' },
  ]);
  writeFileSync(join(samples, 'edited.xlsx'), edited);
  assert.ok((await documentService.read(edited, 'xlsx')).blocks.some((block) => block.text === '费用合计'));
});
await scenario(5, 'PPTX 生成与指定幻灯片文字修改', async () => {
  const bytes = await documentService.create({
    format: 'pptx',
    title: '读书汇报',
    slides: [
      { title: '本周阅读', text: '已阅读 2 篇论文' },
      { title: '下一步', text: '整理方法与局限' },
    ],
  });
  writeFileSync(join(samples, 'source.pptx'), bytes);
  const content = await documentService.read(bytes, 'pptx');
  const target = content.blocks.find((block) => block.text === '已阅读 2 篇论文')!;
  const result = await documentService.patch(bytes, 'pptx', content.version, [
    { blockId: target.id, expected: target.text, text: '已阅读 3 篇论文' },
  ]);
  writeFileSync(join(samples, 'edited.pptx'), result);
  assert.ok((await documentService.read(result, 'pptx')).blocks.some((block) => block.text === '已阅读 3 篇论文'));
});
await scenario(6, '双资料对比笔记与来源锚点', async () => {
  const a = await documentService.create({ format: 'docx', paragraphs: [{ text: '论文甲：采用观察研究，样本量为 20。' }] }),
    b = await documentService.create({ format: 'docx', paragraphs: [{ text: '论文乙：采用随机试验，样本量为 40。' }] });
  const x = await documentService.read(a, 'docx'),
    y = await documentService.read(b, 'docx');
  const notes = await documentService.create({
    format: 'docx',
    title: '阅读对比',
    tables: [
      [
        ['资料', '证据', '来源块'],
        ['甲', x.blocks[0]!.text, `${x.version}:${x.blocks[0]!.id}`],
        ['乙', y.blocks[0]!.text, `${y.version}:${y.blocks[0]!.id}`],
      ],
    ],
  });
  writeFileSync(join(samples, 'comparison.docx'), notes);
  assert.ok((await documentService.read(notes, 'docx')).blocks.some((block) => block.rows?.length === 3));
});
await scenario(7, '公开检索接口回放与题录差异检测', async () => {
  const refs = await searchPapers('example', 1, undefined, async (url) => ({
    finalUrl: url,
    body: JSON.stringify({ message: { items: [{ DOI: '10.1234/example', title: ['Example study'] }] } }),
  }));
  assert.equal(refs.length, 1);
  const verification = await verifyCitation({ doi: '10.1234/example', title: 'Example study', year: 2025 }, undefined, async (url) => ({
    finalUrl: url,
    body: JSON.stringify({ DOI: '10.1234/example', title: 'Example study', issued: { 'date-parts': [[2024]] } }),
  }));
  assert.equal(verification.status, 'differences_found');
  if ('bibtex' in verification) writeFileSync(join(samples, 'references.bib'), verification.bibtex!);
});
await scenario(8, '工作区文件批量整理与结果清单', async () => {
  const inbox = join(samples, 'inbox'),
    organized = join(samples, 'organized');
  mkdirSync(inbox);
  mkdirSync(organized);
  writeFileSync(join(inbox, 'a.txt'), 'A');
  writeFileSync(join(inbox, 'b.txt'), 'B');
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;
  const result = await runPowershell(
    `Get-ChildItem -LiteralPath ${quote(inbox)} -File -Filter '*.txt' | Move-Item -Destination ${quote(organized)}; Get-ChildItem -LiteralPath ${quote(organized)} -File | Select-Object -ExpandProperty Name`,
    20_000,
    samples,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(readdirSync(organized).sort(), ['a.txt', 'b.txt']);
  assert.equal(readdirSync(inbox).length, 0);
  writeFileSync(join(samples, 'organized-files.md'), '# 文件清单\n\na.txt\nb.txt\n');
});
store.close();
const files = [
  'core/document/tests/document.spec.ts',
  'core/document/tests/workbench.spec.ts',
  'core/academic/tests/academic.spec.ts',
  'core/academic/tests/references.spec.ts',
  'server/tests/materials.spec.ts',
  'server/tests/db.spec.ts',
  'server/tests/api-contract.spec.ts',
  'server/tests/run-service.spec.ts',
  'core/chat/tests/tool-broker.spec.ts',
  'core/search/tests/ssrf.spec.ts',
  'server/tests/auth.spec.ts',
];
const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...files], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
  timeout: 120_000,
});
const log = tests.stdout + tests.stderr;
writeFileSync(join(output, 'tests.tap'), log);
const count = (key: string) => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(log)?.[1] ?? 0);
const paths = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    'kernel',
    'core',
    'server',
    'scripts',
    'ui/src',
    'ui/e2e',
    'package.json',
    'package-lock.json',
    'ui/package.json',
    'ui/package-lock.json',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const added = execFileSync(
  'git',
  [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    'kernel',
    'core',
    'server',
    'scripts',
    'ui/src',
    'ui/e2e',
    'package.json',
    'package-lock.json',
    'ui/package.json',
    'ui/package-lock.json',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const hash = createHash('sha256');
for (const path of [...new Set([...paths, ...added])].sort())
  if (existsSync(join(root, path))) hash.update(path).update(readFileSync(join(root, path)));
const report = {
  kind: 'targeted-workbench-deterministic',
  createdAt: new Date().toISOString(),
  workingSourceSha256: hash.digest('hex'),
  passed: scenarios.every((scenario) => scenario.passed) && tests.status === 0,
  scenarios,
  tests: { total: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), exitCode: tests.status },
  modelRequests: 0,
  modelCostUsd: 0,
  liveModelEvaluation: 'not_run',
  liveNetworkEvaluation: 'not_run',
  officeApplicationValidation: 'separate-report',
  limitations: [
    '固定任务使用确定性工具链，不衡量模型自主选择能力。',
    '联网题录使用固定响应回放，不代表公开服务当前可用性。',
    '浏览器交互与 Office 打开检查分别记录。',
  ],
  samples,
};
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      report: join(output, 'report.json'),
      passed: report.passed,
      scenarios: scenarios.filter((s) => s.passed).length,
      tests: report.tests,
    },
    null,
    2,
  ),
);
if (!report.passed) {
  console.error(JSON.stringify(scenarios.filter((s) => !s.passed)));
  console.error(log.slice(-8000));
  process.exitCode = 1;
}
