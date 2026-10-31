import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from '../../core/chat/agent';
import { recordTools, stubTools, type ToolRecording } from '../tool-replay';
import type { EventBusLike, KernelLike, LLMChunk, ProviderDef, StepHandle, ToolDef, TraceStepInit } from '../types';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

/** 真实副作用工具：写文件 + 计数。回放阶段若 handler 被执行，此处立刻暴露。 */
function makeRealTool(sandboxDir: string, counter: { n: number }): ToolDef {
  return {
    name: 'mutate_fixture',
    description: 'writes a fixture file (real side effect)',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    async handler(args) {
      counter.n++;
      const { path, content } = args as { path: string; content: string };
      writeFileSync(join(sandboxDir, path), content, 'utf8');
      return { ok: true, data: { written: path } };
    },
  };
}

function fixture(contextMaxTokens = 60_000) {
  const rootDir = process.cwd();
  const cfg = new Map<string, unknown>([
    ['agent.toolTimeoutMs', 1000], ['agent.maxTurns', 4], ['context.maxTokens', contextMaxTokens],
  ]);
  const kernel = {
    rootDir,
    paths: { root: rootDir, data: rootDir, traces: rootDir, configFile: '', dbFile: '', cacheFile: '' },
    config: { get: <T>(key: string, def?: T): T => (cfg.has(key) ? cfg.get(key) as T : def as T) },
    trace: { startStep: (_init: TraceStepInit): StepHandle => ({ id: 'step', finish: () => {}, fail: () => {}, cancel: () => {} }) },
    cache: {
      l1Enabled: true, l1Get: async () => ({ hit: false }), l1Set: async () => {},
      recordPrefixRepeat: () => {}, recordProviderCacheHit: () => {}, recordSavedCost: () => {},
    },
    budget: { recordTask: () => {} },
    plugins: { capabilities: (): [] => [] },
  } as unknown as KernelLike;
  return kernel;
}

/** 确定性 LLM：第 1 次调用发起工具调用，第 2 次给最终答案。args 键序可变。 */
function scriptedProvider(argsJson: string): ProviderDef {
  let calls = 0;
  return {
    id: 'mock', label: 'MOCK', defaultModel: 'm',
    async *chat(): AsyncIterable<LLMChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', toolCall: { id: 'c1', type: 'function', function: { name: 'mutate_fixture', arguments: argsJson } } };
        yield { type: 'done' };
        return;
      }
      yield { type: 'delta', text: 'completed golden' };
      yield { type: 'usage', input: 10, output: 2 };
      yield { type: 'done' };
    },
  };
}

async function runOnce(kernel: KernelLike, provider: ProviderDef, tools: ToolDef[], traceId: string) {
  const events: import('../loop').AgentEvent[] = [];
  for await (const event of new AgentRunner(kernel, bus).run({
    provider, model: 'm', messages: [{ role: 'user', content: 'do the work' }],
    traceId, maxTurns: 4, tools,
  })) events.push(event);
  return events;
}

function finalAnswer(events: import('../loop').AgentEvent[]): string {
  const done = events.find((e) => e.type === 'assistant_done') as { content?: string } | undefined;
  return done?.content ?? '';
}

describe('工具录音与安全重放（OB-05）', () => {
  test('桩模式按名+参数复现工具结果，真实副作用不执行', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'mh-tool-replay-'));
    const counter = { n: 0 };
    try {
      const kernel = fixture();
      const realTool = makeRealTool(sandboxDir, counter);

      // 录制 run：真实执行（副作用发生），录音捕获参数与结果。
      const { tools: recorded, recording } = recordTools([realTool]);
      const recEvents = await runOnce(kernel, scriptedProvider(JSON.stringify({ path: 'golden.txt', content: 'golden' })), recorded, 'replay-record');
      assert.equal(counter.n, 1, '录制阶段真实执行一次');
      assert.equal(existsSync(join(sandboxDir, 'golden.txt')), true);
      assert.deepEqual(recording.calls.map((c) => c.name), ['mutate_fixture']);
      assert.equal(recording.calls[0]?.result.ok, true);
      const goldenAnswer = finalAnswer(recEvents);
      assert.match(goldenAnswer, /completed golden/);

      // 重放 run：删除文件使「真实执行」必然可检测；LLM 参数键序不同但语义相同。
      rmSync(join(sandboxDir, 'golden.txt'));
      const { tools: stubbed, calls: stubCalls } = stubTools([realTool], recording);
      const replayEvents = await runOnce(kernel, scriptedProvider(JSON.stringify({ content: 'golden', path: 'golden.txt' })), stubbed, 'replay-run');
      assert.equal(counter.n, 1, '重放阶段真实 handler 未执行');
      assert.equal(existsSync(join(sandboxDir, 'golden.txt')), false, '重放不产生真实副作用');
      assert.deepEqual(stubCalls.map((c) => c.name), ['mutate_fixture']);
      assert.equal(finalAnswer(replayEvents), goldenAnswer, '桩模式复现 golden 最终答案');
      assert.ok(replayEvents.some((e) => e.type === 'tool_result' && e.ok));

      // 参数与录音不一致 → fail-closed 报错，不执行真实工具。
      const { tools: strictStubbed } = stubTools([realTool], recording);
      const driftEvents = await runOnce(kernel, scriptedProvider(JSON.stringify({ path: 'drift.txt', content: 'unexpected' })), strictStubbed, 'replay-drift');
      assert.ok(driftEvents.some((e) => e.type === 'tool_result' && !e.ok && /安全重放匹配失败/.test(e.summary)), '参数漂移必须 fail-closed');
      assert.equal(driftEvents.some((e) => e.type === 'tool_result' && e.ok), false, '漂移场景不得产生成功的工具结果');
      assert.equal(counter.n, 1, '漂移场景仍不执行真实工具');
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  test('录音中不存在的工具直接拒绝（不静默回退真实执行）', () => {
    const recording: ToolRecording = { version: 1, calls: [] };
    const tool = makeRealTool(tmpdir(), { n: 0 });
    assert.throws(() => stubTools([tool], recording), /录音中没有工具/);
  });
});
