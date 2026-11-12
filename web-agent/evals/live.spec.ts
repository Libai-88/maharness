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
        const content = isJudge
          ? '{"score":5,"pass":true,"reason":"覆盖了关键点"}'
          : '这是候选回答，覆盖关键点。';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: isJudge ? 20 : 10, completion_tokens: isJudge ? 5 : 8 },
        }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const report = await runLiveEval({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'answer-model',
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
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'm',
      cases: [{ name: 'bad-judge', prompt: '问题', rubric: ['标准'] }],
    });
    assert.equal(report.cases[0]?.pass, false);
    assert.equal(report.cases[0]?.error, 'judge_parse');
  });
});
