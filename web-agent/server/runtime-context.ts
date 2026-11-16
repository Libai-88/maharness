import type { LLMMessage } from '../kernel/types';

/** Trusted, run-scoped clock context kept out of durable model history. */
export function runtimeClockContext(now = Date.now(), requestedZone?: string): LLMMessage {
  const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let timeZone = requestedZone?.trim() || defaultZone;
  let local: string;
  try {
    local = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full', timeStyle: 'long', timeZone, hour12: false,
    }).format(now);
  } catch {
    timeZone = 'UTC';
    local = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full', timeStyle: 'long', timeZone, hour12: false,
    }).format(now);
  }
  return {
    role: 'system',
    content: `当前时间（运行环境）：${local}\n运行环境时区：${timeZone}\nUTC 时间：${new Date(now).toISOString()}\n涉及相对日期、预约或截止时间时以此为准；用户指定其他时区时按其要求换算。`,
    context: {
      id: 'runtime-clock', source: 'runtime-clock', scope: 'run',
      trust: 'core', retention: 'required',
    },
  };
}
