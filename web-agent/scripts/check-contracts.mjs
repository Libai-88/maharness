#!/usr/bin/env node
/**
 * 契约单一来源门禁（ADR 0009）。
 *
 * 单一来源是 `contracts/api.ts`（纯类型 + 常量，自身不 import 任何运行时模块）。
 * `ui/src/generated/contracts.ts` 是逐字生成物，只读不手改：两者不一致即失败，
 * 因此"前端类型和后端类型各不相同步"从人的记忆问题变成编译期/CI 问题。
 *
 * 用法：
 *   node scripts/check-contracts.mjs          # 校验（CI 用）
 *   node scripts/check-contracts.mjs --write  # 重新生成
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = resolve(ROOT, 'contracts/api.ts');
const TARGET = resolve(ROOT, 'ui/src/generated/contracts.ts');
const BANNER = `// 生成物，请勿手改。源：contracts/api.ts（node scripts/check-contracts.mjs --write）\n\n`;
const args = process.argv.slice(2);
const write = args.includes('--write');

if (!existsSync(SOURCE)) {
  console.log('契约源 contracts/api.ts 尚未建立：门禁骨架就绪，跳过校验（不阻断）。');
  process.exit(0);
}

const source = readFileSync(SOURCE, 'utf8');
const expected = BANNER + source;
const actual = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';

if (write) {
  mkdirSync(resolve(TARGET, '..'), { recursive: true });
  writeFileSync(TARGET, expected, 'utf8');
  console.log('已生成 ui/src/generated/contracts.ts');
  process.exit(0);
}

if (!actual) {
  console.log('缺少 ui/src/generated/contracts.ts，请运行 node scripts/check-contracts.mjs --write');
  process.exit(1);
}

if (actual !== expected) {
  console.log('契约漂移：ui/src/generated/contracts.ts 与 contracts/api.ts 不一致。');
  console.log('修复：node scripts/check-contracts.mjs --write');
  process.exit(1);
}

console.log(`契约一致：contracts/api.ts → ui/src/generated/contracts.ts（${source.split('\n').length} 行）`);
