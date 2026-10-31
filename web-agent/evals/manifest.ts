import { readFileSync } from 'node:fs';
import { validateAgainstSchema } from '../kernel/validate';
import type { TaskContract, TaskCriterion } from '../kernel/task-verifier';

const schema = JSON.parse(readFileSync(new URL('./case.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const CHUNK_TYPES = new Set(['delta', 'reasoning', 'tool_call', 'usage', 'done', 'throw']);
const TASK_CRITERIA = new Set(['output_contains', 'output_matches', 'tool_succeeded', 'file_exists', 'file_contains']);

export interface EvalCase {
  schemaVersion: 1;
  name: string;
  description?: string;
  sandbox?: { files?: Record<string, string> };
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  requests: { chunks: { type: string; [key: string]: unknown }[] }[];
  task?: TaskContract;
  approval?: { toolName: string; decision: 'approve' | 'reject' };
  recovery?: { toolName: string; checkpointAfterTurn: number };
  securityAttack?:
    | { category: 'user_prompt_injection'; payload: string; protectedTool: string }
    | { category: 'tool_output_injection' | 'plugin_tool_output_injection'; sourceTool: string; payload: string; protectedTool: string }
    | { category: 'plugin_capability_escalation'; allowedName: string; attemptedName: string };
  expect: {
    repeats?: number;
    toolSequence?: string[];
    answerContains?: string[];
    llmCalls?: number;
    cachedOn?: number[];
    noErrors?: boolean;
    taskOutcome?: 'verified' | 'partial' | 'failed';
    approvalOutcome?: 'approved' | 'rejected';
    approvalHandlerCalls?: number;
    recoveryToolCalls?: number;
    securityOutcome?: 'blocked';
  };
}

export function validateEvalCase(value: unknown, source = '<case>'): EvalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: case 必须是 JSON 对象`);
  }
  const raw = value as Record<string, unknown>;
  const version = raw.schemaVersion ?? 1;
  if (version !== 1) throw new Error(`${source}: 不支持的 schemaVersion ${String(version)}`);
  const normalized = { ...raw, schemaVersion: 1 };
  const issues = validateAgainstSchema(normalized, schema);
  if (issues.length) throw new Error(`${source}: manifest 无效：${issues.join('；')}`);

  const c = normalized as unknown as EvalCase;
  if (!c.messages.length) throw new Error(`${source}: messages 不能为空`);
  if (!c.requests.length || c.requests.some((request) => !request.chunks.length)) {
    throw new Error(`${source}: requests 与每个 chunks 均不能为空`);
  }
  for (const [ri, request] of c.requests.entries()) {
    for (const [ci, chunk] of request.chunks.entries()) {
      const at = `${source}: requests[${ri}].chunks[${ci}]`;
      if (!CHUNK_TYPES.has(chunk.type)) throw new Error(`${at}: 未知 chunk type ${chunk.type}`);
      if (['delta', 'reasoning'].includes(chunk.type) && typeof chunk.text !== 'string') throw new Error(`${at}: ${chunk.type} 必须提供 text`);
      if (chunk.type === 'usage' && (!isNonNegativeNumber(chunk.input) || !isNonNegativeNumber(chunk.output))) {
        throw new Error(`${at}: usage 必须提供非负 input/output`);
      }
      if (chunk.type === 'throw' && chunk.message !== undefined && typeof chunk.message !== 'string') throw new Error(`${at}: throw.message 必须是字符串`);
      if (chunk.type === 'throw' && chunk.status !== undefined && !isNonNegativeNumber(chunk.status)) throw new Error(`${at}: throw.status 必须是非负数`);
      if (chunk.type === 'throw' && chunk.name !== undefined && typeof chunk.name !== 'string') throw new Error(`${at}: throw.name 必须是字符串`);
      if (chunk.type === 'tool_call' && !isToolCallChunk(chunk)) throw new Error(`${at}: tool_call 结构无效`);
      if (chunk.type === 'tool_call' && isToolCallChunk(chunk)) {
        const args = ((chunk.toolCall as { function: { arguments: string } }).function.arguments);
        try {
          const parsed = JSON.parse(args) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch { throw new Error(`${at}: tool_call arguments 必须是 JSON 对象`); }
      }
    }
  }
  if (c.sandbox?.files && Object.values(c.sandbox.files).some((content) => typeof content !== 'string')) {
    throw new Error(`${source}: sandbox.files 的值必须是字符串`);
  }
  if (c.task && !isTaskContract(c.task)) throw new Error(`${source}: task contract 无效`);
  if (c.recovery && (!c.task?.acceptance.some((item) => item.type === 'tool_succeeded' && item.name === c.recovery?.toolName))) {
    throw new Error(`${source}: recovery 必须通过 task.tool_succeeded 验收恢复工具`);
  }
  if (c.recovery && c.expect.recoveryToolCalls === undefined) throw new Error(`${source}: recovery 必须断言 expect.recoveryToolCalls`);
  if (c.securityAttack?.category === 'plugin_capability_escalation'
    && (!c.securityAttack.allowedName.trim() || !c.securityAttack.attemptedName.trim() || c.securityAttack.allowedName === c.securityAttack.attemptedName)) {
    throw new Error(`${source}: securityAttack capability 配置无效`);
  }
  if (c.securityAttack && c.securityAttack.category !== 'plugin_capability_escalation'
    && (!c.securityAttack.payload.trim() || (c.securityAttack.category !== 'user_prompt_injection' && c.securityAttack.sourceTool === c.securityAttack.protectedTool))) {
    throw new Error(`${source}: securityAttack payload 或工具配置无效`);
  }
  if (c.securityAttack?.category === 'plugin_capability_escalation') {
    if (c.expect.securityOutcome !== 'blocked' || c.expect.approvalOutcome !== undefined) {
      throw new Error(`${source}: capability 越权 case 必须断言 blocked 且不得要求审批结果`);
    }
  } else if (c.securityAttack && (c.expect.securityOutcome !== 'blocked' || c.expect.approvalOutcome !== 'rejected')) {
    throw new Error(`${source}: 安全攻击 case 必须断言 blocked 与 rejected`);
  }
  if (c.expect.cachedOn?.some((run) => run > (c.expect.repeats ?? 1))) {
    throw new Error(`${source}: expect.cachedOn 不能超过 expect.repeats`);
  }
  if (c.approval && c.expect.approvalOutcome && !c.expect.approvalHandlerCalls && c.approval.decision === 'approve') {
    throw new Error(`${source}: approval 通过场景必须显式断言 approvalHandlerCalls`);
  }
  return c;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isToolCallChunk(chunk: Record<string, unknown>): boolean {
  const call = chunk.toolCall;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
  const fn = (call as Record<string, unknown>).function;
  return typeof (call as Record<string, unknown>).id === 'string'
    && (call as Record<string, unknown>).type === 'function'
    && !!fn && typeof fn === 'object' && !Array.isArray(fn)
    && typeof (fn as Record<string, unknown>).name === 'string'
    && typeof (fn as Record<string, unknown>).arguments === 'string';
}

function isTaskContract(task: TaskContract): boolean {
  if (!task.objective || !Array.isArray(task.acceptance) || !task.acceptance.length) return false;
  return task.acceptance.every((criterion: TaskCriterion) => {
    if (!criterion || !TASK_CRITERIA.has(criterion.type)) return false;
    if (criterion.type === 'output_contains') return typeof criterion.value === 'string' && criterion.value.length > 0;
    if (criterion.type === 'output_matches') {
      if (typeof criterion.pattern !== 'string' || (criterion.flags !== undefined && typeof criterion.flags !== 'string')) return false;
      try { new RegExp(criterion.pattern, criterion.flags); return true; } catch { return false; }
    }
    if (criterion.type === 'tool_succeeded') return typeof criterion.name === 'string' && criterion.name.length > 0;
    if (criterion.type === 'file_exists') return typeof criterion.path === 'string' && criterion.path.length > 0;
    return typeof criterion.path === 'string' && criterion.path.length > 0 && typeof criterion.value === 'string';
  });
}
