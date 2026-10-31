import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTaskContract, verifyTaskContract } from '../task-verifier';

describe('task verifier', () => {
  test('运行时 schema 拒绝损坏的任务契约', () => {
    assert.deepEqual(validateTaskContract({ objective: '', acceptance: [{ type: 'unknown' } as never], risk: 'urgent' as never }), [
      'objective 必须是非空字符串',
      'risk 必须是 low/medium/high',
      'acceptance[0].type 不受支持',
    ]);
    const result = verifyTaskContract({ objective: '', acceptance: [{ type: 'output_contains', value: '' }] }, {
      answer: 'done', toolResults: [], sandboxRoot: process.cwd(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.verified, false);
    assert.ok(result.evidence[0]?.detail.includes('schema'));
  });

  test('运行时 schema 校验推断置信度，拒绝越界值', () => {
    assert.deepEqual(validateTaskContract({ objective: 'x', acceptance: [], inference: {
      confidence: 2, basis: 'inferred', needsConfirmation: true, rationale: 'x',
    } }), ['inference.confidence 必须是 0 到 1 之间的数']);
  });
  test('没有验收条件不能证明完成', () => {
    const result = verifyTaskContract({ objective: 'finish', acceptance: [] }, {
      answer: 'done', toolResults: [], sandboxRoot: process.cwd(),
    });
    assert.equal(result.verified, false);
    assert.equal(result.status, 'failed');
  });
  test('验证文本、工具和文件条件', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-task-'));
    try {
      mkdirSync(join(root, 'out'));
      writeFileSync(join(root, 'out', 'result.txt'), '完成：42', 'utf8');
      const result = verifyTaskContract({
        objective: '生成结果',
        acceptance: [
          { type: 'output_contains', value: '完成' },
          { type: 'output_matches', pattern: '42' },
          { type: 'tool_succeeded', name: 'write_file' },
          { type: 'file_exists', path: 'out/result.txt' },
          { type: 'file_contains', path: 'out/result.txt', value: '42' },
        ],
      }, { answer: '完成：42', toolResults: [{ name: 'write_file', ok: true }], sandboxRoot: root });
      assert.equal(result.verified, true);
      assert.equal(result.status, 'verified');
      assert.equal(result.evidence.length, 5);
      assert.ok(result.evidence.every((e) => e.detail.length > 0));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('一部分条件满足时返回 partial 并保留每项证据', () => {
    const result = verifyTaskContract({ objective: '部分完成', acceptance: [
      { type: 'output_contains', value: 'ready' },
      { type: 'tool_succeeded', name: 'publish' },
    ] }, { answer: 'ready', toolResults: [], sandboxRoot: process.cwd() });
    assert.equal(result.status, 'partial');
    assert.equal(result.verified, false);
    assert.deepEqual(result.checks.map((c) => c.ok), [true, false]);
    assert.equal(result.evidence.length, 2);
  });

  test('正则验证异常仍保留与检查项一一对应的证据顺序', () => {
    const result = verifyTaskContract({ objective: 'regex error', acceptance: [
      { type: 'output_matches', pattern: '[' },
      { type: 'output_contains', value: 'later' },
    ] }, { answer: 'later', toolResults: [], sandboxRoot: process.cwd() });
    assert.deepEqual(result.checks.map((c) => c.ok), [false, true]);
    assert.equal(result.evidence.length, result.checks.length);
    assert.equal(result.evidence[0]?.source, 'answer');
    assert.equal(result.evidence[1]?.detail, '答案包含：later');
  });

  test('拒绝越界文件条件', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-task-'));
    try {
      const result = verifyTaskContract({ objective: '越界', acceptance: [{ type: 'file_exists', path: '../secret' }] }, {
        answer: '', toolResults: [], sandboxRoot: root,
      });
      assert.equal(result.verified, false);
      assert.match(result.checks[0].reason ?? '', /越界/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
