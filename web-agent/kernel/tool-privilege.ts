import type { ToolContext } from './types';

/**
 * 全局能力的工具级 principal 门。
 * 缺省 principal（local/trusted 单用户）视为管理员；DB member/readonly 必须失败关闭。
 */
export function adminToolDenied(tctx: Pick<ToolContext, 'principal'>, action: string): string | null {
  const role = tctx.principal?.role;
  if (!role || role === 'admin') return null;
  return `需要 admin 权限：${action}（当前 principal=${role}）`;
}
