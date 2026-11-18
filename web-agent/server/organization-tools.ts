import type { ToolContext, ToolDef, ToolResult } from '../kernel/types';
import type { Store } from './db';
import { isOrganizationError, OrganizationService, type AssignmentDraft } from './organization';
import type { EvidenceRef, ExceptionCase } from './organization-store';

function toolFailure(error: unknown): ToolResult {
  if (isOrganizationError(error)) {
    return {
      ok: false,
      error: error.message,
      failure: { code: error.code, retryable: error.retryable, outcome: 'not_started' },
    };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    failure: { code: 'WORKBENCH_ERROR', retryable: false, outcome: 'not_started' },
  };
}

export function organizationTools(service: OrganizationService, store: Store): ToolDef[] {
  const requireRun = (ctx: ToolContext) => {
    if (!ctx.runId) throw new Error('组织能力必须在任务运行中使用');
    const run = store.runs.get(ctx.runId, ctx.tenantId ?? 'default');
    if (!run) throw new Error('当前任务不存在');
    return run;
  };

  return [
    {
      version: '1.0.0',
      permissions: ['workspace.read'],
      name: 'role_directory',
      discovery: { initial: true, keywords: ['角色', '组织', '分工', 'role', 'team'] },
      risk: 'low',
      costHint: 'low',
      sideEffect: 'read',
      outputSchema: { type: 'object', required: ['roles', 'scorecards'], properties: { roles: { type: 'array' }, scorecards: { type: 'array' } } },
      description: '查看当前租户可复用的 AI 角色及其客观履历。履历只来自已完成契约；样本不足时只作弱提示。',
      parameters: { type: 'object', properties: { projectId: { type: 'string' }, includePaused: { type: 'boolean' } }, additionalProperties: false },
      async handler(args: { projectId?: string; includePaused?: boolean }, ctx) {
        try {
          const tenantId = ctx.tenantId ?? 'default';
          const roles = store.organization.listRoles(tenantId, args.projectId, args.includePaused === true);
          const scorecards = service.scorecards(tenantId).filter(card => roles.some(role => role.id === card.roleId));
          return { ok: true, data: { roles, scorecards } };
        } catch (error) { return toolFailure(error); }
      },
    },
    {
      version: '1.0.0', permissions: ['workspace.read'], name: 'role_assume',
      discovery: { initial: true, keywords: ['角色', '指定角色', 'role'] },
      risk: 'low', costHint: 'low', sideEffect: 'write', outputSchema: { type: 'object' },
      description: '按用户要求或任务需要选择 role_directory 中的持久角色承接当前任务，保留同一工作单和 Run，权限只可收窄。已有团队或子任务不能切换。',
      parameters: { type: 'object', properties: { roleId: { type: 'string' } }, required: ['roleId'], additionalProperties: false },
      async handler(args: { roleId: string }, ctx) {
        try { return { ok: true, data: service.assumeRole(requireRun(ctx), args.roleId) }; }
        catch (error) { return toolFailure(error); }
      },
    },
    {
      version: '1.0.0',
      permissions: ['delegate'],
      name: 'team_create',
      discovery: { initial: true, keywords: ['团队', '组队', '并行', '分工', 'contract', 'team'] },
      delegates: true,
      risk: 'low',
      costHint: 'high',
      sideEffect: 'write',
      outputSchema: {
        type: 'object', required: ['teamCycle', 'contracts', 'economics'],
        properties: { teamCycle: { type: 'object' }, contracts: { type: 'array' }, economics: { type: 'object' } },
      },
      description: '按角色能力建立 2-5 个互不重叠的可交付分支，至少两个独立分支。预算可省略，显式预算继续生效；简单任务直接执行。成功后下轮加载委派工具。',
      parameters: {
        type: 'object',
        properties: {
          assignments: {
            type: 'array', minItems: 2, maxItems: 5,
            items: {
              type: 'object',
              required: ['objective', 'expectedArtifacts', 'acceptance'],
              properties: {
                roleId: { type: 'string' },
                roleName: { type: 'string' },
                objective: { type: 'string' },
                expectedArtifacts: { type: 'array', description: '分支承诺交付的文件相对路径；只交分析或结论时填空数组', items: { type: 'string' } },
                acceptance: { type: 'array', minItems: 1, items: { type: 'string' } },
                evidenceInputs: { type: 'array', items: { type: 'object' } },
                dependsOn: { type: 'array', items: { type: 'string' } },
                budgetUsd: { type: 'number', exclusiveMinimum: 0 },
                allowedTools: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          singleAgentEstimateUsd: { type: 'number', minimum: 0 },
          teamEstimateUsd: { type: 'number', exclusiveMinimum: 0 },
          reason: { type: 'string' },
        },
        required: ['assignments'],
        additionalProperties: false,
      },
      async handler(args: {
        assignments?: AssignmentDraft[];
        singleAgentEstimateUsd?: number;
        teamEstimateUsd?: number;
        reason?: string;
      }, ctx) {
        try {
          const run = requireRun(ctx);
          return {
            ok: true,
            data: service.createTeam(run, {
              assignments: args.assignments ?? [],
              singleAgentEstimateUsd: args.singleAgentEstimateUsd,
              teamEstimateUsd: args.teamEstimateUsd,
              reason: args.reason,
            }),
          };
        } catch (error) { return toolFailure(error); }
      },
    },
    {
      version: '1.0.0',
      permissions: ['delegate'],
      name: 'work_contract_deliver',
      discovery: { initial: false, keywords: ['交付', '契约', '回执', 'contract'] },
      risk: 'low',
      costHint: 'low',
      sideEffect: 'write',
      outputSchema: { type: 'object', required: ['id', 'status', 'delivery'], properties: { id: { type: 'string' }, status: { type: 'string' }, delivery: { type: 'object' } } },
      description: '为已结束的子任务登记契约交付摘要、产物、证据和未完成项。交付状态由运行事实决定。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          artifacts: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'object' } },
          unfinished: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      async handler(args: { summary?: string; artifacts?: string[]; evidence?: EvidenceRef[]; unfinished?: string[] }, ctx) {
        try {
          const run = requireRun(ctx);
          return {
            ok: true,
            data: service.deliver(run.id, run.tenantId, {
              summary: args.summary ?? '', artifacts: args.artifacts,
              evidence: args.evidence, unfinished: args.unfinished,
            }),
          };
        } catch (error) { return toolFailure(error); }
      },
    },
    {
      version: '1.0.0',
      permissions: ['workspace.read'],
      name: 'raise_exception',
      discovery: { initial: false, keywords: ['异常', '冲突', '超载', '权限', '预算', 'exception'] },
      risk: 'low',
      costHint: 'low',
      sideEffect: 'write',
      outputSchema: { type: 'object', required: ['id', 'status', 'requiresHuman'], properties: { id: { type: 'string' }, status: { type: 'string' }, requiresHuman: { type: 'boolean' } } },
      description: '提交结构化异常。maharness 先裁决已记录事实；费用、权限和价值取舍等待人类。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['ambiguity', 'rule-conflict', 'tool-failure', 'budget', 'authority', 'handoff', 'overload', 'opinion-conflict'] },
          summary: { type: 'string' },
          facts: { type: 'array', minItems: 1, items: { type: 'string' } },
          contractId: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object' } },
        },
        required: ['kind', 'summary', 'facts'],
        additionalProperties: false,
      },
      async handler(args: {
        kind?: ExceptionCase['kind'];
        summary?: string;
        facts?: string[];
        contractId?: string;
        evidence?: EvidenceRef[];
      }, ctx) {
        try {
          const run = requireRun(ctx);
          const workOrder = service.workOrderForRun(run);
          return {
            ok: true,
            data: service.raiseException({
              tenantId: run.tenantId,
              workOrderId: workOrder.id,
              contractId: args.contractId,
              kind: args.kind ?? 'ambiguity',
              summary: args.summary ?? '',
              facts: args.facts ?? [],
              evidence: args.evidence,
              createdBy: 'ai',
            }),
          };
        } catch (error) { return toolFailure(error); }
      },
    },
    {
      version: '1.0.0',
      permissions: ['workspace.read'],
      name: 'role_scorecard',
      discovery: { initial: false, keywords: ['履历', '评分', '表现', 'scorecard'] },
      risk: 'low',
      costHint: 'low',
      sideEffect: 'read',
      outputSchema: { type: 'object', required: ['scorecards'], properties: { scorecards: { type: 'array' } } },
      description: '读取由实际契约结果计算的客观角色履历。样本不足时不会产生高置信排名。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async handler(_args, ctx) {
        try { return { ok: true, data: { scorecards: service.scorecards(ctx.tenantId ?? 'default') } }; }
        catch (error) { return toolFailure(error); }
      },
    },
  ];
}
