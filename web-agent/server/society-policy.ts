import { createHash } from 'node:crypto';
import {
  OrganizationError,
  type InstitutionPolicies,
} from './organization-store';

/** Default institution policy. Kept separate from scheduling so policy changes are auditable. */
export const DEFAULT_POLICIES: InstitutionPolicies = {
  schemaVersion: 1,
  societyBudgetUsd: 20,
  societyTokenBudget: 2_000_000,
  minNetBenefitUsd: 0.01,
  maxTeamSize: 4,
  welfareMaxActiveAssignments: 2,
  highSpendApprovalUsd: 2,
  maxQueuedPerDepartment: 25,
  roleSelectionWeights: {
    capability: 0.3,
    memory: 0.15,
    tools: 0.15,
    collaboration: 0.1,
    history: 0.15,
    load: 0.15,
  },
  cognitiveRouting: {
    decision: 'configured-primary-model',
    execution: 'configured-role-model-or-tools',
    utility: 'deterministic-tools',
  },
  departments: [
    {
      id: 'operations', name: '综合运营部', charter: '承接办公、文件和轻量自动化交付',
      capabilities: ['coordination', 'files', 'documents', 'automation'],
      quotaUsd: 10, quotaTokens: 1_000_000, maxConcurrent: 4, priority: 1, enabled: true,
    },
    {
      id: 'knowledge', name: '知识与研究部', charter: '检索、阅读、归纳和证据整理',
      capabilities: ['research', 'reading', 'analysis', 'files'],
      quotaUsd: 7, quotaTokens: 700_000, maxConcurrent: 3, priority: 2, enabled: true,
    },
    {
      id: 'quality', name: '质量与审校部', charter: '独立复核、来源核验和交付验收',
      capabilities: ['review', 'analysis', 'quality'],
      quotaUsd: 3, quotaTokens: 300_000, maxConcurrent: 2, priority: 3, enabled: true,
    },
  ],
};

/** Runtime defaults used only when an older institution record has no weights. */
export const ROLE_SELECTION_WEIGHTS = DEFAULT_POLICIES.roleSelectionWeights;

/** Explicitly heuristic composite weights; exposed in snapshots so UI can label it honestly. */
export const SOCIAL_HEALTH_WEIGHTS = {
  loadBalance: 0.2,
  welfare: 0.2,
  exceptionHealth: 0.2,
  budgetHeadroom: 0.2,
  collaborationHealth: 0.2,
} as const;

export const CAPABILITY_ALIASES: Record<string, string[]> = {
  research: ['研究', '论文', '文献', '检索', '资料对比', '来源'],
  reading: ['阅读', '精读', '读懂', '摘要'],
  analysis: ['分析', '归纳', '对比'],
  review: ['审校', '复核', '核验', '验收', '检查', '核对'],
  quality: ['质量', '准确性', '错误'],
  documents: ['文档', 'word', 'docx', 'pdf', '表格', 'xlsx', '演示', 'ppt'],
  files: ['文件', '整理', '批量'],
  automation: ['自动化', '批量处理', '定时'],
  coordination: ['协调', '计划', '排期'],
};

export const CAPABILITY_TOOL_HINTS: Record<string, string[]> = {
  research: ['search', 'fetch', 'browser', 'web'],
  reading: ['read', 'document', 'pdf'],
  analysis: ['read', 'document', 'data', 'analysis'],
  review: ['review', 'read', 'search'],
  quality: ['review', 'read', 'search'],
  documents: ['document', 'docx', 'xlsx', 'pptx', 'write'],
  files: ['file', 'workspace', 'write'],
  automation: ['automation', 'schedule', 'command', 'shell', 'write'],
  coordination: ['plan', 'team', 'subagent', 'task'],
};

export function bounded(value: string, max: number, label: string): string {
  const result = String(value ?? '').trim();
  if (!result) throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `${label}不能为空`);
  if (result.length > max) throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `${label}过长`);
  return result;
}

export function money(value: unknown, label: string, allowZero = false): number {
  const result = Number(value);
  if (!Number.isFinite(result) || (allowZero ? result < 0 : result <= 0))
    throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `${label}必须是${allowZero ? '非负' : '正'}数`);
  return Math.round(result * 1_000_000) / 1_000_000;
}

export function ratio(value: unknown, label: string): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result) || result < 0 || result > 1)
    throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `${label}必须在 0 到 1 之间`);
  return result;
}

