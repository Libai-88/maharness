import type { ToolDef } from './types';

/**
 * 工具调用录音与安全回放。
 *
 * 「安全重放」的语义：重放 run 的所有工具调用由预录结果按「工具名 + 参数」确定性
 * 返回，真实 handler 不执行——副作用（文件写入、网络请求、进程、MCP 调用）不可能发生。
 * 匹配按工具名 + 规范化参数 JSON；找不到匹配时 fail-closed 抛错而不是执行真实工具
 * （静默回退到真实执行会让重放不可信）。
 */

export interface RecordedToolCall {
  name: string;
  args: unknown;
  result: { ok: boolean; data?: unknown; error?: string };
}

export interface ToolRecording {
  version: 1;
  calls: RecordedToolCall[];
}

/** 稳定键：工具名 + 参数对象的确定性序列化（键排序，与调用顺序无关的参数等价）。 */
function callKey(name: string, args: unknown): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** 包装真实工具集：透传执行并按顺序记录每次调用的参数与结果。
 *  用于录制阶段；回放阶段请使用 stubTools（真实 handler 不执行）。 */
export function recordTools(tools: ToolDef[]): { tools: ToolDef[]; recording: ToolRecording } {
  const recording: ToolRecording = { version: 1, calls: [] };
  const wrapped = tools.map((tool) => ({
    ...tool,
    handler: async (args: unknown, ctx: Parameters<ToolDef['handler']>[1]) => {
      const result = await tool.handler(args, ctx);
      recording.calls.push({ name: tool.name, args, result: { ok: result.ok, data: result.data, error: result.error } });
      return result;
    },
  }));
  return { tools: wrapped, recording };
}

/** 从录音生成桩工具集：同签名、同描述（LLM 视角不变），handler 返回预录结果。
 *  真实 handler 完全不携带——重放 run 无法触碰真实工具实现。
 *  审批语义保留：预录结果原样返回，重放 run 不再触发真实审批门。 */
export function stubTools(
  tools: ToolDef[],
  recording: ToolRecording,
): { tools: ToolDef[]; calls: { name: string; args: unknown }[] } {
  const byKey = new Map<string, RecordedToolCall[]>();
  for (const call of recording.calls) {
    const list = byKey.get(call.name) ?? [];
    list.push(call);
    byKey.set(call.name, list);
  }
  const calls: { name: string; args: unknown }[] = [];
  const stubbed = tools.map((tool) => {
    const recorded = byKey.get(tool.name) ?? [];
    if (!recorded.length) {
      throw new Error(`安全重放配置错误：录音中没有工具 ${tool.name} 的记录`);
    }
    return {
      ...tool,
      handler: async (args: unknown) => {
        const idx = recorded.findIndex((c) => callKey(tool.name, c.args) === callKey(tool.name, args));
        if (idx < 0) {
          throw new Error(`安全重放匹配失败：工具 ${tool.name} 的参数与录音不一致（fail-closed，不执行真实工具）`);
        }
        const [hit] = recorded.splice(idx, 1);
        calls.push({ name: tool.name, args });
        return hit.result;
        // 留意：同参数重复调用按 FIFO 消耗；录音耗尽 → 匹配失败抛错。
      },
    };
  });
  return { tools: stubbed, calls };
}
