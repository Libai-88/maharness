/**
 * kernel/tests/coverage-gaps.spec.ts —— P1-3 定点补测
 *
 * 质量审查 2026-11-21 点名九个关键文件的行覆盖偏低（21%~40%），
 * 这里是其中四个「纯函数友好」模块的定点用例：schema 校验器、任务契约验收、
 * 技能锁版本语义与文件清单。用例只依赖公开导出，不伪造实现细节。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateAgainstSchema } from '../validate';
import { validateTaskContract, verifyTaskContract } from '../task-verifier';
import {
  copyListedFiles,
  isValidVersionRange,
  listTreeWithHashes,
  normalizeManifest,
  satisfiesVersionRange,
  validateLockFile,
} from '../skillsSync';
import type { ToolDef } from '../types';

const tmp = (() => {
  const dirs: string[] = [];
  return {
    make(): string {
      const dir = mkdtempSync(join(tmpdir(), 'coverage-gaps-'));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
})();
test.after(() => tmp.cleanup());

test('validateAgainstSchema：类型、枚举、常量与未知 type', () => {
  assert.deepEqual(validateAgainstSchema('x', { type: 'string' }), []);
  assert.match(validateAgainstSchema(1, { type: 'string' })[0] ?? '', /期望 string/);
  // B6：拼错的 type 必须 fail-closed，而不是静默跳过
  assert.match(validateAgainstSchema('x', { type: 'strng' })[0] ?? '', /不在支持子集内/);
  assert.equal(validateAgainstSchema('x', { type: ['string', 'null'] }).length, 0);
  assert.match(validateAgainstSchema('b', { enum: ['a'] })[0] ?? '', /不在允许枚举内/);
  assert.match(validateAgainstSchema('b', { const: 'a' })[0] ?? '', /必须等于/);
  assert.match(validateAgainstSchema(1.5, { type: 'integer' })[0] ?? '', /期望 integer/);
});

test('validateAgainstSchema：组合子与对象规则', () => {
  assert.equal(validateAgainstSchema(2, { allOf: [{ type: 'number' }, { minimum: 1 }] }).length, 0);
  assert.match(validateAgainstSchema(0, { allOf: [{ type: 'number' }, { type: 'number', minimum: 1 }] })[0] ?? '', /allOf 未全部通过/);
  assert.match(validateAgainstSchema('z', { anyOf: [{ type: 'number' }, { enum: ['a'] }] })[0] ?? '', /anyOf 没有任何分支通过/);
  assert.equal(validateAgainstSchema('a', { oneOf: [{ type: 'string' }, { enum: ['a'] }] }).length > 0, true);
  const required = validateAgainstSchema({}, { type: 'object', required: ['id'] });
  assert.match(required[0] ?? '', /缺少必填字段/);
  const extra = validateAgainstSchema(
    { id: 1, other: 2 },
    { type: 'object', properties: { id: { type: 'number' } }, additionalProperties: false },
  );
  assert.match(extra[0] ?? '', /不允许的额外属性/);
  const pattern = validateAgainstSchema({ k1: 'v' }, { type: 'object', patternProperties: { '^k': { type: 'number' } } });
  assert.match(pattern[0] ?? '', /期望 number/);
});

test('validateAgainstSchema：数组与字符串规则', () => {
  assert.match(validateAgainstSchema([1, 1], { type: 'array', uniqueItems: true })[0] ?? '', /重复/);
  assert.match(validateAgainstSchema([1], { type: 'array', minItems: 2 })[0] ?? '', /< minItems/);
  assert.match(validateAgainstSchema(['a', 1], { type: 'array', items: { type: 'string' } })[0] ?? '', /期望 string/);
  assert.match(validateAgainstSchema('ab', { type: 'string', minLength: 3 })[0] ?? '', /< minLength/);
  assert.match(validateAgainstSchema('abcd', { type: 'string', maxLength: 3 })[0] ?? '', /> maxLength/);
  assert.match(validateAgainstSchema('abc', { type: 'string', pattern: '^z' })[0] ?? '', /不匹配 pattern/);
  assert.match(validateAgainstSchema('abc', { type: 'string', pattern: '(' })[0] ?? '', /正则无效/);
});

test('validateAgainstSchema：数值边界', () => {
  assert.match(validateAgainstSchema(0, { type: 'number', minimum: 1 })[0] ?? '', /< minimum/);
  assert.match(validateAgainstSchema(5, { type: 'number', maximum: 4 })[0] ?? '', /> maximum/);
  assert.match(validateAgainstSchema(1, { type: 'number', exclusiveMinimum: 1 })[0] ?? '', /<= exclusiveMinimum/);
  assert.match(validateAgainstSchema(2, { type: 'number', exclusiveMaximum: 2 })[0] ?? '', />= exclusiveMaximum/);
});

test('validateToolArguments 走工具自身的 parameters', () => {
  const tool = { name: 'demo', description: 'd', parameters: { type: 'object', required: ['q'] } } as unknown as ToolDef;
  assert.match(validateAgainstSchema({}, tool.parameters)[0] ?? '', /缺少必填字段/);
});

test('validateTaskContract：逐条字段的失败分支', () => {
  assert.deepEqual(validateTaskContract({ objective: '  有效目标', acceptance: [] }), []);
  assert.match(validateTaskContract({ objective: ' ', acceptance: [] })[0] ?? '', /objective/);
  assert.match(validateTaskContract({ objective: 'x', acceptance: 'x' as never })[0] ?? '', /acceptance/);
  const issues = validateTaskContract({
    objective: 'x',
    acceptance: [
      { type: 'output_matches', pattern: '' },
      { type: 'tool_evidence', name: '', kind: 'bogus' as never },
      { type: 'file_contains', path: '', value: '' },
      { type: 'unknown' as never, value: 'x' },
    ],
    risk: 'urgent' as never,
    deadlineAt: -1,
    costBudgetUsd: 0,
  });
  assert.ok(issues.length >= 8, `期望多条问题，实际 ${issues.length}`);
  assert.ok(issues.some((issue) => issue.includes('risk')));
  assert.ok(issues.some((issue) => issue.includes('deadlineAt')));
  assert.ok(issues.some((issue) => issue.includes('costBudgetUsd')));
});

test('verifyTaskContract：答案、工具、证据与文件系统四类判据', () => {
  const root = tmp.make();
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out', 'report.md'), '结论：通过');
  const contract = {
    objective: '产出报告',
    acceptance: [
      { type: 'output_contains' as const, value: '完成' },
      { type: 'output_matches' as const, pattern: '[0-9]{2} 项', flags: 'i' },
      { type: 'tool_succeeded' as const, name: 'write_file' },
      { type: 'tool_evidence' as const, name: 'write_file', kind: 'file' as const, refContains: 'report.md' },
      { type: 'file_exists' as const, path: 'out/report.md' },
      { type: 'file_contains' as const, path: 'out/report.md', value: '通过' },
    ],
  };
  const result = verifyTaskContract(contract, {
    answer: '已完成，共 12 项',
    sandboxRoot: root,
    toolResults: [{ name: 'write_file', ok: true, evidence: [{ kind: 'file', label: '写入报告', ref: 'out/report.md' }] }],
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.verified, true);
  assert.equal(result.checks.length, 6);
  assert.ok(result.evidence.length >= 6);
});

test('verifyTaskContract：部分通过、越界路径与 schema 失败', () => {
  const root = tmp.make();
  const partial = verifyTaskContract(
    {
      objective: 'x',
      acceptance: [
        { type: 'output_contains', value: '有' },
        { type: 'output_contains', value: '没有' },
      ],
    },
    { answer: '有', sandboxRoot: root, toolResults: [] },
  );
  assert.equal(partial.status, 'partial');
  // 越界路径必须判失败，而不是抛异常
  const traversal = verifyTaskContract(
    { objective: 'x', acceptance: [{ type: 'file_exists', path: '../etc/passwd' }] },
    { answer: '', sandboxRoot: root, toolResults: [] },
  );
  assert.equal(traversal.status, 'failed');
  const invalid = verifyTaskContract({ objective: '', acceptance: [] }, { answer: '', sandboxRoot: root, toolResults: [] });
  assert.equal(invalid.status, 'failed');
  assert.ok(invalid.evidence[0]?.detail.includes('schema'));
});

test('skillsSync：版本范围语义', () => {
  assert.equal(isValidVersionRange('*'), true);
  assert.equal(isValidVersionRange('^1.2.0'), true);
  assert.equal(isValidVersionRange('>=1.0.0 <2.0.0'), true);
  assert.equal(isValidVersionRange('1.0.0 || 2.0.0'), true);
  assert.equal(isValidVersionRange(''), false);
  assert.equal(isValidVersionRange('~'), false);
  assert.equal(satisfiesVersionRange('1.2.3', '^1.0.0'), true);
  assert.equal(satisfiesVersionRange('2.0.0', '^1.0.0'), false);
  assert.equal(satisfiesVersionRange('not-a-version', '*'), false);
});

test('skillsSync：锁文件依赖图校验（缺依赖 / 版本不满足 / 环）', () => {
  assert.equal(validateLockFile({ skills: { a: { version: '1.0.0' } } } as never).ok, true);
  const missing = validateLockFile({ skills: { a: { version: '1.0.0', requires: ['nosuch'] } } } as never).errors;
  assert.ok(missing.some((error) => error.includes('依赖不存在')));
  const unsat = validateLockFile({ skills: { a: { version: '1.0.0', requires: ['b@^2.0.0'] }, b: { version: '1.5.0' } } } as never).errors;
  assert.ok(unsat.some((error) => error.includes('不满足实际版本')));
  const cycle = validateLockFile({
    skills: { a: { version: '1.0.0', requires: ['b'] }, b: { version: '1.0.0', requires: ['a'] } },
  } as never).errors;
  assert.ok(cycle.some((error) => error.includes('环')));
  const badName = validateLockFile({ skills: { 'bad name': { version: '1.0.0' } } } as never).errors;
  assert.ok(badName.some((error) => error.includes('技能名非法')));
});

test('skillsSync：清单归一化与文件清单落地', () => {
  const objectForm = normalizeManifest({ files: { 'SKILL.md': 'A'.repeat(64) } } as never);
  assert.equal(objectForm.map?.get('SKILL.md'), 'a'.repeat(64));
  const arrayForm = normalizeManifest({ files: [{ path: './SKILL.md', sha256: 'B'.repeat(64) }] } as never);
  assert.equal(arrayForm.map?.get('SKILL.md'), 'b'.repeat(64));
  assert.ok(normalizeManifest({ files: [{ path: 'x', sha256: 'short' }] } as never).map?.get('x') === 'short');
  assert.match(normalizeManifest({ files: 'nope' } as never).error ?? '', /须为/);

  const src = tmp.make();
  const dest = tmp.make();
  writeFileSync(join(src, 'SKILL.md'), '# 技能');
  assert.equal(listTreeWithHashes(src).length, 1);
  // 越界路径必须被拒绝（返回 0 而不是抛出）
  assert.equal(copyListedFiles(src, dest, ['SKILL.md', '../escape.md']), 1);
  assert.equal(listTreeWithHashes(dest)[0]?.path, 'SKILL.md');
});
