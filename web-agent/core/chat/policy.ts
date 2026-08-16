/**
 * core/chat/policy.ts —— 对话策略（能力层共享契约）
 * 从 server 路由层下沉的策略常量/校验：这些是「对话能力自身的语义」（模式提示词、
 * 角色工具边界、断点完整性契约），不属于传输外壳（server）。外壳（routes/chat.ts）
 * 与能力层共用同一份定义，避免策略散落两处漂移。
 * 纯外壳关注点（如 BUILTIN_COMMANDS 命令表）仍留在 server 侧。
 */

/** 会话模式提示词（plan/goal 注入 systemPrompt 的模式纪律；normal 无注入） */
export const MODE_PROMPTS: Record<string, string> = {
  plan: '【当前模式：计划模式】先输出完整的执行计划（分步列表，含理由），等待用户确认后再执行任何工具；用户未明确同意前不得执行写操作。',
  goal: '【当前模式：目标模式】多步任务先用 create_plan 建立目标计划并随进度调用 update_plan_progress 更新；单步任务直接执行。',
};

/** 角色只读工具白名单（与 subagent 语义一致：侦查/搜索/记忆，不改变世界） */
export const ROLE_READONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'web_search', 'list_skills', 'get_skill',
  'recall_facts', 'plugin_status',
]);

/**
 * 断点历史完整性校验：恢复前必须保证 assistant 的 tool_calls 与 tool 回填配对完整、
 * tool 消息带 tool_call_id——否则 provider 会拒绝请求（missing tool_call_id）。
 * 返回 null = 完整可恢复；返回字符串 = 不一致原因（调用方应清除断点并明确告知）。
 */
export function validateCheckpointHistory(history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]): string | null {
  const pending = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as { id?: string }[]) {
        if (tc?.id) pending.add(tc.id);
      }
    } else if (m.role === 'tool') {
      if (!m.tool_call_id) return `断点第 ${i + 1} 条消息（工具回填）缺少 tool_call_id`;
      pending.delete(m.tool_call_id);
    }
  }
  if (pending.size > 0) return `断点存在 ${pending.size} 个未配对的工具调用（${[...pending].slice(0, 3).join(', ')}${pending.size > 3 ? '…' : ''}）`;
  return null;
}
