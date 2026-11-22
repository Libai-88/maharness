import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import { createProvider } from '../core/chat/provider';
import type { ProviderDef } from '../kernel/types';
import type { RunRecord } from '../kernel/run';

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(
  process.env.EVAL_REPORT_DIR ?? join(root, 'evals/reports/optimization-live', new Date().toISOString().replace(/[:.]/g, '-')),
);
const baseUrl = process.env.EVAL_BASE_URL;
const apiKey = process.env.EVAL_API_KEY;
const model = process.env.EVAL_MODEL;
assert.ok(baseUrl && apiKey && model, 'EVAL_BASE_URL/EVAL_API_KEY/EVAL_MODEL required');
assert.ok(!existsSync(reportDir), 'Report directory must be new');
const workspace = join(reportDir, 'workspace');
const runtime = join(reportDir, 'runtime');
for (const path of [workspace, runtime, join(workspace, 'notes'), join(workspace, 'references')]) mkdirSync(path, { recursive: true });
writeFileSync(join(workspace, 'notes', 'learning-plan.txt'), '课程：线性代数\n复习时间：2026-11-20 20:00\n识别码：MAH-4827\n');
writeFileSync(join(workspace, 'references', 'option-a.txt'), '方案A：每月120元，容量30GB，保留90天。\n');
writeFileSync(join(workspace, 'references', 'option-b.txt'), '方案B：每月80元，容量20GB，保留30天。\n');
writeFileSync(
  join(workspace, 'handbook.docx'),
  await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph('资料管理手册'),
            new Paragraph('归档周期：每周五。'),
            new Paragraph('负责人：林青。'),
            new Paragraph('保留期限：180天。'),
          ],
        },
      ],
    }),
  ),
);

const cases = [
  {
    id: 1,
    name: '目录查看',
    prompt: '请查看当前工作区根目录，列出其中的文件和文件夹名称。',
    expected: '一次 list_dir；列出 handbook.docx、notes、references；无发现、结果回读或组队',
  },
  {
    id: 2,
    name: '文件定位',
    prompt: '请按文件名找到工作区内的 learning-plan.txt，告诉我相对路径，不需要读内容。',
    expected: '定位 notes/learning-plan.txt；使用文件名搜索；不读取文件内容',
  },
  {
    id: 3,
    name: '文本检索',
    prompt: '搜索工作区文本文件，找到 MAH-4827 所在文件及对应行。',
    expected: '找到 notes/learning-plan.txt 第3行和 MAH-4827；使用内容搜索',
  },
  {
    id: 4,
    name: '文档阅读',
    prompt: '阅读 handbook.docx，告诉我归档周期、负责人和保留期限。',
    expected: '文档工具读取；答复每周五、林青、180天',
  },
  {
    id: 5,
    name: 'Office处理',
    prompt: '创建一个XLSX文件“学习开销”，工作表名“开销”，三行分别为：项目、金额；书籍、120；课程、80。请交付可下载文件。',
    expected: '可重新解析的xlsx；工作表开销；指定3行及数值正确；登记产物',
  },
  {
    id: 6,
    name: '资料对比',
    prompt:
      '比较 references/option-a.txt 和 references/option-b.txt，给出价格、容量、保留时间差异。需求是至少25GB且保留至少60天，指出哪个满足，并引用来源路径。',
    expected: '读取两份资料；A满足；价格120/80，容量30/20，保留90/30；来源路径',
  },
  {
    id: 7,
    name: '日程待办',
    prompt: '请记录一条待办：提交学习笔记，2026-11-20 18:30，Asia/Shanghai，高优先级。只保存这条个人事项。',
    expected: '只创建一条个人事项；标题、日期、时间、时区和高优先级准确',
  },
  {
    id: 8,
    name: '角色协作',
    prompt:
      '请让“方案A分析员”和“方案B分析员”两个角色各自分析 references/option-a.txt 和 references/option-b.txt，独立交付 analysis-a.md 和 analysis-b.md，再由你汇总两者的价格和容量。请实际执行分工。',
    expected: '真实团队与两个子Run；持久角色关联；两个独立文件；无预算与未知价格下完成',
  },
  {
    id: 9,
    name: '任务纠偏',
    prompt: '读取 notes/learning-plan.txt，然后创建 correction.md，内容为计划的课程和复习时间。',
    expected: '首次读取后注入补充要求；同一Run消费消息；只写一次correction.md且含CORRECTION-OK',
  },
];
const selectedCases = process.env.EVAL_CASES
  ? cases.filter((task) => process.env.EVAL_CASES!.split(',').map(Number).includes(task.id))
  : cases;
