import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearxngResults, resolveSearchProvider } from '../index';

describe('SearXNG 搜索 provider', () => {
  it('按 SearXNG → Tavily → DuckDuckGo 选择 provider', () => {
    assert.equal(resolveSearchProvider({ SEARXNG_BASE_URL: 'http://127.0.0.1:8080', TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv), 'searxng');
    assert.equal(resolveSearchProvider({ TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv), 'tavily');
    assert.equal(resolveSearchProvider({} as NodeJS.ProcessEnv), 'duckduckgo');
  });

  it('解析 SearXNG JSON 结果并过滤非法项', () => {
    const results = parseSearxngResults({
      results: [
        { title: 'A', url: 'https://a.example', content: 'x'.repeat(800) },
        { title: 'missing url' },
        { title: 'B', url: 'https://b.example', snippet: 'brief' },
        null,
      ],
    }, 5);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.title, 'A');
    assert.equal(results[0]?.snippet.length, 500);
    assert.equal(results[1]?.url, 'https://b.example');
    assert.equal(results[1]?.snippet, 'brief');
  });

  it('无 results 字段时返回空数组', () => {
    assert.deepEqual(parseSearxngResults({}, 5), []);
  });
});
