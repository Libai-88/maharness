// server/services/organization/contract.ts —— 组织契约的评分、证据、依赖与判定（从 service.ts 拆出）
import { createHash } from 'node:crypto';

import type { PermissionProfile, RunRecord } from '../../../kernel/run';
import { validateTaskContract, type TaskCriterion } from '../../../kernel/task-verifier';
import type { Store } from '../../db';
import { REVIEW_DIMENSIONS, REVIEW_RUBRIC_VERSION, REVIEW_SYSTEM_PROMPT } from '../../review-rubric';
import {
  OrganizationError,
  type AssignmentContract,
  type EvidenceRef,
  type EvaluationPolicy,
  type WorkOrder,
} from '../../organization-store';

export const TEAM_TOOL_NAMES = new Set(['run_subagent', 'run_parallel', 'run_review', 'work_contract_deliver', 'raise_exception']);
export const ORGANIZATION_ADVANCED_TOOLS = new Set(['team_create', 'work_contract_create', 'role_scorecard']);
const TEAM_REQUEST = /(团队|小组|多人协作|多个角色|并行|分工|派给|交给.*代理|agent\s*(team|群|组)|subagents?|parallel)/i;
const NEGATED_TEAM_REQUEST =
  /(?:不要|不用|无需|不需要|别|禁止|不得|暂不)[^，,。！？!?；;\n]{0,16}(?:团队|小组|多个角色|并行|分工|派给|代理|subagents?|parallel)/i;

export function explicitTeamRequest(text: string): boolean {
  return text.split(/[，,。！？!?；;\n]+/).some((clause) => TEAM_REQUEST.test(clause) && !NEGATED_TEAM_REQUEST.test(clause));
}

export function bounded(text: string, max: number, label: string): string {
  const value = text.trim();
  if (!value) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `${label}不能为空`);
  if (value.length > max) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', `${label}过长（最多 ${max} 字）`);
  return value;
}

export function evidenceOf(runIds: string[], store: Store, tenantId: string): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  for (const runId of runIds) {
    const run = store.runs.get(runId, tenantId);
    if (!run) continue;
    evidence.push({
      id: `goal:${run.id}`,
      kind: 'goal',
      ref: run.id,
      hash: createHash('sha256').update(run.objective).digest('hex').slice(0, 16),
    });
    for (const artifact of store.runs.artifacts(run.id)) {
      evidence.push({
        id: `artifact:${artifact.id}`,
        kind: 'artifact',
        ref: artifact.ref,
        version: artifact.metadata?.version,
        hash: artifact.metadata?.version,
      });
    }
  }
  return evidence;
}

