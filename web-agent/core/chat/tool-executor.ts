import type { RunOptions } from '../../kernel/plugin-sdk';
import type { ToolContext, ToolDef, ToolResult } from '../../kernel/plugin-sdk';
import { acquireWriteLock } from '../../kernel/plugin-sdk';
import { classifyError, shouldRetry } from '../../kernel/plugin-sdk';
import { TaskStoppedError } from './provider-health';
import { validateToolArguments, validateAgainstSchema } from '../../kernel/plugin-sdk';
import { assessToolApproval } from './tool-approval';
import { effectiveToolSideEffect } from '../../kernel/plugin-sdk';

interface ToolExecutionOptions {
  tool: ToolDef;
  args: unknown;
  context: ToolContext;
  runId?: string;
  parentRunId?: string;
  acquireExecution?: RunOptions['acquireExecution'];
  effectJournal?: RunOptions['effectJournal'];
  effectKey?: string;
  effectStarted: boolean;
  timeoutMs: number;
  policyApproved: boolean;
}

/** Owns physical tool capacity, cancellation and safe retry boundaries. */
export class ToolExecutor {
  effectStarted: boolean;
  constructor(private readonly options: ToolExecutionOptions) {
    this.effectStarted = options.effectStarted;
  }
  async invoke(approved: boolean, approvalId?: string): Promise<ToolResult> {
    const options = this.options;
    const { tool, effectKey } = options;
    const tctx = options.context;
    const signal = tctx.signal;
    const sandboxRoot = tctx.sandboxRoot;
    const sideEffect = effectiveToolSideEffect(tool, options.args);
    if (signal?.aborted) throw new TaskStoppedError('已停止');
    const denied =
      (tctx.principal?.role === 'readonly' && !tool.delegates && sideEffect !== 'none' && sideEffect !== 'read') ||
      (tool.permissions.includes('admin') && tctx.principal !== undefined && tctx.principal.role !== 'admin');
    if (denied)
      return { ok: false, error: '当前用户无权执行此操作', failure: { code: 'TOOL_PERMISSION', retryable: false, outcome: 'not_started' } };
    if (tctx.authorization?.readOnly && !tool.delegates && sideEffect !== 'none' && sideEffect !== 'read' && !approved)
      return { ok: false, needsApproval: true, approvalSummary: '当前任务的写入和外部变更需要用户批准' };
    if (!approved && !options.policyApproved) {
      const gate = assessToolApproval(tool, options.args, tctx);
      if (gate.needsApproval) return { ok: false, needsApproval: true, approvalSummary: gate.reason };
    }
    const issues = validateToolArguments(tool, options.args);
    if (issues.length)
      return { ok: false, error: issues.join('；'), failure: { code: 'TOOL_ARGS_SCHEMA', retryable: false, outcome: 'not_started' } };
    try {
      tctx.quota?.assertToolCall?.();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: { code: 'TOOL_QUOTA', retryable: false, outcome: 'not_started' },
      };
    }
    const readOnlyEffect = sideEffect === 'none' || sideEffect === 'read';
    const replaySafeEffect = readOnlyEffect && !tool.invokesTools;
    const maxAttempts =
      replaySafeEffect && tool.idempotent && tool.retry ? Math.max(1, Math.min(3, Math.floor(tool.retry.maxAttempts ?? 2))) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ac = new AbortController();
      const onClientAbort = () => ac.abort();
      if (signal?.aborted) ac.abort();
      else signal?.addEventListener('abort', onClientAbort, { once: true });
      let attemptResult: ToolResult;
      let release: (() => void) | undefined;
      let releaseWrite: (() => void) | undefined;
      let handlerStarted = false;
      let handlerSettled = false;
      const cleanup = () => {
        release?.();
        release = undefined;
        releaseWrite?.();
        releaseWrite = undefined;
        signal?.removeEventListener('abort', onClientAbort);
      };
      try {
        if (options.runId && !readOnlyEffect && !tool.delegates && !tool.invokesTools)
          releaseWrite = await acquireWriteLock(sandboxRoot, options.parentRunId ?? options.runId, ac.signal);
        if (!tool.delegates && !tool.invokesTools) release = await options.acquireExecution?.(ac.signal);
        if (ac.signal.aborted) throw new TaskStoppedError('已停止');
        if (effectKey && options.effectJournal && !this.effectStarted) {
          const claim = options.effectJournal.claim(effectKey);
          if (claim.state === 'done' && claim.result) return claim.result;
          if (claim.state === 'pending')
            return {
              ok: false,
              error: '操作执行结果未知，禁止自动重放',
              failure: { code: 'EFFECT_OUTCOME_UNKNOWN', retryable: false, outcome: 'unknown' },
            };
          this.effectStarted = true;
        }
        const timeoutMs = tool.executionTimeoutMs?.(options.args) ?? tool.timeoutMs ?? (tool.invokesTools ? 0 : options.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('TOOL_TIMEOUT_INVALID');
        handlerStarted = true;
        const handler = Promise.resolve().then(() =>
          tool.handler(options.args, {
            ...tctx,
            approved,
            approvalId,
            policyApproved: options.policyApproved === true,
            signal: ac.signal,
            invoke: tctx.invoke ? (name, args) => tctx.invoke!(name, args, ac.signal) : undefined,
            delegate: tctx.delegate
              ? (request, signal) => tctx.delegate!(request, signal ? AbortSignal.any([ac.signal, signal]) : ac.signal)
              : undefined,
          }),
        );
        const execution = handler.finally(() => {
          handlerSettled = true;
          cleanup();
        });
        attemptResult = await withToolTimeout(execution, timeoutMs, () => ac.abort());
      } catch (err) {
        attemptResult = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          failure: {
            code: ac.signal.aborted ? 'TOOL_INTERRUPTED' : 'TOOL_EXECUTION',
            retryable: replaySafeEffect,
            outcome: replaySafeEffect || !handlerStarted ? 'not_started' : 'unknown',
          },
        };
      } finally {
        // A timeout reports uncertainty; physical capacity remains occupied until the handler exits.
        if (!handlerStarted) cleanup();
      }
      const retry =
        handlerSettled &&
        !attemptResult.ok &&
        attempt + 1 < maxAttempts &&
        shouldRetry(new Error(attemptResult.error ?? '工具失败'), attempt, maxAttempts);
      if (!retry) {
        if (attemptResult.needsApproval && effectKey && this.effectStarted && options.effectJournal?.release) {
          options.effectJournal.release(effectKey);
          this.effectStarted = false;
        }
        if (attemptResult.ok && validateAgainstSchema(attemptResult.data, tool.outputSchema).length)
          return {
            ...attemptResult,
            ok: false,
            error: `工具 ${tool.name} 输出不符合 schema`,
            failure: {
              code: 'TOOL_OUTPUT_SCHEMA',
              retryable: false,
              outcome: replaySafeEffect ? 'not_started' : tool.invokesTools ? 'unknown' : 'applied',
            },
          };
        if (!attemptResult.ok && !attemptResult.needsApproval && !attemptResult.failure)
          return {
            ...attemptResult,
            failure: {
              code: 'TOOL_EXECUTION',
              retryable: replaySafeEffect,
              outcome: replaySafeEffect || !handlerStarted ? 'not_started' : 'unknown',
            },
          };
        return attemptResult;
      }
      const classified = classifyError(new Error(attemptResult.error ?? '工具失败'));
      const delay = tool.retry?.backoffMs ?? classified.retryDelayMs;
      tctx.trace
        .startStep({
          traceId: tctx.traceId ?? options.runId ?? 'tool',
          turn: tctx.turn,
          type: 'system',
          name: 'tool-retry',
          parentId: tctx.stepId,
        })
        .finish({
          outputSummary: `${tool.name}: ${classified.code}，${delay}ms 后重试`,
          errorCategory: classified.category,
          retryable: true,
          retryDelayMs: delay,
        });
      try {
        await abortableDelay(delay, signal);
      } catch (err) {
        if (signal?.aborted) return { ok: false, error: '已停止' };
        throw err;
      }
    }
    return { ok: false, error: '工具重试耗尽' };
  }
}

async function withToolTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  if (!ms || ms <= 0) return p;
  // 超时后 handler 才 reject 的场景：race 已由 timeout 分支收场，迟到 rejection
  // 无人消费会变 unhandledRejection——此处预标记为已处理（不改变正常路径传播）
  p.catch(() => {
    /* 迟到 rejection 已处理 */
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`工具执行超时（${ms / 1000}s）`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new TaskStoppedError('已停止'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new TaskStoppedError('已停止'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
