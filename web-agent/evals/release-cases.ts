import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { ReleaseCategory } from './release-report';

export interface ReleaseTask {
  id: string; category: ReleaseCategory; prompt: string; files: Record<string, string>;
  check(workspace: string): { name: string; passed: boolean }[];
  fault?: 'transient-read' | 'schema-read' | 'missing-path' | 'version-conflict' | 'truncated-read' | 'invalid-json';
}
const nl = String.fromCharCode(10);
function json(workspace: string, path: string): unknown {
  try { return JSON.parse(readFileSync(join(workspace, path), 'utf8')); } catch { return undefined; }
}
const equal = isDeepStrictEqual;
export function releaseTasks(): ReleaseTask[] {
  const tasks: ReleaseTask[] = [];
  const code = [
    { id: 'sum', source: 'export const solve = xs => xs.reduce((a,b) => a-b, 0);', input: [2, 3, 5], expected: 10, goal: '返回数字数组之和，空数组为 0', extra: [[], 0] },
    { id: 'unique', source: 'export const solve = xs => xs;', input: ['a', 'b', 'a', 'c', 'b'], expected: ['a', 'b', 'c'], goal: '去重且保留首次出现的顺序', extra: [[], []] },
    { id: 'median', source: 'export const solve = xs => xs[0];', input: [10, 2, 4, 6], expected: 5, goal: '计算非空数字数组中位数，偶数长度返回中间两数平均值，不修改输入', extra: [[9, 1, 3], 3] },
    { id: 'slug', source: 'export const solve = s => s;', input: '  Hello   Agent World  ', expected: 'hello-agent-world', goal: '去除首尾空白，转小写，把连续空白转为一个连字符', extra: ['One', 'one'] },
    { id: 'group', source: 'export const solve = xs => ({});', input: [{ type: 'a', n: 1 }, { type: 'b', n: 2 }, { type: 'a', n: 3 }], expected: { a: [1, 3], b: [2] }, goal: '把对象数组按 type 分组，值为各项 n 的数组，保持顺序', extra: [[], {}] },
    { id: 'range', source: 'export const solve = (n) => Array.from({length:n},(_,i)=>i);', input: 4, expected: [1, 2, 3, 4], goal: '给定非负整数 n，返回 1 到 n 的数组，n=0 返回空数组', extra: [0, []] },
  ];
  for (const item of code) tasks.push({
    id: 'code-' + item.id, category: 'code', files: { 'solution.mjs': item.source },
    prompt: `修复 solution.mjs 的 solve 导出：${item.goal}。直接修改文件，保留导出名称。`,
    check(workspace) {
      const script = `import {solve} from './solution.mjs'; const input=${JSON.stringify(item.input)}; const before=JSON.stringify(input); console.log(JSON.stringify([solve(input),solve(${JSON.stringify(item.extra[0])}),JSON.stringify(input)===before]));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
      let value: unknown; try { value = JSON.parse(result.stdout.trim()); } catch {}
      return [{ name: 'executable code assertions', passed: result.status === 0 && equal(value, [item.expected, item.extra[1], true]) }];
    },
  });
  for (let index = 1; 7 > index; index++) {
    const target = 10 + index;
    const sources = {
      'sources/old.md': `# 旧报告${nl}年份: 2023${nl}已审核: 否${nl}项目: P${index}${nl}总数: 999${nl}`,
      'sources/current.md': `# 审核报告${nl}年份: 2026${nl}已审核: 是${nl}项目: P${index}${nl}总数: ${target}${nl}范围: 本地样本，不代表全部项目${nl}`,
      'sources/context.md': `# 方法${nl}以最新已审核报告为准，旧报告用于历史参考。${nl}`,
    };
    tasks.push({ id: 'research-source-' + index, category: 'research', files: sources,
      prompt: `研究 sources/ 的材料，确定 P${index} 的最新已审核总数。写 result.json，字段 project、total、source（相对路径）、limitation（原文范围句）。依据材料解决冲突。`,
      check(workspace) { const value = json(workspace, 'result.json') as Record<string, unknown> | undefined; return [{ name: 'latest audited source and provenance', passed: value?.project === 'P' + index && value.total === target && value.source === 'sources/current.md' && value.limitation === '本地样本，不代表全部项目' }]; },
    });
  }
  const documents = [
    { id: 'release-notes', source: '产品 Orion。版本 2.1。修复断线后任务丢失。新增任务恢复。', filename: 'release.md', terms: ['Orion', '2.1', '断线', '恢复'], goal: '生成含标题、修复、功能三个部分的 Markdown 发布说明' },
    { id: 'csv-summary', source: 'name,amount\nA,12\nB,8\nC,5', filename: 'summary.json', terms: [], goal: '读取 CSV，输出 JSON 字段 count=3、total=25、largest="A"' },
    { id: 'checklist', source: '检查项：模型连接、工作区、权限、任务恢复。', filename: 'checklist.md', terms: ['- [ ] 模型连接', '- [ ] 工作区', '- [ ] 权限', '- [ ] 任务恢复'], goal: '生成四项未选中的 Markdown 清单，保留各项原名' },
    { id: 'table', source: 'Alpha 延迟 20ms；Beta 延迟 10ms；Gamma 延迟 30ms。', filename: 'comparison.md', terms: ['|', 'Alpha', 'Beta', 'Gamma', '10', '20', '30'], goal: '生成按延迟升序排列的 Markdown 对比表' },
    { id: 'translation', source: '连接关闭后任务继续运行。服务重启后需要用户恢复。', filename: 'guide.md', terms: ['task', 'restart', 'user', 'resume'], goal: '翻译为英文操作说明，保留继续运行及重启后用户恢复两点' },
    { id: 'structured', source: '名称 Nova；负责人 Lin；状态 ready；预算 15。', filename: 'project.json', terms: [], goal: '输出 JSON：name="Nova", owner="Lin", status="ready", budget=15' },
  ];
  for (const item of documents) tasks.push({ id: 'document-' + item.id, category: 'document', files: { 'input.txt': item.source.replaceAll('\\n', nl) },
    prompt: `根据 input.txt，${item.goal}。将产物写入 ${item.filename}。`,
    check(workspace) {
      const text = existsSync(join(workspace, item.filename)) ? readFileSync(join(workspace, item.filename), 'utf8') : '';
      const value = json(workspace, item.filename) as Record<string, unknown> | undefined;
      let passed = !!text && item.terms.every(term => text.toLowerCase().includes(term.toLowerCase()));
      if (item.id === 'csv-summary') passed = value?.count === 3 && value.total === 25 && value.largest === 'A';
      if (item.id === 'structured') passed = value?.name === 'Nova' && value.owner === 'Lin' && value.status === 'ready' && value.budget === 15;
      if (item.id === 'table') passed &&= text.indexOf('Beta') < text.indexOf('Alpha') && text.indexOf('Alpha') < text.indexOf('Gamma');
      return [{ name: 'document artifact requirements', passed }];
    },
  });
  for (let index = 1; 7 > index; index++) tasks.push({ id: 'recovery-ledger-' + index, category: 'recovery', files: { 'request.json': JSON.stringify({ id: 'order-' + index, amount: index * 7 }) },
    prompt: '读取 request.json；使用 append_record 将订单登记一次到 ledger.jsonl，再写 receipt.json，字段 id、amount 与输入相同，status="recorded"。同一订单不能重复登记。',
    check(workspace) {
      const receipt = json(workspace, 'receipt.json') as Record<string, unknown> | undefined;
      let rows: unknown[] = []; try { rows = readFileSync(join(workspace, 'ledger.jsonl'), 'utf8').trim().split(nl).filter(Boolean).map(line => JSON.parse(line)); } catch {}
      return [{ name: 'durable receipt', passed: receipt?.id === 'order-' + index && receipt.amount === index * 7 && receipt.status === 'recorded' }, { name: 'side effect occurred once', passed: rows.length === 1 && equal(rows[0], { id: 'order-' + index, amount: index * 7 }) }];
    },
  });
  const faults: NonNullable<ReleaseTask['fault']>[] = ['transient-read', 'schema-read', 'missing-path', 'version-conflict', 'truncated-read', 'invalid-json'];
  for (const [index, fault] of faults.entries()) tasks.push({ id: 'tool-failure-' + fault, category: 'tool-failure', fault,
    files: { 'source.json': fault === 'invalid-json' ? '{"value":42,}' : '{"value":42}', 'target.txt': 'status=old', 'guide.md': '若读取 source.json 失败，可重读或查找文件。target.txt 的旧值是 status=old。JSON 的尾逗号是输入格式问题。' },
    prompt: `读取 source.json 与 guide.md，处理输入或工具故障，将数值写 result.json（value 为数字），把 target.txt 改为 status=ready-${index + 1}。发生版本冲突时重新观察后再编辑。`,
    check(workspace) { const value = json(workspace, 'result.json') as Record<string, unknown> | undefined; return [{ name: 'recovered value', passed: value?.value === 42 }, { name: 'artifact updated after fault', passed: readFileSync(join(workspace, 'target.txt'), 'utf8').trim() === 'status=ready-' + (index + 1) }]; },
  });
  return tasks;
}
