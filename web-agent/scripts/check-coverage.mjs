#!/usr/bin/env node
/**
 * scripts/check-coverage.mjs —— 关键文件覆盖率门禁（逐文件，≥70%）
 *
 * 背景：质量审查 2026-11-21 P1-3 指出「整体 82% 很好看，但缺口恰好落在
 * 插件装载、沙箱、任务验收这些最容易被改坏的路径上」，并要求 CI 增设
 * 「指定文件最低行覆盖」的门。
 *
 * 实现要点：Node 的 `--test-reporter=lcov` 在跑全量套件（多进程并发）时只为
 * 末班进程产出记录，同一文件多次出现也只是覆盖写——直接看全量 lcov 会把
 * task-verifier 的 98% 摊成 23%。因此本脚本**按目标文件成组跑它自己的 spec**，
 * 每次采一份 lcov，再解析该文件的 LF/LH。这样每个数字都是「这些用例对这份源码」
 * 的真实命中率，回归时一眼能看出是谁的覆盖掉了。
 *
 * 用法：
 *   npm run check:coverage              判失败（CI 用）
 *   npm run check:coverage -- --update  只打印，不判失败（校准下限/排查用）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 关键文件 → 覆盖它的用例组。
 * 九个文件对应审查 P1-3 表格里的全部条目（`kernel/compact.ts` 实际位于
 * `core/chat/compact.ts`，审查写作 kernel 是笔误）。
 */
const TARGETS = [
  {
    file: 'kernel/validate.ts',
    specs: ['kernel/tests/coverage-gaps.spec.ts', 'kernel/tests/tool-contract.spec.ts'],
  },
  {
    file: 'kernel/task-verifier.ts',
    specs: ['kernel/tests/coverage-gaps.spec.ts', 'kernel/tests/task-verifier.spec.ts'],
  },
  {
    file: 'kernel/skillsSync.ts',
    specs: ['kernel/tests/coverage-gaps.spec.ts', 'kernel/tests/skills-sync.spec.ts'],
  },
  {
    file: 'kernel/sandbox.ts',
    specs: ['kernel/tests/sandbox.spec.ts', 'kernel/tests/plugin-fs-guard.spec.ts'],
  },
  {
    file: 'kernel/tool-discovery.ts',
    specs: ['kernel/tests/tool-discovery.spec.ts', 'kernel/tests/tool-catalog.spec.ts'],
  },
  {
    file: 'kernel/plugin-process.ts',
    specs: ['kernel/tests/process-plugin.spec.ts'],
  },
  {
    file: 'kernel/plugin-loader.ts',
    specs: ['kernel/tests/loader.spec.ts', 'kernel/tests/plugin-sdk.spec.ts', 'kernel/tests/plugin-snapshot.spec.ts'],
  },
  {
    file: 'server/routes/plugins.ts',
    specs: ['server/tests/plugin-routes.spec.ts'],
  },
  {
    file: 'core/chat/compact.ts',
    specs: ['core/chat/tests/compact.spec.ts'],
  },
  // v4 迁移各期新增的模块：谁被改坏就一眼能看出是哪组用例没跟上
  {
    file: 'server/run/state.ts',
    specs: ['server/tests/run-state.spec.ts', 'server/tests/run-service.spec.ts'],
  },
  {
    file: 'server/run/journal.ts',
    specs: ['server/tests/run-state.spec.ts', 'server/tests/run-service.spec.ts'],
  },
  {
    file: 'server/run/usage.ts',
    specs: [
      'server/tests/run-service.spec.ts',
      'server/tests/run-composition.spec.ts',
      'server/tests/run-strengthening.spec.ts',
      'server/tests/process-recovery.spec.ts',
    ],
  },
  {
    file: 'server/run/executor.ts',
    specs: [
      'server/tests/run-service.spec.ts',
      'server/tests/run-composition.spec.ts',
      'server/tests/run-strengthening.spec.ts',
      'server/tests/approval-recovery.spec.ts',
    ],
  },
  {
    file: 'server/run/executor-start.ts',
    specs: [
      'server/tests/run-service.spec.ts',
      'server/tests/run-composition.spec.ts',
      'server/tests/run-strengthening.spec.ts',
      'server/tests/approval-recovery.spec.ts',
    ],
  },
  {
    file: 'server/run/executor-flow.ts',
    specs: [
      'server/tests/run-service.spec.ts',
      'server/tests/run-composition.spec.ts',
      'server/tests/run-strengthening.spec.ts',
      'server/tests/approval-recovery.spec.ts',
    ],
  },
  {
    file: 'server/run/recovery.ts',
    specs: ['server/tests/recovery.spec.ts', 'server/tests/run-service.spec.ts', 'server/tests/process-recovery.spec.ts'],
  },
  {
    file: 'server/store/write-queue.ts',
    specs: ['server/tests/store-queue.spec.ts', 'server/tests/sqlite-crash.spec.ts'],
  },
  {
    file: 'server/http/security.ts',
    specs: ['server/tests/ssrf.spec.ts', 'server/tests/providers.spec.ts'],
  },
  {
    file: 'server/usecases/providers.ts',
    specs: ['server/tests/provider-usecases.spec.ts', 'server/tests/providers.spec.ts', 'server/tests/provider-diagnostics.spec.ts'],
  },
  {
    file: 'server/usecases/provider-models.ts',
    specs: ['server/tests/providers.spec.ts', 'server/tests/provider-models.spec.ts'],
  },
  {
    file: 'server/usecases/provider-support.ts',
    specs: ['server/tests/provider-diagnostics.spec.ts', 'server/tests/providers.spec.ts'],
  },
];

