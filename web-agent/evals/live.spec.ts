import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runLiveEval } from './live';

describe('真实模型 live 评测', () => {
  test('采样答案后由 judge 返回分数并生成报告', async (t) => {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model?: string;
          messages?: { role?: string; content?: string }[];
        };
        const isJudge = body.messages?.[0]?.content?.includes('评测员') === true;
        const content = isJudge ? '{"score":5,"pass":true,"reason":"覆盖了关键点"}' : '这是候选回答，覆盖关键点。';
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: isJudge ? 20 : 10, completion_tokens: isJudge ? 5 : 8 },
          }),
        );
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const report = await runLiveEval({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'answer-model',
      budgetUsd: 1,
      prices: { 'answer-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      cases: [
        { name: 'a', prompt: '问题 A', rubric: ['标准 1'] },
        { name: 'b', prompt: '问题 B', rubric: ['标准 2'] },
      ],
    });
    assert.equal(report.cases.length, 2);
    assert.equal(report.passRate, 1);
    assert.equal(report.averageScore, 5);
    assert.ok(report.totalTokensIn > 0 && report.totalTokensOut > 0);
  });

  test('judge 输出无法解析时标记失败而不是静默通过', async (t) => {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: { content?: string }[] };
        const isJudge = body.messages?.[0]?.content?.includes('评测员') === true;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: isJudge ? 'not-json' : 'answer' } }] }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const report = await runLiveEval({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'm',
      budgetUsd: 1,
      prices: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      cases: [{ name: 'bad-judge', prompt: '问题', rubric: ['标准'] }],
    });
    assert.equal(report.cases[0]?.pass, false);
    assert.equal(report.cases[0]?.error, 'judge_parse');
  });
  test('预算与价格缺失时禁止发请求，未知 usage 保守扣费并停止后续请求', async () => {
    let requests = 0;
    const options = {
      baseUrl: 'https://test.invalid/v1',
      apiKey: 'test',
      model: 'm',
      cases: [{ name: 'a', prompt: '问题', rubric: ['标准'] }],
      prices: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      fetchImpl: (async () => {
        requests++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }));
      }) as typeof fetch,
    };
    await assert.rejects(runLiveEval({ ...options, budgetUsd: 0 }), /费用上限/);
    await assert.rejects(runLiveEval({ ...options, budgetUsd: 1, prices: {} }), /测试价格/);
    assert.equal(requests, 0);
    const report = await runLiveEval({ ...options, budgetUsd: 0.006 });
    assert.equal(requests, 1);
    assert.match(report.cases[0].error!, /EVAL_BUDGET_EXHAUSTED/);
    assert.ok(report.costUsd > 0 && report.costUsd <= report.budgetUsd);
    assert.equal(report.kind, 'text-smoke');
  });
});
