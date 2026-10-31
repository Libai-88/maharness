import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, scoreErrorCorpus, shouldRetry } from '../error-policy';
import { LLMHttpError, parseRetryAfterMs } from '../../core/chat/provider-health';

describe('统一错误分类与重试策略', () => {
  test('401/403 归类为认证错误且不重试', () => {
    const e = classifyError(new LLMHttpError(401, 'unauthorized'));
    assert.equal(e.category, 'auth');
    assert.equal(e.retryable, false);
    assert.equal(shouldRetry(e.cause, 0), false);
  });
  test('限流与服务端错误按瞬时错误退避重试', () => {
    const e = classifyError(new LLMHttpError(429, 'rate limited'));
    assert.equal(e.category, 'transient');
    assert.equal(e.retryDelayMs, 2000);
    assert.equal(shouldRetry(e.cause, 0), true);
    assert.equal(shouldRetry(e.cause, 1), false);
  });
  test('尊重上游 Retry-After，并限制异常长的等待', () => {
    const retryAfter = new LLMHttpError(429, 'rate limited', 4_250);
    assert.equal(classifyError(retryAfter).retryDelayMs, 4_250);
    assert.equal(parseRetryAfterMs('1.5'), 1_500);
    const now = Date.parse('2026-10-31T00:00:00.000Z');
    assert.equal(parseRetryAfterMs('Sat, 31 Oct 2026 00:00:02 GMT', now), 2_000);
    assert.equal(parseRetryAfterMs('-1'), undefined);
    assert.equal(parseRetryAfterMs('999999'), 300_000);
  });
  test('参数与业务错误保留原始 cause 且不重试', () => {
    const cause = new Error('参数错误: schema');
    const e = classifyError(cause);
    assert.equal(e.category, 'parameter');
    assert.equal(e.cause, cause);
    assert.equal(shouldRetry(cause, 0), false);
  });
  test('网络瞬时错误可重试，未知错误默认不重试', () => {
    assert.equal(classifyError(new Error('ECONNRESET')).category, 'transient');
    assert.equal(shouldRetry(new Error('ECONNRESET'), 0), true);
    assert.equal(classifyError(new Error('模型返回了奇怪结果')).category, 'unknown');
    assert.equal(shouldRetry(new Error('模型返回了奇怪结果'), 0), false);
  });

  test('固定错误集宏 F1 达到 0.85 且每类均有覆盖', () => {
    const cases = [
      { message: 'gateway timeout', expected: 'transient' as const }, { message: 'ECONNRESET', expected: 'transient' as const },
      { message: 'unauthorized', status: 401, expected: 'auth' as const }, { message: 'forbidden', status: 403, expected: 'auth' as const },
      { message: 'permission denied by workspace policy', expected: 'auth' as const }, { message: 'invalid api key', expected: 'auth' as const },
      { message: 'invalid schema', expected: 'parameter' as const }, { message: '参数错误', expected: 'parameter' as const },
      { message: 'tool not found: read_file', expected: 'parameter' as const }, { message: 'HTTP invalid request body', expected: 'parameter' as const },
      { message: 'quota exceeded', expected: 'business' as const }, { message: '内容审核拒绝', expected: 'business' as const },
      { message: 'business rule rejected the transfer', expected: 'business' as const }, { message: '用户拒绝该操作', expected: 'business' as const },
      { message: '用户停止', expected: 'aborted' as const }, { message: 'This operation was aborted', expected: 'aborted' as const },
      { message: 'AbortError', expected: 'aborted' as const },
      { message: '模型返回了奇怪结果', expected: 'unknown' as const }, { message: 'unexpected provider state', expected: 'unknown' as const },
      { message: 'opaque failure 78', expected: 'unknown' as const },
    ];
    const score = scoreErrorCorpus(cases);
    for (const item of cases) {
      const cause = Object.assign(new Error(item.message), 'status' in item ? { status: item.status } : {});
      assert.equal(classifyError(cause).category, item.expected, item.message);
      assert.equal(classifyError(cause).cause, cause);
    }
    assert.equal(score.total, 20);
    assert.ok(score.macroF1 >= 0.85, `macro F1=${score.macroF1}`);
    assert.equal(score.correct, 20);
    assert.ok(Object.values(score.perCategory).every((metric) => metric.recall > 0), '每个类别必须有标注样本');
  });
});
