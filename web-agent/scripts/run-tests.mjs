#!/usr/bin/env node
/**
 * scripts/run-tests.mjs —— 单测入口（枚举测试文件后交给 node:test）
 *
 * 为什么不直接把 glob 交给 node --test（缺陷 B14）：
 * 插件加载会把插件目录按内容镜像成 `name@hash` 运行时快照（kernel/plugin-snapshot.ts）。
 * 旧写法用形如 core/星号/tests 的 glob，会把这些**快照副本**也当源码测试：
 *  1) 副本内容取决于「上次加载时的目录内容」，与当前工作树可能不一致（脏快照），
 *     同一份 spec 于是会用旧实现跑一遍——失败与否取决于磁盘残留，结果不可复现；
 *  2) 用例数随快照数量漂移（实测同一命令在不同时刻报 362 / 438 / 539）。
 * 这里显式跳过 `@<10位十六进制>` 快照目录，只测真实源码树，用例数从此稳定。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 插件内容快照目录名（与 kernel/plugin-snapshot.ts 的 SNAPSHOT_SUFFIX 一致） */
const SNAPSHOT_DIR = /@[0-9a-f]{10}$/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'coverage']);

/** 递归收集 *.spec.ts；跳过依赖目录与插件内容快照 */
function collectTestFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name) || SNAPSHOT_DIR.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (/\.spec\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 测试根：内核 / server / 内置插件 / 现场插件（ui 的 e2e 走 npm run e2e，不在此列） */
const roots = ['kernel', 'server', 'core', 'plugins'].map((r) => join(ROOT, r));

const files = [];
for (const r of roots) collectTestFiles(r, files);
files.sort();

if (files.length === 0) {
  console.error('[test] 未找到任何 *.spec.ts');
  process.exit(1);
}

console.log(`[test] ${files.length} 个测试文件（已排除插件内容快照 @<hash> 目录）`);
const res = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
});
process.exit(res.status ?? 1);
