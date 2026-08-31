/**
 * kernel/tests/replay.spec.ts —— ReplayProvider/RecordingProvider 回归测试（node:test，零新依赖）
 * 覆盖：回放按序产出录音 chunk / callCount 计数 / 序列耗尽报错 /
 *       RecordingProvider 录制真实 provider 的请求与响应。
 * （agent 循环级 golden 回归见 npm run eval —— evals/cases/）
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayProvider, RecordingProvider, loadRecording, type Recording } from '../../core/chat/replay-provider';
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

describe('loadRecording 录音加载', () => {
  test('读取合法录音 JSON（顶层 ESM import——修复前 require 在 ESM 下抛错）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-replay-'));
    try {
      const path = join(root, 'rec.json');
      writeFileSync(path, JSON.stringify(rec));
      const loaded = loadRecording(path);
      assert.equal(loaded.version, 1);
      assert.equal(loaded.requests.length, 2);
      assert.equal(loaded.requests[0].chunks[0].type, 'delta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('格式非法（缺 requests）时抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-replay-'));
    try {
      const path = join(root, 'bad.json');
      writeFileSync(path, JSON.stringify({ version: 1 }));
      assert.throws(() => loadRecording(path), /录音格式不合法/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ReplayProvider 请求内容比对（R5）', () => {
  test('宽松模式：请求与录音不一致时计数 mismatch，回放不受影响', async () => {
    const p = new ReplayProvider(rec);
    const out: LLMChunk[] = [];
    for await (const c of p.chat([], { model: 'm' })) out.push(c); // [] ≠ 录音的 [user q1]
    assert.equal(p.mismatches, 1, '不一致应被计数（可观测信号）');
    assert.equal(out[0].type, 'delta', '仍按录音回放');
  });

  test('消息轮廓一致时不产生 mismatch', async () => {
    const p = new ReplayProvider(rec);
    for await (const _ of p.chat(rec.requests[0].messages, { model: 'm' })) { /* 消费 */ }
    assert.equal(p.mismatches, 0);
  });

  test('strict 模式：不一致直接抛错（CI 强化回归门禁）', async () => {
    const p = new ReplayProvider(rec, { strict: true });
    await assert.rejects(
      () => (async () => { for await (const _ of p.chat([], { model: 'm' })) { /* 触发比对 */ } })(),
      /请求与录音不一致/,
    );
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