export function tokenCount(value: unknown, label: string, allowZero = false): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || (allowZero ? result < 0 : result <= 0))
    throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `${label}必须是${allowZero ? '非负' : '正'}整数`);
  return result;
}

export function validDepartmentId(value: string): string {
  const id = bounded(value, 64, '部门 ID');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id))
    throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', '部门 ID 只能包含字母、数字和连字符');
  return id;
}

export function policyHash(policies: InstitutionPolicies): string {
  return createHash('sha256').update(JSON.stringify(policies)).digest('hex');
}

export function normalizePolicies(input: Partial<InstitutionPolicies>): InstitutionPolicies {
  const departments = (input.departments ?? DEFAULT_POLICIES.departments).map((department, index) => ({
    ...DEFAULT_POLICIES.departments.find(item => item.id === department.id),
    ...department,
    id: validDepartmentId(department.id),
    name: bounded(department.name, 80, `部门 ${index + 1} 名称`),
    charter: bounded(department.charter, 500, `部门 ${index + 1} 职责`),
    capabilities: [...new Set(department.capabilities.map(item => bounded(item, 80, '部门能力')))].slice(0, 20),
    quotaUsd: money(department.quotaUsd, `部门 ${index + 1} 配额`, true),
    quotaTokens: tokenCount(department.quotaTokens, `部门 ${index + 1} token 配额`, true),
    maxConcurrent: Math.max(1, Math.min(100, Math.trunc(Number(department.maxConcurrent) || 1))),
    priority: Math.max(1, Math.min(9, Math.trunc(Number(department.priority) || 5))),
    enabled: department.enabled !== false,
  }));
  if (!departments.length) throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', '至少需要一个部门');
  if (new Set(departments.map(item => item.id)).size !== departments.length)
    throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', '部门 ID 不能重复');
  const maxTeamSize = Math.max(2, Math.min(5, Math.trunc(Number(input.maxTeamSize ?? DEFAULT_POLICIES.maxTeamSize))));
  const rawWeights = { ...DEFAULT_POLICIES.roleSelectionWeights, ...(input.roleSelectionWeights ?? {}) };
  const weightKeys = Object.keys(DEFAULT_POLICIES.roleSelectionWeights) as Array<keyof typeof DEFAULT_POLICIES.roleSelectionWeights>;
  const parsedWeights = Object.fromEntries(weightKeys.map(key => {
    const value = Number(rawWeights[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', `角色选择权重 ${key} 必须是非负数`);
    }
    return [key, value];
  })) as typeof DEFAULT_POLICIES.roleSelectionWeights;
  const weightTotal = weightKeys.reduce((sum, key) => sum + parsedWeights[key], 0);
  if (!(weightTotal > 0)) throw new OrganizationError(400, 'SOCIETY_INPUT_INVALID', '角色选择权重之和必须大于 0');
  const roleSelectionWeights = Object.fromEntries(weightKeys.map(key => [key, parsedWeights[key] / weightTotal])) as typeof parsedWeights;
  return {
    schemaVersion: 1,
    societyBudgetUsd: money(input.societyBudgetUsd ?? DEFAULT_POLICIES.societyBudgetUsd, '社会总预算', true),
    societyTokenBudget: tokenCount(input.societyTokenBudget ?? DEFAULT_POLICIES.societyTokenBudget, '社会 token 总预算', true),
    minNetBenefitUsd: money(input.minNetBenefitUsd ?? DEFAULT_POLICIES.minNetBenefitUsd, '最低净收益', true),
    maxTeamSize,
    welfareMaxActiveAssignments: Math.max(1, Math.min(20, Math.trunc(
      Number(input.welfareMaxActiveAssignments ?? DEFAULT_POLICIES.welfareMaxActiveAssignments),
    ))),
    highSpendApprovalUsd: money(input.highSpendApprovalUsd ?? DEFAULT_POLICIES.highSpendApprovalUsd, '高额审批阈值', true),
    maxQueuedPerDepartment: Math.max(1, Math.min(500, Math.trunc(
      Number(input.maxQueuedPerDepartment ?? DEFAULT_POLICIES.maxQueuedPerDepartment),
    ))),
    roleSelectionWeights,
    cognitiveRouting: { ...DEFAULT_POLICIES.cognitiveRouting, ...input.cognitiveRouting },
    departments,
  };
}
