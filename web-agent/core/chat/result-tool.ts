import type { ToolDef } from '../../kernel/types';
import { resultPage } from '../../kernel/tool-journal';
import { resultStore, sessionKeyOf } from './result-store';
import { sharedSingleton } from '../../kernel/shared';

const readers = sharedSingleton('chat.resultTool.readers.v2', () => new WeakSet<object>());
export function isResultTool(tool: ToolDef): boolean { return readers.has(tool.handler); }

/** Reading an observation grants no access to files or other tasks. */
export function createResultTool(): ToolDef {
  const tool: ToolDef = {
    name: 'recall_tool_result', version: '2.0.0', permissions: [], sideEffect: 'read', contentTrust: 'untrusted',
    description: '按 resultRef 重读当前任务保存的完整工具结果；id=resultRef。可用 offset、limit 分页，无需重新执行原工具。',
    parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, required: ['id'], additionalProperties: false },
    outputSchema: { type: 'object', required: ['id', 'length', 'content', 'offset', 'truncated'], properties: { id: { type: 'string' }, length: { type: 'integer', minimum: 0 }, content: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' }, nextOffset: { type: 'integer', minimum: 0 } } },
    async handler(args: { id: string; offset?: number; limit?: number }, ctx) {
      const content = ctx.results ? undefined : resultStore.get(sessionKeyOf(ctx), args.id);
      const page = ctx.results ? ctx.results.read(args.id, args.offset, args.limit) : content === undefined ? undefined : resultPage(args.id, content, args.offset, args.limit);
      return page ? { ok: true, data: page, truncated: page.truncated, resultRef: args.id }
        : { ok: false, error: '当前任务中不存在结果: ' + args.id, failure: { code: 'RESULT_NOT_FOUND', retryable: false, outcome: 'not_started' } };
    },
  };
  readers.add(tool.handler);
  return tool;
}
