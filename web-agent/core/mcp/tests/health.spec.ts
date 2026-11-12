import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpCircuitBreaker } from '../health';
import { wrapMcpTool } from '../index';
import type { McpConnection, McpToolDef } from '../index';
import type { ToolContext } from '../../../kernel/types';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('MCP server 熔断', () => {
  it('连续失败达到阈值后快速失败，冷却结束只放行一个探测，成功即闭合', () => {
    const c = clock();
    const breaker = new McpCircuitBreaker({ failureThreshold: 2, cooldownMs: 5_000, now: c.now });

    assert.equal(breaker.allow(), undefined);
    breaker.failure(new Error('boom-1'), 10);
    assert.equal(breaker.snapshot().state, 'closed');
    assert.equal(breaker.allow(), undefined);
    breaker.failure(new Error('boom-2'), 20);

    const open = breaker.snapshot();
    assert.equal(open.state, 'open');
    assert.equal(open.failures, 2);
    assert.equal(open.lastError, 'boom-2');
    assert.match(String(breaker.allow()), /熔断中/);

    c.advance(5_000);
    assert.equal(breaker.snapshot().state, 'half-open');
    assert.equal(breaker.allow(), undefined, '冷却后应放行一个探测');
    assert.match(String(breaker.allow()), /半开探测进行中/);
    breaker.success(15);

    const closed = breaker.snapshot();
    assert.equal(closed.state, 'closed');
    assert.equal(closed.consecutiveFailures, 0);
    assert.equal(closed.lastDurationMs, 15);
    assert.equal(breaker.allow(), undefined);
  });

  it('半开探测失败会重新打开冷却窗口', () => {
    const c = clock();
    const breaker = new McpCircuitBreaker({ failureThreshold: 1, cooldownMs: 2_000, now: c.now });
    breaker.failure(new Error('first'));
    c.advance(2_000);
    assert.equal(breaker.allow(), undefined);
    breaker.failure(new Error('probe failed'));
    const snapshot = breaker.snapshot();
    assert.equal(snapshot.state, 'open');
    assert.equal(snapshot.retryAfterMs, 2_000);
  });

  it('探测位被本地配额拦下时可释放，不污染熔断计数', () => {
    const c = clock();
    const breaker = new McpCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: c.now });
    breaker.failure(new Error('first'));
    c.advance(1_000);
    assert.equal(breaker.allow(), undefined);
    breaker.cancelProbe();
    assert.equal(breaker.allow(), undefined, '取消探测后应再次放行');
    breaker.success();
    assert.equal(breaker.snapshot().state, 'closed');
  });
});

describe('MCP 工具调用接入熔断', () => {
  const mt: McpToolDef = {
    name: 'read',
    description: 'read',
    inputSchema: { type: 'object', properties: {} },
  };

  it('打开后不再调用 server，冷却后的探测成功恢复调用', async () => {
    const c = clock();
    const breaker = new McpCircuitBreaker({ failureThreshold: 1, cooldownMs: 3_000, now: c.now });
    let calls = 0;
    let mode: 'fail' | 'ok' = 'fail';
    const conn = {
      async toolsCall() {
        calls++;
        if (mode === 'fail') throw new Error('network down');
        return { content: [{ type: 'text', text: 'done' }] };
      },
      close() {},
    } as unknown as McpConnection;
    const tool = wrapMcpTool('demo', mt, conn, { type: 'stdio', command: 'node' }, undefined, breaker);

    const first = await tool.handler({}, {} as ToolContext) as { ok: boolean; error?: string };
    assert.equal(first.ok, false);
    assert.match(String(first.error), /network down/);
    assert.equal(calls, 1);

    const blocked = await tool.handler({}, {} as ToolContext) as { ok: boolean; error?: string };
    assert.equal(blocked.ok, false);
    assert.match(String(blocked.error), /熔断中/);
    assert.equal(calls, 1, '熔断期间不得再触达 server');

    c.advance(3_000);
    mode = 'ok';
    const probe = await tool.handler({}, {} as ToolContext) as { ok: boolean; data?: { text?: string } };
    assert.equal(probe.ok, true);
    assert.equal(probe.data?.text, 'done');
    assert.equal(calls, 2);
    assert.equal(breaker.snapshot().state, 'closed');
  });

  it('服务端返回结构化 isError 视为连接健康，不触发熔断', async () => {
    const breaker = new McpCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    let calls = 0;
    const conn = {
      async toolsCall() {
        calls++;
        return { content: [{ type: 'text', text: 'invalid argument' }], isError: true };
      },
      close() {},
    } as unknown as McpConnection;
    const tool = wrapMcpTool('demo', mt, conn, { type: 'stdio', command: 'node' }, undefined, breaker);

    for (let i = 0; i < 2; i++) {
      const result = await tool.handler({}, {} as ToolContext) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.equal(result.error, 'invalid argument');
    }
    assert.equal(calls, 2);
    assert.equal(breaker.snapshot().state, 'closed');
    assert.equal(breaker.snapshot().failures, 0);
  });
});
