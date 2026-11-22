import { describe, expect, it } from 'vitest';
import { buildChatTimeline } from '../model';
import type { ChatMessage } from '../../types';

const message = (patch: Partial<ChatMessage>): ChatMessage => ({ id: 'm1', role: 'assistant', content: '', ...patch });

describe('buildChatTimeline', () => {
  it('用户消息开启一轮，助手消息按 narration→tool→verification→reasoning→text 顺序分片', () => {
    const timeline = buildChatTimeline([
      message({ id: 'u1', role: 'user', content: '读一下 README' }),
      message({
        id: 'a1',
        narration: ['我要先看目录', '  '],
        tools: [{ id: 't1', name: 'glob', status: 'done' } as never],
        taskVerification: { ok: true, checks: [], evidence: [] } as never,
        reasoning: '先列文件',
        content: '读完了',
      }),
    ]);

    expect(timeline).toHaveLength(1);
    const turn = timeline[0];
    expect(turn.kind).toBe('turn');
    if (turn.kind !== 'turn') throw new Error('期望 turn');
    expect(turn.user?.content).toBe('读一下 README');
    expect(turn.runs).toHaveLength(1);
    expect(turn.runs[0].parts.map((part) => part.kind)).toEqual(['narration', 'tool', 'verification', 'reasoning', 'text']);
    // 空白旁白被过滤，只留一句
    const narration = turn.runs[0].parts[0];
    expect(narration.kind === 'narration' && narration.paragraphs).toEqual(['我要先看目录']);
  });

  it('retryFrom 只保留重试边界之后的正文与思考', () => {
    const timeline = buildChatTimeline([
      message({ id: 'a1', role: 'assistant', content: '旧答案新答案', retryFrom: 3, reasoning: '旧思考新思考', retryFromReasoning: 3 }),
    ]);
    const turn = timeline[0];
    if (turn.kind !== 'turn') throw new Error('期望 turn');
    const parts = turn.runs[0].parts;
    expect(parts.find((part) => part.kind === 'text' && part.text === '新答案')).toBeTruthy();
    expect(parts.find((part) => part.kind === 'reasoning' && part.text === '新思考')).toBeTruthy();
  });

  it('流式且空正文时给状态占位；被停止时给温和系统条', () => {
    const streaming = buildChatTimeline([message({ id: 'a1', streaming: true, tools: [] })], '自定义状态');
    const turn = streaming[0];
    if (turn.kind !== 'turn') throw new Error('期望 turn');
    const status = turn.runs[0].parts.find((part) => part.kind === 'status');
    expect(status && status.kind === 'status' ? status.text : undefined).toBe('自定义状态');

    const stopped = buildChatTimeline([message({ id: 'a2', stopped: true })]);
    const stoppedTurn = stopped[0];
    if (stoppedTurn.kind !== 'turn') throw new Error('期望 turn');
    expect(stoppedTurn.runs[0].parts.some((part) => part.kind === 'stopped')).toBe(true);
  });

  it('同一轮里的失败正文带可重试标记，超时断点插入时间分隔', () => {
    const timeline = buildChatTimeline([
      message({ id: 'u1', role: 'user', content: '问题', ts: 1_000 }),
      message({ id: 'u2', role: 'user', content: '很久以后', ts: 1_000 + 6 * 60_000 }),
      message({ id: 'a1', error: '上游 500', streaming: false, ts: 1_000 + 7 * 60_000 }),
    ]);

    const markers = timeline.filter((item) => item.kind === 'marker');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    const failure = timeline.find(
      (item) => item.kind === 'turn' && item.runs.some((run) => run.parts.some((part) => part.kind === 'failure')),
    );
    expect(failure).toBeTruthy();
    if (!failure || failure.kind !== 'turn') throw new Error('期望失败轮');
    const part = failure.runs[0].parts.find((item) => item.kind === 'failure');
    expect(part && part.kind === 'failure' ? part.retryable : undefined).toBe(true);
  });
});
