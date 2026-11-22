// server/run/executor.ts —— 一次 Run 的执行循环编排（ADR 0008）
//
// 从 run-service.ts 原样迁移，再按复杂度预算拆成 start / flow 两个协作模块：
// 语句顺序、事务边界、事件先后都不动，任何"顺手优化"都会改变审批/预算时序。
import { inModelScope } from '../../kernel/model-call';
import type { RunRecord } from '../../kernel/run';
import type { TaskPluginSession } from '../../kernel/task-plugins';
import { buildRunnerInput, consumeEvent, shutdownRun, type RunLoopState } from './executor-flow';
import { startExecution, type ExecutorRuntime } from './executor-start';
import { finishRun } from './executor-support';

export type { ExecutorRuntime } from './executor-start';

export async function executeRun(runtime: ExecutorRuntime, record: RunRecord, abort: AbortController, resumed: boolean): Promise<void> {
  const repo = runtime.env.store.runs;
  let plugins: TaskPluginSession | undefined;
  const state: RunLoopState = { reasoning: '', completed: false, nonRecoverable: false };
  try {
    const ctx = await startExecution(runtime, repo, record, abort, resumed);
    if (!ctx) return;
    plugins = ctx.plugins;
    const input = buildRunnerInput(runtime, repo, record, abort, ctx);
    for await (const event of inModelScope(ctx.runner.run(input), ctx.account.scope())) {
      consumeEvent(runtime, repo, record, event, ctx.account, state);
    }
    if (!abort.signal.aborted) finishRun(runtime, repo, record, ctx.options, state.completed, state.nonRecoverable);
  } catch (error) {
    if (!abort.signal.aborted)
      runtime.publish(repo.update(record, { status: 'failed', error: error instanceof Error ? error.message : String(error) }));
  } finally {
    await shutdownRun(runtime, repo, record, abort, plugins);
  }
}
