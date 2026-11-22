import type { ToolContext, ToolDef } from '../../kernel/plugin-sdk';

/** Approval assessment is shared by model calls and composite/leaf execution. */
export function assessToolApproval(tool: ToolDef, args: unknown, context: ToolContext): { needsApproval: boolean; reason: string } {
  if (tool.assessApproval) {
    try {
      const result = tool.assessApproval(args, context);
      return result?.needsApproval
        ? { needsApproval: true, reason: result.reason || `工具 ${tool.name} 本次调用需要用户审批` }
        : { needsApproval: false, reason: '' };
    } catch (error) {
      return { needsApproval: true, reason: `审批判定异常（按需审批处理）: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (tool.risk === 'high') return { needsApproval: true, reason: `工具 ${tool.name} 风险等级 high，需要用户审批` };
  return tool.approval ? { needsApproval: true, reason: `工具 ${tool.name} 声明需要用户审批` } : { needsApproval: false, reason: '' };
}