assert.ok(selectedCases.length);
writeFileSync(
  join(reportDir, 'manifest.json'),
  JSON.stringify(
    {
      model,
      baseUrl,
      createdAt: new Date().toISOString(),
      budgetUsd: null,
      priceSource: 'unknown',
      cases: selectedCases,
      limits: { cases: selectedCases.length, modelCalls: 80, perCaseMs: 240000 },
      entry: 'production startServer + RunService',
    },
    null,
    2,
  ),
);

const portProbe = createServer();
await new Promise<void>((done) => portProbe.listen(0, '127.0.0.1', done));
const port = (portProbe.address() as { port: number }).port;
await new Promise<void>((done) => portProbe.close(() => done()));
Object.assign(process.env, {
  PORT: String(port),
  AGENT_DATA_DIR: runtime,
  AGENT_USER_PLUGINS_DIR: join(reportDir, 'plugins'),
  SANDBOX_ROOT: workspace,
  MAHARNESS_MODE: 'local',
  AUTO_STOP_IDLE_MS: '0',
});
const { startServer } = await import('../server/index');
const started = await startServer();
const base = `http://127.0.0.1:${port}`;
const source = createProvider({ id: 'optimization-live', baseUrl, apiKey, model, protocol: 'openai', requestTimeoutMs: 120000 });
let totalCalls = 0;
const provider: ProviderDef = {
  ...source,
  async *chat(messages, options) {
    assert.ok(++totalCalls <= 80, 'EVAL_CALL_LIMIT');
    yield* source.chat(messages, options);
  },
};
const chat = started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] };
chat.providers = [provider];
started.store.upsertProvider({
  id: provider.id,
  label: 'Optimization live',
  baseUrl: 'runtime-only',
  apiKey: '',
  model,
  protocol: 'openai',
  enabled: 1,
});
for (const [id, name] of [
  ['analyst-a', '方案A分析员'],
  ['analyst-b', '方案B分析员'],
]) {
  const now = Date.now();
  started.store.organization.createRole({
    id,
    name,
    tenantId: 'default',
    projectId: '',
    responsibilities: ['分析指定资料并交付Markdown'],
    capabilities: ['资料分析'],
    authority: { workspace, readOnly: false, profile: 'standard', allowedTools: ['read_file', 'write_file'] },
    modelPolicy: { providerId: provider.id, model },
    persistent: true,
    employment: 'active',
    source: 'human',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

const samples: Record<string, unknown>[] = [];
const collectRuns = (run: RunRecord): RunRecord[] => [run, ...started.store.runs.children(run.id, 'default').flatMap(collectRuns)];
const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
try {
  for (const task of selectedCases) {
    const start = Date.now();
    const callsBefore = totalCalls;
    const session = started.store.createSession(model, provider.id);
    const response = await fetch(`${base}/api/v2/sessions/${session.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `optimization-${task.id}` },
      body: JSON.stringify({ message: task.prompt }),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const { runId } = (await response.json()) as { runId: string };
    let correctionId: string | undefined;
    const unsubscribe = started.runs.subscribe(runId, (event) => {
      if (task.id === 9 && event.type === 'tool_result' && event.data.name === 'read_file' && !correctionId) {
        correctionId = started.runs.supplement(
          runId,
          'default',
          '补充要求：correction.md末尾加一行 CORRECTION-OK。只写一次文件。',
          'correction-once',
        );
      }
    });
    let final: RunRecord;
    for (;;) {
      final = started.runs.get(runId, 'default');
      if (['completed', 'interrupted', 'failed', 'cancelled', 'waiting_approval'].includes(final.status)) break;
      if (Date.now() - start > 240000) {
        started.runs.cancel(runId, 'default');
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    unsubscribe();
    const runs = collectRuns(final);
    const tools = runs.flatMap((run) => started.store.runs.toolCalls(run.id)).sort((a, b) => a.startedAt - b.startedAt);
    const artifacts = runs.flatMap((run) => started.store.runs.artifacts(run.id));
    const calls = runs.flatMap((run) => started.store.runs.modelCalls(run.id, 0, 100));
    const inputs = runs
      .flatMap((run) => started.store.runs.modelInputs(run.id, 100))
      .map(({ diagnostics, turn, callId }) => ({ diagnostics, turn, callId }));
    const events = runs.flatMap((run) => started.store.runs.events(run.id, 0, 10000));
    const checks: { name: string; passed: boolean }[] = [];
    const check = (name: string, passed: unknown) => checks.push({ name, passed: Boolean(passed) });
    const answer = final.answer ?? '';
    const names = tools.map((tool) => tool.name);
    check('有效完成', final.status === 'completed' && answer.trim());
    check(
      '无工具失败',
      tools.every((tool) => tool.status === 'succeeded'),
    );
    if (task.id <= 4) check('两次模型往返', totalCalls - callsBefore === 2);
    if (task.id <= 4)
      check(
        '无无效发现、结果回读或组队',
        !names.some((name) => /discover|enable_capabilities|read_tool_result|team_create|run_parallel/.test(name)),
      );
    if (task.id === 1) {
      check('仅一次list_dir', names.length === 1 && names[0] === 'list_dir');
      check(
        '目录名称准确',
        ['notes', 'references', 'handbook.docx'].every((text) => answer.includes(text)),
      );
    }
    if (task.id === 2) {
      check('文件路径准确', /notes[\\/]learning-plan\.txt/.test(answer));
      check('仅一次文件名搜索', names.length === 1 && names[0] === 'glob');
    }
    if (task.id === 3) {
      check(
        '仅一次内容搜索并命中',
        names.length === 1 && names[0] === 'grep' && answer.includes('MAH-4827') && answer.includes('learning-plan.txt'),
      );
    }
    if (task.id === 4) {
      check(
        '文档事实准确',
        ['每周五', '林青', '180'].every((text) => answer.includes(text)),
      );
      check('仅一次文档直读', names.length === 1 && names[0] === 'read_document_content');
    }
    if (task.id === 5) {
      const files = listFiles(workspace).filter((path) => path.endsWith('.xlsx'));
      check('单个XLSX产物', files.length === 1);
      check(
        'Run登记XLSX产物',
        artifacts.some((artifact) => artifact.ref.endsWith('.xlsx')),
      );
      if (files[0]) {
        const book = new ExcelJS.Workbook();
        await book.xlsx.readFile(files[0]);
        const sheet = book.getWorksheet('开销');
        check(
          'XLSX内容可解析且准确',
          sheet?.getCell('A1').value === '项目' &&
            sheet.getCell('B1').value === '金额' &&
            sheet.getCell('A2').value === '书籍' &&
            sheet.getCell('B2').value === 120 &&
            sheet.getCell('A3').value === '课程' &&
            sheet.getCell('B3').value === 80,
        );
      }
    }
    if (task.id === 6)
      check(
        '比较事实与来源',
        ['120', '80', '30', '20', '90', 'option-a.txt', 'option-b.txt'].every((text) => answer.includes(text)) &&
          /方案\s*A|方案\s*Ａ/.test(answer),
      );
    if (task.id === 7) {
      const items = started.kernel.plugins.resolveService('service:personal-items') as {
        list(tenant: string): { title: string; due: string; dueTime: string; timeZone: string; prio: number }[];
      };
      const rows = items.list('default');
      check(
        '单条准确待办',
        rows.length === 1 &&
          rows[0].title === '提交学习笔记' &&
          rows[0].due === '2026-11-20' &&
          rows[0].dueTime === '18:30' &&
          rows[0].timeZone === 'Asia/Shanghai' &&
          rows[0].prio === 2,
      );
    }
    if (task.id === 8) {
      check(
        '团队与两个真实子任务',
        !!final.teamCycleId &&
          runs.length === 3 &&
          runs.slice(1).every((run) => run.status === 'completed' && run.organizationRoleId && run.assignmentContractId),
      );
      check(
        '持久角色分工',
        ['analyst-a', 'analyst-b'].every((role) => runs.some((run) => run.organizationRoleId === role)),
      );
      check(
        '两份交付文件',
        ['analysis-a.md', 'analysis-b.md'].every((file) => existsSync(join(workspace, file))),
      );
      check(
        '两份产物由约定角色独立交付',
        ['analyst-a', 'analyst-b'].every((role, index) => {
          const child = runs.find((run) => run.parentId && run.organizationRoleId === role);
          const contract = child?.assignmentContractId && started.store.organization.getContract(child.assignmentContractId, 'default');
          const file = `analysis-${index === 0 ? 'a' : 'b'}.md`;
          return (
            contract &&
            contract.status === 'delivered' &&
            !contract.coordinatorArtifacts?.length &&
            artifacts.some((artifact) => artifact.runId === child?.id && artifact.ref === file)
          );
        }),
      );
      check(
        '无隐含预算',
        runs.every((run) => run.budgetUsd === undefined),
      );
    }
    if (task.id === 9) {
      check(
        '补充要求进入原任务',
        correctionId && events.some((event) => event.type === 'message_delivered' && event.data.id === correctionId),
      );
      check(
        '单次写入且包含纠偏要求',
        tools.filter((tool) => tool.name === 'write_file').length === 1 &&
          existsSync(join(workspace, 'correction.md')) &&
          readFileSync(join(workspace, 'correction.md'), 'utf8').includes('CORRECTION-OK'),
      );
    }
    const sample = {
      ...task,
      runId,
      status: final.status,
      answer,
      error: final.error,
      problem: final.problem,
      checks,
      passed: checks.every((item) => item.passed),
      calls: totalCalls - callsBefore,
      tokensIn: calls.reduce((sum, call) => sum + (call.input ?? 0), 0),
      tokensOut: calls.reduce((sum, call) => sum + (call.output ?? 0), 0),
      usageComplete: calls.every((call) => call.usageStatus === 'reported'),
      costUsd: null,
      elapsedMs: Date.now() - start,
      toolSequence: names,
      failureAttribution: checks.every((item) => item.passed) ? null : '待依据运行记录归因',
    };
    samples.push(sample);
    writeFileSync(
      join(reportDir, `case-${task.id}.json`),
      JSON.stringify({ sample, runs, calls, inputs, tools, artifacts, events }, null, 2),
    );
    writeFileSync(
      join(reportDir, 'report.json'),
      JSON.stringify(
        {
          model,
          priceSource: 'unknown',
          costUsd: null,
          samples,
          passed: samples.filter((row) => row.passed).length,
          expected: selectedCases.length,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        id: task.id,
        name: task.name,
        passed: sample.passed,
        status: final.status,
        calls: sample.calls,
        elapsedMs: sample.elapsedMs,
        failedChecks: checks.filter((item) => !item.passed),
      }),
    );
  }
} finally {
  started.closeEnvWatcher();
  await started.runs.shutdown();
  await started.kernel.stop();
  started.store.close();
  started.server.closeAllConnections();
  await new Promise<void>((done) => started.server.close(() => done()));
}
console.log(
  JSON.stringify({
    report: join(reportDir, 'report.json'),
    passed: samples.filter((row) => row.passed).length,
    expected: selectedCases.length,
    totalCalls,
  }),
);
process.exitCode = samples.length === selectedCases.length && samples.every((row) => row.passed) ? 0 : 1;
