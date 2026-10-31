import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export type TaskCriterion =
  | { type: 'output_contains'; value: string }
  | { type: 'output_matches'; pattern: string; flags?: string }
  | { type: 'tool_succeeded'; name: string }
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; value: string };

export interface TaskInference {
  /** 0..1; this score describes interpretation confidence, not completion. */
  confidence: number;
  basis: 'explicit' | 'inferred' | 'ambiguous';
  needsConfirmation: boolean;
  rationale: string;
}

export interface TaskContract {
  objective: string;
  acceptance: TaskCriterion[];
  risk?: 'low' | 'medium' | 'high';
  deadlineAt?: number;
  costBudgetUsd?: number;
  idempotencyKey?: string;
  inference?: TaskInference;
}

export interface TaskVerificationInput {
  answer: string;
  toolResults: { name: string; ok: boolean }[];
  sandboxRoot: string;
}

export interface TaskVerificationResult {
  verified: boolean;
  status: 'verified' | 'partial' | 'failed';
  checks: { criterion: TaskCriterion; ok: boolean; reason?: string }[];
  evidence: { criterion: TaskCriterion; source: 'answer' | 'tool' | 'filesystem'; detail: string }[];
}

export function validateTaskContract(contract: TaskContract): string[] {
  const issues: string[] = [];
  if (!contract || typeof contract !== 'object') return ['任务契约必须是对象'];
  if (typeof contract.objective !== 'string' || !contract.objective.trim()) issues.push('objective 必须是非空字符串');
  if (!Array.isArray(contract.acceptance)) issues.push('acceptance 必须是数组');
  if (contract.risk !== undefined && !['low', 'medium', 'high'].includes(contract.risk)) issues.push('risk 必须是 low/medium/high');
  if (contract.deadlineAt !== undefined && (!Number.isSafeInteger(contract.deadlineAt) || contract.deadlineAt <= 0)) issues.push('deadlineAt 必须是正整数时间戳');
  if (contract.costBudgetUsd !== undefined && (!Number.isFinite(contract.costBudgetUsd) || contract.costBudgetUsd <= 0)) issues.push('costBudgetUsd 必须是正数');
  if (contract.inference !== undefined) {
    const inference = contract.inference;
    if (!inference || typeof inference !== 'object') issues.push('inference 必须是对象');
    else {
      if (!Number.isFinite(inference.confidence) || inference.confidence < 0 || inference.confidence > 1) issues.push('inference.confidence 必须是 0 到 1 之间的数');
      if (!['explicit', 'inferred', 'ambiguous'].includes(inference.basis)) issues.push('inference.basis 不受支持');
      if (typeof inference.needsConfirmation !== 'boolean') issues.push('inference.needsConfirmation 必须是布尔值');
      if (typeof inference.rationale !== 'string' || !inference.rationale.trim()) issues.push('inference.rationale 必须是非空字符串');
    }
  }
  if (Array.isArray(contract.acceptance)) contract.acceptance.forEach((criterion, i) => {
    if (!criterion || typeof criterion !== 'object' || typeof criterion.type !== 'string') { issues.push(`acceptance[${i}] 缺少合法 type`); return; }
    if (criterion.type === 'output_contains' && (!criterion.value || typeof criterion.value !== 'string')) issues.push(`acceptance[${i}].value 必须是非空字符串`);
    if (criterion.type === 'output_matches' && (!criterion.pattern || typeof criterion.pattern !== 'string')) issues.push(`acceptance[${i}].pattern 必须是非空字符串`);
    if (criterion.type === 'tool_succeeded' && (!criterion.name || typeof criterion.name !== 'string')) issues.push(`acceptance[${i}].name 必须是非空字符串`);
    if ((criterion.type === 'file_exists' || criterion.type === 'file_contains') && (!criterion.path || typeof criterion.path !== 'string')) issues.push(`acceptance[${i}].path 必须是非空字符串`);
    if (criterion.type === 'file_contains' && (!criterion.value || typeof criterion.value !== 'string')) issues.push(`acceptance[${i}].value 必须是非空字符串`);
    if (!['output_contains', 'output_matches', 'tool_succeeded', 'file_exists', 'file_contains'].includes(criterion.type)) issues.push(`acceptance[${i}].type 不受支持`);
  });
  return issues;
}

