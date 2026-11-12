import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReview } from '../index';

describe('审查结构化输出解析', () => {
  it('解析合法 JSON 并标记 parsed', () => {
    const review = parseReview(JSON.stringify({
      verdict: 'concern',
      summary: '有一处缺陷',
      issues: [{ severity: 'major', point: '缺少验证', evidence: 'file.ts' }],
      confidence: 0.7,
    }));
    assert.equal(review.parsed, true);
    assert.equal(review.verdict, 'concern');
    assert.equal(review.confidence, 0.7);
    assert.equal(review.issues.length, 1);
  });

  it('容忍代码围栏和前后说明', () => {
    const review = parseReview('结论如下：\n```json\n{"verdict":"pass","summary":"通过","issues":[],"confidence":0.9}\n```');
    assert.equal(review.parsed, true);
    assert.equal(review.verdict, 'pass');
  });

  it('缺少字段时标记 parsed=false', () => {
    const review = parseReview('{"verdict":"pass","summary":"通过"}');
    assert.equal(review.parsed, false);
  });

  it('完全非 JSON 时降级为 concern', () => {
    const review = parseReview('这是一段普通文本，不是 JSON');
    assert.equal(review.parsed, false);
    assert.equal(review.verdict, 'concern');
    assert.equal(review.confidence, 0);
  });
});
