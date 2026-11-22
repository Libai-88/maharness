#!/usr/bin/env node
/**
 * 复杂度预算门禁（ADR 0011）。
 *
 * 行数会被格式化宽度污染（同一文件在 100 列/140 列下差几百行），所以拆分判据改用
 * "文件行数 + 单函数行数 + 圈复杂度 + 导出数" 四项，并配一份只降不升的基线。
 * 基线只登记当前已超标的文件；新文件超标即失败，老文件只允许降到阈值以下。
 *
 * 用法：
 *   node scripts/check-complexity.mjs                # 校验（CI 用）
 *   node scripts/check-complexity.mjs --report       # 只报告，不改变退出码
 *   node scripts/check-complexity.mjs --update-baseline
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASELINE_PATH = resolve(ROOT, '../plan/complexity-baseline.json');
const SCAN_DIRS = ['kernel', 'core', 'server', 'scripts', 'ui/src', 'ui/e2e', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor', 'data', 'build', 'coverage', 'generated']);

const LIMITS = { lines: 400, functionLines: 60, complexity: 15, exports: 12 };

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const reportOnly = args.includes('--report');

/** 递归收集源文件，跳过依赖、产物与快照目录。 */
function collect(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(abs, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      // `name@hash` 是插件快照，与源目录内容重复
      if (entry.includes('@') || entry === 'tests' || entry === '__tests__') continue;
      collect(relative(ROOT, full), out);
      continue;
    }
    // 测试文件不设函数长度约束：describe 天生是长函数，纳入只会制造噪声
    if (!/\.(ts|tsx|mts)$/.test(entry) || entry.endsWith('.d.ts')) continue;
    if (/\.(spec|test|bench)\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/** 单文件四项指标；函数指标取该文件内最差的一个函数。 */
function measure(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  let worstFunction = 0;
  let worstComplexity = 0;
  let exports = 0;

  const lineSpan = (node) => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
    return end - start + 1;
  };

  const visit = (node) => {
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports += 1;
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) exports += 1;

    if (FUNCTION_KINDS.has(node.kind)) {
      const span = lineSpan(node);
      // 只有函数体或区块比较长的节点才值得统计复杂度，避免把一行 lambda 计入
      if (span > worstFunction) worstFunction = span;
      const complexity = 1 + countBranches(node);
      if (span >= 8 && complexity > worstComplexity) worstComplexity = complexity;
    }
    ts.forEachChild(node, visit);
  };

  const countBranches = (fn) => {
    let total = 0;
    const walk = (node) => {
      if (node !== fn && FUNCTION_KINDS.has(node.kind)) return; // 嵌套函数单独统计
      if (BRANCH_KINDS.has(node.kind)) total += 1;
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
          total += 1;
      }
      ts.forEachChild(node, walk);
    };
    walk(fn);
    return total;
  };

  visit(source);
  return { lines: lineCount, functionLines: worstFunction, complexity: worstComplexity, exports };
}

function violationsOf(metrics) {
  const out = [];
  if (metrics.lines > LIMITS.lines) out.push('lines');
  if (metrics.functionLines > LIMITS.functionLines) out.push('functionLines');
  if (metrics.complexity > LIMITS.complexity) out.push('complexity');
  if (metrics.exports > LIMITS.exports) out.push('exports');
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => collect(dir));
const measured = new Map();
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  measured.set(rel, measure(file));
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
const errors = [];
const warnings = [];
const nextBaseline = {};

for (const [rel, metrics] of measured) {
  const violations = violationsOf(metrics);
  const allowed = baseline[rel];

  if (!violations.length) {
    if (allowed) warnings.push(`${rel} 已达标，可从基线移除`);
    continue;
  }

  if (!allowed) {
    errors.push(`${rel} 新增超标：${violations.map((key) => `${key}=${metrics[key]}`).join(' ')}`);
    nextBaseline[rel] = metrics;
    continue;
  }

  const regressed = violations.filter((key) => metrics[key] > allowed[key]);
  if (regressed.length) {
    errors.push(`${rel} 超标恶化：${regressed.map((key) => `${key} ${allowed[key]} → ${metrics[key]}`).join('，')}`);
  }
  // 基线只降不升：实测更好时按实测值收窄
  nextBaseline[rel] = {
    ...allowed,
    ...Object.fromEntries(violations.map((key) => [key, metrics[key]])),
    lines: Math.min(allowed.lines, metrics.lines),
  };
}

for (const rel of Object.keys(baseline)) if (!measured.has(rel)) warnings.push(`${rel} 已不存在，可从基线移除`);

if (updateBaseline) {
  // 只保留仍然超标的文件，且写入实测值（不含历史虚高）
  const pruned = {};
  for (const [rel, metrics] of measured) if (violationsOf(metrics).length) pruned[rel] = metrics;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(pruned, null, 1)}\n`, 'utf8');
  console.log(`复杂度基线已更新：${Object.keys(pruned).length} 个文件超标（阈值 ${JSON.stringify(LIMITS)}）`);
  process.exit(0);
}

const worst = [...measured.entries()]
  .sort((a, b) => b[1].functionLines - a[1].functionLines)
  .slice(0, 5)
  .map(([rel, metrics]) => `  ${metrics.functionLines} 行/函数 · 复杂度 ${metrics.complexity} · ${rel}`);

console.log(`复杂度扫描：${measured.size} 个文件，基线 ${Object.keys(baseline).length} 个超标文件`);
console.log(`阈值：文件 ${LIMITS.lines} 行 / 函数 ${LIMITS.functionLines} 行 / 圈复杂度 ${LIMITS.complexity} / 导出 ${LIMITS.exports}`);
console.log('最长函数（仅供参考）：');
for (const line of worst) console.log(line);

for (const warning of warnings) console.log(`warn: ${warning}`);
for (const error of errors) console.log(`error: ${error}`);

if (errors.length && !reportOnly) {
  console.log(`\n复杂度门禁失败：${errors.length} 个文件超出基线。`);
  process.exit(1);
}
console.log(errors.length ? `\n报告模式：${errors.length} 个问题（不阻断）` : '\n复杂度门禁通过。');
