// server/services/society/branch-graph.ts —— 社会任务分支的依赖解析与环检测（从 index.ts 拆出）
import { OrganizationError, type SocietyTaskBranch } from '../../organization-store';

/**
 * 单租户社会任务/调度在 tick、快照与列表里的读取上限。
 * 超出部分不会进入计算：本地单用户规模足够，但这是明确的扩展天花板；
 * 需要支持更大规模时应改成分页游标，而不是把这个常量继续调大。
 */
export const SOCIETY_LIST_LIMIT = 1000;

export function branchIndex(dependency: string): number | undefined {
  const match = /^(?:assignment|branch)-(\d+)$/i.exec(dependency.trim());
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

export function dependencyIndexes(branches: SocietyTaskBranch[]): number[][] {
  const dependencies = branches.map((branch, index) =>
    (branch.dependsOn ?? [])
      .map((reference) => {
        const target = branchIndex(reference);
        if (target === undefined || target >= branches.length || target === index)
          throw new OrganizationError(400, 'DEPENDENCY_INVALID', `分支 ${index + 1} 的依赖无效：${reference}`);
        return target;
      })
      .filter((target, position, all) => all.indexOf(target) === position),
  );
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new OrganizationError(400, 'DEPENDENCY_INVALID', '分支依赖不能形成环');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of dependencies[index]) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < branches.length; index += 1) visit(index);
  return dependencies;
}