/** 每个文件的行覆盖下限（审查要求 ≥70%） */
const FLOOR = 70;

/** 解析一份 lcov，返回与目标文件匹配的记录（合并多条 SF 记录：DA 行号取并集） */
function readFileCoverage(lcovPath, target) {
  if (!existsSync(lcovPath)) return null;
  const raw = readFileSync(lcovPath, 'utf8').replace(/\r/g, '');
  let lines = 0;
  const hitLines = new Set();
  for (const block of raw.split('end_of_record')) {
    const sf = block.match(/^SF:([^\n]*)/m);
    if (!sf) continue;
    const path = sf[1].trim().replace(/\\/g, '/');
    if (!path.endsWith(target)) continue;
    for (const da of block.matchAll(/^DA:(\d+),(\d+)/gm)) {
      if (Number(da[2]) > 0) hitLines.add(Number(da[1]));
    }
    const lf = block.match(/^LF:(\d+)/m);
    if (lf) lines = Math.max(lines, Number(lf[1]));
  }
  return lines ? { lines, hit: hitLines.size } : null;
}

const work = mkdtempSync(join(tmpdir(), 'maharness-cov-'));
const rows = [];
const failures = [];

for (const target of TARGETS) {
  const lcovPath = join(work, `${target.file.replace(/[\\/]/g, '_')}.info`);
  const res = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=lcov',
      `--test-reporter-destination=${lcovPath}`,
      ...target.specs,
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
  if (res.status !== 0) {
    rows.push({ file: target.file, value: '用例失败', ok: false });
    failures.push(`${target.file}: 覆盖它的用例组执行失败（${target.specs.join(', ')}）`);
    continue;
  }
  const record = readFileCoverage(lcovPath, target.file);
  if (!record) {
    rows.push({ file: target.file, value: '未被加载', ok: false });
    failures.push(`${target.file}: 用例组没有加载该文件`);
    continue;
  }
  const value = (record.hit / record.lines) * 100;
  const ok = value >= FLOOR;
  rows.push({ file: target.file, value: `${value.toFixed(2)}%（${record.hit}/${record.lines}）`, ok, specs: target.specs.length });
  if (!ok) failures.push(`${target.file}: ${value.toFixed(2)}% < ${FLOOR}%`);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n[coverage] 关键文件行覆盖（下限 ${FLOOR}%，逐文件跑自己的用例组）：`);
for (const row of rows) console.log(`  ${row.ok ? '✓' : '✗'} ${row.file} ${row.value}${row.specs ? `，${row.specs} 个 spec 文件` : ''}`);

if (process.argv.includes('--update')) {
  console.log('\n[coverage] --update 模式：仅报告，不判失败');
  process.exit(0);
}
if (failures.length) {
  console.error(`\n[coverage] 未达标 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\n[coverage] 明细口径：scripts/check-coverage.mjs 文件头注释');
  process.exit(1);
}
console.log('\n[coverage] 全部达标');
if (existsSync(join(ROOT, 'coverage'))) mkdirSync(join(ROOT, 'coverage'), { recursive: true });