export function cachePrefixHash(input: {
  tenantId: string;
  workspace: string;
  projectId: string;
  providerId: string;
  model: string;
  workOrderId: string;
  materialVersions: { id: string; version: string }[];
  ruleHash?: string;
  toolVersions?: string[];
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function unfinishedForRun(run: RunRecord): string[] {
  const verification = run.verification as { status?: string; checks?: { ok?: boolean; reason?: string }[] } | undefined;
  const failedChecks =
    verification?.checks?.filter((check) => check.ok === false).flatMap((check) => (check.reason ? [check.reason] : ['验收条件未通过'])) ??
    [];
  if (verification && 'type' in verification && verification.type === 'task_partial')
    return failedChecks.length ? failedChecks : ['任务仅部分完成'];
  if (verification && 'type' in verification && verification.type === 'task_failed')
    return failedChecks.length ? failedChecks : ['任务验收失败'];
  if (run.status !== 'completed') return [run.error ?? `任务未完成：${run.status}`];
  if (verification?.status === 'partial') return failedChecks.length ? failedChecks : ['任务仅部分完成'];
  if (verification?.status === 'failed') return failedChecks.length ? failedChecks : ['任务验收失败'];
  return failedChecks;
}

export function artifactMatches(ref: string, expected: string, exact = false): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const target = normalize(expected);
  return normalize(ref) === target || (!exact && normalize(ref).endsWith(`/${target}`));
}

export function taskCriteriaForContract(contract: AssignmentContract): TaskCriterion[] {
  const parsed = contract.acceptance.flatMap((item) => {
    if (!item.verification?.trim().startsWith('{')) return [];
    try {
      const criterion = JSON.parse(item.verification) as TaskCriterion;
      return validateTaskContract({ objective: contract.branchObjective, acceptance: [criterion] }).length ? [] : [criterion];
    } catch {
      return [];
    }
  });
  const artifacts = contract.expectedArtifacts
    .filter((path) => !contract.coordinatorArtifacts?.includes(path))
    .filter(Boolean)
    .map((path) => ({ type: 'file_exists' as const, path }));
  return [...parsed, ...artifacts].filter(
    (item, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
  );
}

export function intersectTools(...groups: Array<string[] | undefined>): string[] {
  const constrained = groups.filter((group): group is string[] => !!group?.length);
  if (!constrained.length) return [];
  return [...new Set(constrained[0]!)].filter((name) => constrained.slice(1).every((group) => group.includes(name)));
}

export function narrowProfile(left: PermissionProfile, right: PermissionProfile): PermissionProfile {
  return left === 'developer' && right === 'developer' ? 'developer' : 'standard';
}

export const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  schemaVersion: 1,
  lowConfidenceSamples: 3,
  mediumConfidenceSamples: 10,
  highConfidenceSamples: 30,
  rankingWeights: { acceptance: 0.5, budget: 0.3, evidence: 0.2 },
  review: {
    rubricVersion: REVIEW_RUBRIC_VERSION,
    dimensions: [...REVIEW_DIMENSIONS],
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    // A complete review is ten scored dimensions plus observations and
    // suggestions; real models spend 1,500–3,200 output tokens on it. The
    // earlier 3,800/9,200/11,500 totals truncated the JSON body before it closed,
    // so the caps now leave room for the full body while still bounding spend.
    fast: { input: 4_000, output: 4_000, total: 8_000 },
    focused: { input: 8_000, output: 6_000, total: 14_000 },
    multi: { input: 10_000, output: 6_000, total: 16_000 },
    positiveMinAverage: 3.5,
    positiveMinReuse: 4,
    positiveMinDimension: 3,
  },
  formula: 'role metrics come from contract and Run facts; review verdict cannot override fact gates',
};

export function normalizeEvaluationPolicy(input: Partial<EvaluationPolicy>): EvaluationPolicy {
  const merged = {
    ...DEFAULT_EVALUATION_POLICY,
    ...input,
    rankingWeights: { ...DEFAULT_EVALUATION_POLICY.rankingWeights, ...input.rankingWeights },
    review: {
      ...DEFAULT_EVALUATION_POLICY.review,
      ...input.review,
      fast: { ...DEFAULT_EVALUATION_POLICY.review.fast, ...input.review?.fast },
      focused: { ...DEFAULT_EVALUATION_POLICY.review.focused, ...input.review?.focused },
      multi: { ...DEFAULT_EVALUATION_POLICY.review.multi, ...input.review?.multi },
    },
  };
  const integer = (value: unknown, label: string, min = 1, max = 100_000): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}必须在 ${min} 到 ${max} 之间`);
    return parsed;
  };
  const low = integer(merged.lowConfidenceSamples, '低置信度样本门槛', 2, 10_000);
  const medium = integer(merged.mediumConfidenceSamples, '中置信度样本门槛', low + 1, 10_000);
  const high = integer(merged.highConfidenceSamples, '高置信度样本门槛', medium + 1, 100_000);
  const weights = Object.fromEntries(
    Object.entries(merged.rankingWeights).map(([key, value]) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
        throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '角色排序权重必须在 0 到 1 之间');
      return [key, parsed];
    }),
  ) as EvaluationPolicy['rankingWeights'];
  const weightTotal = weights.acceptance + weights.budget + weights.evidence;
  if (weightTotal <= 0) throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '角色排序权重之和必须大于 0');
  const rubricDimensions = [
    ...new Set(
      (merged.review.dimensions ?? DEFAULT_EVALUATION_POLICY.review.dimensions).map((item) => bounded(String(item), 80, '复盘维度')),
    ),
  ].slice(0, 20);
  if (!rubricDimensions.length) throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', '复盘 Rubric 至少需要一个维度');
  const limit = (value: unknown, label: string, max: number): number => integer(value, label, 1, max);
  const budget = (value: EvaluationPolicy['review']['fast'], label: string) => {
    const inputTokens = limit(value.input, `${label}输入 token 上限`, 100_000);
    const outputTokens = limit(value.output, `${label}输出 token 上限`, 100_000);
    const total = limit(value.total, `${label}总 token 上限`, 200_000);
    if (total < inputTokens + outputTokens)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}总 token 上限不能小于输入与输出之和`);
    return { input: inputTokens, output: outputTokens, total };
  };
  const decimal = (value: unknown, label: string, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max)
      throw new OrganizationError(400, 'EVALUATION_POLICY_INVALID', `${label}必须在 ${min} 到 ${max} 之间`);
    return Math.round(parsed * 100) / 100;
  };
  return {
    schemaVersion: 1,
    lowConfidenceSamples: low,
    mediumConfidenceSamples: medium,
    highConfidenceSamples: high,
    rankingWeights: {
      acceptance: weights.acceptance / weightTotal,
      budget: weights.budget / weightTotal,
      evidence: weights.evidence / weightTotal,
    },
    review: {
      rubricVersion: bounded(merged.review.rubricVersion, 100, '复盘 Rubric 版本'),
      dimensions: rubricDimensions,
      systemPrompt: bounded(merged.review.systemPrompt ?? DEFAULT_EVALUATION_POLICY.review.systemPrompt, 4_000, '复盘提示词'),
      fast: budget(merged.review.fast, '快速复盘'),
      focused: budget(merged.review.focused, '聚焦复盘'),
      multi: budget(merged.review.multi, '多 Run 复盘'),
      positiveMinAverage: decimal(merged.review.positiveMinAverage, '正面平均分门槛', 1, 5),
      positiveMinReuse: integer(merged.review.positiveMinReuse, '再次使用意愿门槛', 1, 5),
      positiveMinDimension: integer(merged.review.positiveMinDimension, '单个维度最低分', 1, 5),
      ...(merged.review.providerId ? { providerId: bounded(merged.review.providerId, 100, '复盘供应商') } : {}),
      ...(merged.review.model ? { model: bounded(merged.review.model, 200, '复盘模型') } : {}),
    },
    formula: bounded(merged.formula, 1_000, '评价公式'),
  };
}

export function validateSocietyDependencies(contracts: AssignmentContract[]): void {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  for (const contract of contracts) {
    if (contract.dependsOn.some((id) => !byId.has(id) || id === contract.id))
      throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '社会分工依赖引用无效');
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (contract: AssignmentContract): void => {
    const mark = state.get(contract.id) ?? 0;
    if (mark === 1) throw new OrganizationError(400, 'WORK_CONTRACT_INVALID', '社会分工依赖存在循环');
    if (mark === 2) return;
    state.set(contract.id, 1);
    for (const dependencyId of contract.dependsOn) visit(byId.get(dependencyId)!);
    state.set(contract.id, 2);
  };
  for (const contract of contracts) visit(contract);
}

export function rootAnswer(workOrder: WorkOrder, run: RunRecord, contracts: AssignmentContract[]): string {
  if ((!workOrder.rootRunId || workOrder.rootRunId === run.id) && run.answer?.trim()) return run.answer;
  return contracts.flatMap((contract) => (contract.delivery?.summary ? [contract.delivery.summary] : [])).join('\n\n');
}
