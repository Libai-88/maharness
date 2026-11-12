import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, memoryScore } from '../index';
import { buildFact } from '../schema';

describe('记忆召回评分', () => {
  it('余弦相似度处理同向、正交和维度不一致', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });

  it('向量召回优先选择语义更近的事实', () => {
    const now = Date.now();
    const close = buildFact('close', '项目使用 TypeScript', now, { confidence: 0.8 });
    const far = buildFact('far', '项目使用 Python', now, { confidence: 0.8 });
    const scoreClose = memoryScore('技术栈', close, [1, 0], [0.99, 0.01]);
    const scoreFar = memoryScore('技术栈', far, [1, 0], [0.1, 0.99]);
    assert.ok(scoreClose > scoreFar);
  });

  it('无向量时回退 bigram，不相关内容为 0', () => {
    const fact = buildFact('bigram', '项目使用 TypeScript 和 React', Date.now(), { confidence: 0.5 });
    assert.ok(memoryScore('TypeScript 版本', fact) > 0);
    assert.equal(memoryScore('今晚吃什么', fact), 0);
  });
});
