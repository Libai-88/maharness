import type { RunOptions } from './loop';
import type { ToolDef } from './types';

export function historyTools(archive: NonNullable<RunOptions['historyArchive']>): ToolDef[] {
  return [{
    name: 'search_history', version: '2.0.0', permissions: [], sideEffect: 'read', contentTrust: 'untrusted',
    description: '检索当前任务的原始历史，包括已压缩的消息；返回稳定消息 ID、来源与分页内容。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
    outputSchema: { type: 'object', required: ['messages'], properties: { messages: { type: 'array' } } },
    async handler(args: { query?: string; offset?: number; limit?: number }) { return { ok: true, data: { messages: archive.search(args.query ?? '', args.offset, args.limit) } }; },
  }, {
    name: 'read_history', version: '2.0.0', permissions: [], sideEffect: 'read', contentTrust: 'untrusted',
    description: '按稳定消息 ID 与字符范围读取原始历史。只允许读取本任务归档。',
    parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, required: ['id'] },
    outputSchema: { type: 'object', required: ['id', 'content', 'truncated'], properties: { id: { type: 'string' }, content: { type: 'string' }, truncated: { type: 'boolean' } } },
    async handler(args: { id?: string; offset?: number; limit?: number }) { const page = archive.read(String(args.id), args.offset, args.limit); return page ? { ok: true, data: page } : { ok: false, error: '历史消息不存在', failure: { code: 'HISTORY_NOT_FOUND', retryable: false, outcome: 'not_started' } }; },
  }];
}
