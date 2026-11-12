import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stepToOtlpSpan, toOtlpPayload } from '../index';
import type { TraceStep } from '../../../kernel/types';

const step: TraceStep = {
  id: 'step-1',
  traceId: 'trace-1',
  turn: 2,
  type: 'tool_call',
  name: 'read_file',
  status: 'error',
  ts: 1_700_000_000_000,
  durationMs: 120,
  error: 'missing file',
  errorCategory: 'parameter',
  errorCode: 'ENOENT',
  sessionId: 's1',
  pluginId: 'tools-fs',
};

describe('OTLP trace 映射', () => {
  it('映射 trace/span id、时间、属性和错误状态', () => {
    const span = stepToOtlpSpan(step);
    assert.equal(String(span.traceId).length, 32);
    assert.equal(String(span.spanId).length, 16);
    assert.equal(span.name, 'read_file');
    assert.equal(span.kind, 1);
    assert.equal(span.startTimeUnixNano, String(step.ts * 1_000_000));
    assert.equal(span.endTimeUnixNano, String((step.ts + 120) * 1_000_000));
    assert.equal((span.status as any).code, 2);
    assert.match((span.status as any).message, /missing file/);
    assert.ok((span.attributes as any[]).some((item) => item.key === 'maharness.plugin.id' && item.value.stringValue === 'tools-fs'));
  });

  it('payload 包含 service.name 与 scopeSpans', () => {
    const payload = toOtlpPayload([step], 'maharness-test') as any;
    const resource = payload.resourceSpans[0].resource;
    assert.ok(resource.attributes.some((item: any) => item.key === 'service.name' && item.value.stringValue === 'maharness-test'));
    assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  });
});