function safePath(root: string, path: string): string | undefined {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return undefined;
  return target;
}

export function verifyTaskContract(contract: TaskContract, input: TaskVerificationInput): TaskVerificationResult {
  const schemaIssues = validateTaskContract(contract);
  if (schemaIssues.length) {
    return {
      verified: false,
      status: 'failed',
      checks: [],
      evidence: schemaIssues.map((detail) => ({ criterion: { type: 'output_contains', value: '' }, source: 'answer', detail: `任务契约 schema 错误：${detail}` })),
    };
  }
  const evidence: TaskVerificationResult['evidence'] = [];
  const sourceOf = (criterion: TaskCriterion): TaskVerificationResult['evidence'][number]['source'] => {
    if (criterion.type === 'output_contains' || criterion.type === 'output_matches') return 'answer';
    if (criterion.type === 'tool_succeeded') return 'tool';
    return 'filesystem';
  };
  const checks = contract.acceptance.map((criterion) => {
    try {
      switch (criterion.type) {
        case 'output_contains':
          { const ok = input.answer.includes(criterion.value); evidence.push({ criterion, source: 'answer', detail: ok ? `答案包含：${criterion.value}` : '答案未包含指定文本' }); return { criterion, ok, reason: ok ? '最终答案包含指定文本' : '最终答案未包含指定文本' }; }
        case 'output_matches': {
          const matched = new RegExp(criterion.pattern, criterion.flags).test(input.answer);
          evidence.push({ criterion, source: 'answer', detail: matched ? `答案匹配：/${criterion.pattern}/${criterion.flags ?? ''}` : '答案未匹配表达式' });
          return { criterion, ok: matched, reason: matched ? '最终答案匹配表达式' : '最终答案未匹配表达式' };
        }
        case 'tool_succeeded': {
          const matched = input.toolResults.some((r) => r.name === criterion.name && r.ok);
          evidence.push({ criterion, source: 'tool', detail: matched ? `工具 ${criterion.name} 返回成功` : `工具 ${criterion.name} 没有成功结果` });
          return { criterion, ok: matched, reason: matched ? `工具 ${criterion.name} 已成功` : `工具 ${criterion.name} 未成功` };
        }
        case 'file_exists': {
          const target = safePath(input.sandboxRoot, criterion.path);
          const ok = !!target && existsSync(target);
          evidence.push({ criterion, source: 'filesystem', detail: ok ? `文件存在：${criterion.path}` : `文件不存在或越界：${criterion.path}` });
          return { criterion, ok, reason: ok ? `文件存在：${criterion.path}` : `文件不存在或越界：${criterion.path}` };
        }
        case 'file_contains': {
          const target = safePath(input.sandboxRoot, criterion.path);
          const ok = !!target && existsSync(target) && readFileSync(target, 'utf8').includes(criterion.value);
          evidence.push({ criterion, source: 'filesystem', detail: ok ? `文件包含指定文本：${criterion.path}` : `文件未包含指定文本或越界：${criterion.path}` });
          return { criterion, ok, reason: ok ? `文件包含指定文本：${criterion.path}` : `文件未包含指定文本或越界：${criterion.path}` };
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      evidence.push({ criterion, source: sourceOf(criterion), detail: `验证异常：${reason}` });
      return { criterion, ok: false, reason };
    }
  });
  const passed = checks.filter((check) => check.ok).length;
  const status = checks.length > 0 && passed === checks.length ? 'verified' : passed > 0 ? 'partial' : 'failed';
  return { verified: status === 'verified', status, checks, evidence };
}
