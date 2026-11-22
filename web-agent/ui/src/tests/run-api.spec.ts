import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRun, subscribeRun, type RunInfo } from '../run-api';

const run = (patch: Partial<RunInfo> = {}): RunInfo =>
  ({
    id: 'r1',
    sessionId: 's1',
    objective: '测试任务',
    providerId: 'p',
    model: 'm',
    status: 'completed',
    cost: 0,
    tokensIn: 3,
    tokensOut: 4,
    createdAt: 1,
    updatedAt: 2,
    answer: '结果',
    ...patch,
  }) as unknown as RunInfo;

function sse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const frame = (id: number, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activeRun', () => {
  it('只把未终结状态视为活跃', () => {
    expect(activeRun(run({ status: 'running' }))).toBe(true);
    expect(activeRun(run({ status: 'waiting_approval' }))).toBe(true);
    expect(activeRun(run({ status: 'completed' }))).toBe(false);
    expect(activeRun(run({ status: 'cancelled' }))).toBe(false);
  });
});

describe('subscribeRun', () => {
  it('按 SSE 序号推进游标、忽略重放帧，并在任务终结时回调 onDone/onEnd', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url, headers });
        if (url.includes('/events')) {
          return sse(
            frame(1, 'start', { traceId: 't1' }) +
              frame(2, 'delta', { text: '你' }) +
              frame(3, 'done', { content: '你好', usage: { input: 1, output: 2 }, cost: 0 }) +
              // 重放帧：序号不大于游标，应被丢弃
              frame(2, 'delta', { text: '不该出现' }),
          );
        }
        return new Response(JSON.stringify(run({ status: 'completed' })), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const deltas: string[] = [];
    const done: unknown[] = [];
    const started: string[] = [];
    let ended = 0;
    await subscribeRun(
      'r1',
      {
        onStart: (traceId) => started.push(traceId),
        onDelta: (text) => deltas.push(text),
        onDone: (payload) => done.push(payload),
        onEnd: () => {
          ended++;
        },
      },
      undefined,
      0,
    );

    expect(started).toEqual(['t1']);
    expect(deltas).toEqual(['你']);
    expect(done).toHaveLength(1);
    expect(ended).toBe(1);
    // 断点续传：首个请求携带 Last-Event-ID，且事件 URL 带任务 id
    expect(requests[0].url).toContain('/api/v2/runs/r1/events');
    expect(requests[0].headers['Last-Event-ID']).toBe('0');
  });

  it('任务被取消时回调 onError 并标记为 aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/events')) return sse('');
        return new Response(JSON.stringify(run({ status: 'cancelled', answer: undefined })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const errors: [string, string | undefined][] = [];
    await subscribeRun('r2', { onError: (message, kind) => errors.push([message, kind]) });

    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toBe('aborted');
  });
});
