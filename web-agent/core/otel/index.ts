/**
 * core/otel/index.ts —— 可选 OTLP/HTTP trace 导出
 *
 * config.json：
 *   "otel": { "enabled": true, "endpoint": "http://127.0.0.1:4318", "serviceName": "maharness" }
 *
 * 监听 trace.step，把已完成步骤映射为标准 OTLP JSON span，批量 POST /v1/traces。
 */
import { createHash } from 'node:crypto';
import type { Plugin, TraceStep } from '../../kernel/plugin-sdk';

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
}

function hexId(value: string, bytes: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, bytes * 2);
}

function attr(key: string, value: string | number | boolean | undefined): OtlpAttribute | null {
  if (value === undefined || value === '') return null;
  if (typeof value === 'number') return { key, value: { intValue: String(Math.trunc(value)) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

export function stepToOtlpSpan(step: TraceStep): Record<string, unknown> {
  const start = Math.max(0, step.ts) * 1_000_000;
  const durationMs = Math.max(0, Number((step as { durationMs?: number }).durationMs ?? 0));
  const end = start + durationMs * 1_000_000;
  const attributes = [
    attr('maharness.step.type', step.type),
    attr('maharness.step.status', step.status),
    attr('maharness.turn', step.turn),
    attr('maharness.attempt', step.attempt),
    attr('maharness.plugin.id', step.pluginId),
    attr('maharness.session.id', step.sessionId),
    attr('maharness.error.category', step.errorCategory),
    attr('maharness.error.code', step.errorCode),
    attr('maharness.parent.id', step.parentId),
  ].filter((item): item is OtlpAttribute => !!item);
  return {
    traceId: hexId(step.traceId, 16),
    spanId: hexId(step.id, 8),
    parentSpanId: step.parentId ? hexId(step.parentId, 8) : undefined,
    name: step.name || step.type,
    kind: 1,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(Math.max(start, end)),
    attributes,
    status: {
      code: step.status === 'error' ? 2 : 1,
      ...(step.error ? { message: step.error.slice(0, 500) } : {}),
    },
  };
}

export function toOtlpPayload(steps: TraceStep[], serviceName = 'maharness'): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', serviceName)].filter(Boolean) },
      scopeSpans: [{ scope: { name: 'maharness.trace', version: '0.1.0' }, spans: steps.map(stepToOtlpSpan) }],
    }],
  };
}

export default {
  id: 'otel',
  name: 'OTLP 追踪导出',
  version: '0.1.0',
  onLoad(ctx) {
    const enabled = ctx.config.get<boolean>('otel.enabled', false);
    if (!enabled) {
      ctx.logger.info('OTLP 导出未启用（config.json 设 otel.enabled=true 后重载）');
      return;
    }
    const endpoint = ctx.config.get<string>('otel.endpoint', process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '');
    if (!endpoint) {
      ctx.logger.warn('OTLP 导出已启用但未配置 otel.endpoint');
      return;
    }
    const serviceName = ctx.config.get<string>('otel.serviceName', 'maharness');
    const headers = ctx.config.get<Record<string, string>>('otel.headers', {});
    const url = /\/v1\/traces\/?$/.test(endpoint)
      ? endpoint
      : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
    let queue: TraceStep[] = [];
    let timer: NodeJS.Timeout | null = null;
    let sending = false;

    const flush = async (): Promise<void> => {
      if (sending || queue.length === 0) return;
      sending = true;
      const batch = queue;
      queue = [];
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(toOtlpPayload(batch, serviceName)),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        ctx.logger.warn(`OTLP 导出失败（丢弃本批 ${batch.length} 条）: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        sending = false;
      }
    };

    ctx.on('trace.step', (event) => {
      const step = (event as { data?: TraceStep }).data;
      if (!step || step.status === 'running') return;
      queue.push(step);
      if (queue.length >= 100) void flush();
    });
    timer = setInterval(() => { void flush(); }, 1_000);
    (timer as { unref?: () => void }).unref?.();
    ctx.effect<void>(() => undefined, () => () => {
      if (timer) clearInterval(timer);
      void flush();
    });
    ctx.logger.info(`OTLP 导出已启用：${url}（service=${serviceName}）`);
  },
} satisfies Plugin;
