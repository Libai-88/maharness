import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../agent';
import type { EventBusLike, KernelLike, LLMChunk, LLMMessage, ProviderDef, StepHandle, TraceStepInit } from '../../../kernel/types';

const bus: EventBusLike = {
  on: () => () => {}, emit: () => {}, emitAsync: async () => {}, serial: async () => undefined,
  bail: () => undefined, parallel: async () => {}, waterfall: async () => undefined as never,
  onPhase: () => () => {},
};

describe('Context Provider 预算与来源', () => {
  test('单 provider maxTokens 生效，来源写入 Trace', async () => {
    const finished: string[] = [];
    const config = new Map<string, unknown>([
      ['agent.toolTimeoutMs', 1000], ['agent.reasoningBudget', 640], ['agent.reasoningTotalBudget', 2000],
      ['agent.maxTurns', 1], ['agent.thinkInEnglish', false], ['sandboxRoot', process.cwd()],
    ]);
    const contexts = [
      { context: { id: 'too-big', description: 'big', weight: 10, maxTokens: 1, contentFn: () => ({ content: 'L'.repeat(100), source: 'big' }) } },
      { context: { id: 'skills-index', description: 'skills', weight: 5, maxTokens: 100, contentFn: () => ({ content: 'SKILL-CONTEXT', source: 'skills' }) } },
    ];
    const kernel = {
      rootDir: process.cwd(),
      paths: { root: process.cwd(), data: process.cwd(), traces: process.cwd(), configFile: '', dbFile: '', cacheFile: '' },
      config: { get: <T>(key: string, def?: T): T => (config.has(key) ? config.get(key) as T : def as T) } as unknown as KernelLike['config'],
      trace: {
        startStep: (_init: TraceStepInit): StepHandle => ({
          id: 'ctx', finish: (extra) => { if (extra?.outputSummary) finished.push(extra.outputSummary); }, fail: () => {}, cancel: () => {},
        }),
      } as unknown as KernelLike['trace'],
      cache: {
        l1Enabled: false, l1Get: async () => ({ hit: false }), l1Set: async () => {},
        recordPrefixRepeat: () => {}, recordProviderCacheHit: () => {}, recordSavedCost: () => {},
      } as unknown as KernelLike['cache'],
      budget: { recordTask: () => {} } as unknown as KernelLike['budget'],
      plugins: { capabilities: (kind: string) => kind === 'context' ? contexts : [] } as unknown as KernelLike['plugins'],
    } as KernelLike;
    let sent: LLMMessage[] = [];
    const provider: ProviderDef = {
      id: 'ctx-provider', label: 'ctx-provider', defaultModel: 'm',
      async *chat(messages): AsyncIterable<LLMChunk> {
        sent = messages;
        yield { type: 'delta', text: 'done' };
        yield { type: 'done' };
      },
    };
    for await (const _event of new AgentRunner(kernel, bus).run({
      provider, model: 'm', messages: [{ role: 'user', content: 'question' }], traceId: 'ctx-test', maxTurns: 1,
    })) { /* drain */ }
    const joined = sent.map((m) => m.content ?? '').join('\n');
    assert.match(joined, /SKILL-CONTEXT/);
    assert.doesNotMatch(joined, /L{100}/);
    assert.ok(finished.some((line) => line.includes('skills-index/skills')));
  });
});
