/**
 * kernel/tests/replay.spec.ts —— ReplayProvider/RecordingProvider 回归测试（node:test，零新依赖）
 * 覆盖：回放按序产出录音 chunk / callCount 计数 / 序列耗尽报错 /
 *       RecordingProvider 录制真实 provider 的请求与响应。
 * （agent 循环级 golden 回归见 npm run eval —— evals/cases/）
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayProvider, RecordingProvider, type Recording } from '../../core/chat/replay-provider';
import type { LLMChunk } from '../types';

const rec: Recording = {
  version: 1,
  requests: [
    {
      messages: [{ role: 'user', content: 'q1' }],
      model: 'm',
      chunks: [
        { type: 'delta', text: '你好' },
        { type: 'usage', input: 10, output: 2 },
        { type: 'done' },
      ],
    },
    {
      messages: [{ role: 'user', content: 'q2' }],
      model: 'm',
      chunks: [
        { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } } },
        { type: 'done' },
      ],
    },
  ],
};

describe('ReplayProvider 确定性回放', () => {
  test('按录音顺序逐次产出 chunk，callCount 递增', async () => {
    const p = new ReplayProvider(rec);
    const out1: LLMChunk[] = [];
    for await (const c of p.chat([], { model: 'm' })) out1.push(c);
    assert.deepEqual(out1, rec.requests[0].chunks);
    assert.equal(p.callCount, 1);

    const out2: LLMChunk[] = [];
    for await (const c of p.chat([], { model: 'm' })) out2.push(c);
    assert.equal(out2[0].type, 'tool_call');
    assert.equal(p.callCount, 2);
  });

  test('序列耗尽时抛错（agent 循环行为与录制不一致的信号）', async () => {
    const p = new ReplayProvider(rec);
    for await (const _ of p.chat([], { model: 'm' })) { /* 消耗 1 */ }
    for await (const _ of p.chat([], { model: 'm' })) { /* 消耗 2 */ }
    await assert.rejects(() => {
      const gen = p.chat([], { model: 'm' });
      return (async () => { for await (const _ of gen) { /* 应抛错 */ } })();
    }, /序列耗尽/);
  });
});

describe('RecordingProvider 录制', () => {
  test('包裹真实 provider：请求与响应被完整记录，输出原样透传', async () => {
    const inner = {
      id: 'inner', label: 'INNER', defaultModel: 'm',
      async *chat(): AsyncIterable<LLMChunk> {
        yield { type: 'delta', text: 'x' };
        yield { type: 'done' };
      },
    };
    const rp = new RecordingProvider(inner);
    const got: LLMChunk[] = [];
    for await (const c of rp.chat([{ role: 'user', content: 'hi' }], { model: 'm' })) got.push(c);
    assert.deepEqual(got, [{ type: 'delta', text: 'x' }, { type: 'done' }]);
    const r = rp.toRecording();
    assert.equal(r.version, 1);
    assert.equal(r.requests.length, 1);
    assert.deepEqual(r.requests[0].chunks, got);
    assert.equal(r.requests[0].messages[0].content, 'hi');
  });
});
