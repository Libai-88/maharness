import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeSearchResults, rerankSearchResults } from '../index';

describe('搜索结果去重与本地重排', () => {
  test('同一 URL 的 hash/尾斜杠/大小写差异只保留首条', () => {
    const results = dedupeSearchResults([
      { title: 'A', url: 'https://Example.com/docs/', snippet: '' },
      { title: 'B', url: 'https://example.com/docs#intro', snippet: '' },
      { title: 'C', url: 'https://example.com/other', snippet: '' },
    ]);
    assert.deepEqual(
      results.map((item) => item.title),
      ['A', 'C'],
    );
  });

  test('标题命中优先于摘要命中，稳定保留同分原顺序', () => {
    const results = rerankSearchResults('agent memory', [
      { title: '无关文章', url: 'https://example.com/a', snippet: 'agent memory 的简介' },
      { title: 'Agent Memory 指南', url: 'https://example.com/b', snippet: '正文' },
      { title: '另一篇', url: 'https://example.com/c', snippet: '正文' },
    ]);
    assert.deepEqual(
      results.map((item) => item.title),
      ['Agent Memory 指南', '无关文章', '另一篇'],
    );
  });

  test('中文查询按连续片段计分', () => {
    const results = rerankSearchResults('多代理 编排', [
      { title: '普通并发', url: 'https://example.com/a', snippet: '多代理编排' },
      { title: '多代理编排实践', url: 'https://example.com/b', snippet: '正文' },
    ]);
    assert.equal(results[0]?.title, '多代理编排实践');
  });
});
