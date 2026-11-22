import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../../kernel';
import { AgentRunner } from '../../core/chat/agent';
import { createResultTool } from '../../core/chat/result-tool';
import { describeModelInput } from '../../kernel/input-diagnostics';
import type { KernelLike, ProviderDef, ToolDef, ToolContext, LLMMessage } from '../../kernel/types';
import { Store } from '../db';
import { RunService, RunError } from '../run-service';
import { LLMHttpError } from '../../core/chat/provider-health';
import type { AgentLoop } from '../../kernel/loop';

async function terminal(service: RunService, id: string) {
  const until = Date.now() + 5000;
  while (!['completed', 'failed', 'interrupted', 'cancelled'].includes(service.get(id, 'default').status)) {
    if (Date.now() > until) throw new Error('Run did not reach terminal state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('custom tools retain long observations and a single runtime instruction across repeated recovery', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mh-input-recovery-'));
  const kernel = new Kernel(workspace);
  const database = join(workspace, 'runs.db');
  let store = new Store(database);
  let calls = 0;
  let reads = 0;
  const maxTurns = 4;
  const observations: LLMMessage[][] = [];
  const tool: ToolDef = {
    name: 'read_long',
    description: 'Read a long observation',
    version: '2.0.0',
    permissions: [],
    sideEffect: 'read',
    parameters: { type: 'object' },
    outputSchema: { type: 'object', required: ['text'] },
    async handler() {
      reads++;
      return { ok: true, data: { text: 'a'.repeat(6000) + 'TAIL_PROOF' } };
    },
  };
  const provider: ProviderDef = {
    id: 'mock',
    label: 'mock',
    defaultModel: 'mock',
    prices: { in: 0, out: 0 },
    async *chat(history, options) {
      observations.push(structuredClone(history));
      assert.equal(history.filter((message) => message.context?.id === 'runtime').length, 1);
      assert.equal(options.tools?.filter((tool) => tool.name === 'recall_tool_result').length, 1);
      if (++calls === 1)
        yield { type: 'tool_call', toolCall: { id: 'long', type: 'function', function: { name: 'read_long', arguments: '{}' } } };
      else if (calls === 2) {
        const observation = JSON.parse(history.find((message) => message.role === 'tool')!.content!);
        assert.equal(typeof observation.resultRef, 'string');
        assert.equal(observation.truncated, true);
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'recall',
            type: 'function',
            function: { name: 'recall_tool_result', arguments: JSON.stringify({ id: observation.resultRef, offset: 5900, limit: 400 }) },
          },
        };
      } else {
        assert.ok(history.some((message) => message.role === 'tool' && message.content?.includes('TAIL_PROOF')));
        assert.equal(history.filter((message) => message.content === 'Preserve the tail.').length, 1);
        yield { type: 'delta', text: 'TAIL_PROOF' };
      }
      yield { type: 'usage', input: 10, output: 5 };
      yield { type: 'done' };
    },
  };
  const environment = () => ({
    store,
    runner: () => new AgentRunner(kernel as unknown as KernelLike, kernel.bus),
    workspace: () => workspace,
    provider: () => ({ id: 'mock', model: 'mock' }),
    prepare: () => ({ provider, model: 'mock', messages: [], traceId: '', tools: [tool], maxTurns }),
  });
  let service = new RunService(environment());
  try {
    const session = store.createSession('mock', 'mock');
    const run = service.create(session, { message: 'Read the tail.' });
    await terminal(service, run.id);
    assert.equal(service.get(run.id, 'default').status, 'interrupted');
    for (let index = 0; index < 2; index++) {
      await service.shutdown();
      store.close();
      store = new Store(database);
      service = new RunService(environment());
      if (!index) {
        service.resume(run.id, 'default');
        service.supplement(run.id, 'default', 'Preserve the tail.', 'tail');
      } else {
        const resumed = store.runs.get(run.id, 'default')!;
        store.runs.update(resumed, { status: 'interrupted' });
        service.resume(run.id, 'default');
      }
      await terminal(service, run.id);
    }
    assert.equal(service.get(run.id, 'default').status, 'completed', service.get(run.id, 'default').error);
    assert.equal(reads, 1);
    assert.equal(calls, 4);
    assert.equal(service.get(run.id, 'default').tokensIn, 30);
    const inputs = store.runs.modelInputs(run.id);
    assert.equal(new Set(inputs.map((input) => input.diagnostics.attemptId)).size, 3);
    assert.ok(inputs.every((input) => input.diagnostics.fingerprint === describeModelInput(input.messages, input.tools).fingerprint));
    assert.equal(observations[2].filter((message) => message.content === 'Read the tail.').length, 1);
    const denied = await createResultTool().handler({ id: 'long' }, { results: { read: () => undefined } } as unknown as ToolContext);
    assert.equal(denied.failure?.code, 'RESULT_NOT_FOUND');
  } finally {
    await service.shutdown();
    store.close();
    await kernel.stop();
  }
});

test('input diagnostics include native tool calls, schemas, and stable content fingerprints', () => {
  const messages: LLMMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  ];
  const input = describeModelInput(messages, [{ name: 'read' }]);
  assert.ok(input.messageTokens > 0 && input.toolTokens > 0);
  assert.equal(
    input.sources.reduce((sum, source) => sum + source.tokens, 0),
    input.messageTokens,
  );
  assert.equal(input.fingerprint, describeModelInput(structuredClone(messages), [{ name: 'read' }]).fingerprint);
  assert.notEqual(input.fingerprint, describeModelInput(messages, []).fingerprint);
});

test('model input diagnostics record each attempted provider rather than the configured primary only', async () => {
  const kernel = new Kernel(mkdtempSync(join(tmpdir(), 'mh-input-fallback-')));
  const primary: ProviderDef = {
    id: 'primary-input-test',
    label: 'primary',
    defaultModel: 'primary',
    async *chat() {
      throw new LLMHttpError(401, 'unauthorized');
    },
  };
  const fallback: ProviderDef = {
    id: 'fallback-input-test',
    label: 'fallback',
    defaultModel: 'fallback',
    async *chat() {
      yield { type: 'delta', text: 'done' };
      yield { type: 'done' };
    },
  };
  const inputs: { providerId: string; model: string }[] = [];
  try {
    for await (const _event of new AgentRunner(kernel as unknown as KernelLike, kernel.bus).run({
      provider: primary,
      model: 'primary',
      traceId: 'input-fallback',
      messages: [{ role: 'user', content: 'reply' }],
      tools: [],
      fallbackProviders: [fallback],
      onModelInput: (input) => inputs.push(input),
    })) {
      /* Consume native loop events. */
    }
    assert.deepEqual(
      inputs.map((input) => [input.providerId, input.model]),
      [
        ['primary-input-test', 'primary'],
        ['fallback-input-test', 'fallback'],
      ],
    );
  } finally {
    await kernel.stop();
  }
});

test('recovery pairs a partially executed native batch using committed effects and unstarted observations', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mh-batch-recovery-'));
  const kernel = new Kernel(workspace);
  const store = new Store(':memory:');
  let calls = 0;
  const source: ProviderDef = {
    id: 'batch',
    label: 'batch',
    defaultModel: 'batch',
    async *chat(history) {
      calls++;
      const results = history.filter((message) => message.role === 'tool');
      assert.equal(results.length, 2);
      assert.equal(JSON.parse(results[0].content!).data.applied, true);
      assert.equal(JSON.parse(results[1].content!).failure.outcome, 'not_started');
      assert.equal(history.find((message) => message.tool_calls)?.tool_calls?.length, 2);
      yield { type: 'delta', text: '核对完成' };
      yield { type: 'done' };
    },
  };
  const environment = {
    store,
    runner: () => new AgentRunner(kernel as unknown as KernelLike, kernel.bus),
    workspace: () => workspace,
    provider: () => ({ id: 'batch', model: 'batch' }),
    prepare: () => ({ provider: source, model: 'batch', messages: [], traceId: '', tools: [] }),
  };
  let service = new RunService(environment);
  try {
    const session = store.createSession('batch', 'batch');
    const record = service.create(session, { message: '执行两个操作' });
    service.cancel(record.id, 'default');
    await service.shutdown();
    store.runs.update(record, { status: 'interrupted' });
    const history: LLMMessage[] = [
      { role: 'user', content: '执行两个操作' },
      {
        role: 'assistant',
        content: null,
        tool_calls: ['a', 'b'].map((id) => ({ id, type: 'function', function: { name: 'write_once', arguments: '{}' } })),
      },
    ];
    store.claimToolEffect(record.id, 'effect-a');
    store.completeToolEffect(record.id, 'effect-a', { ok: true, data: { applied: true } });
    store.runs.startTool(record.id, 'result-a', 'write_once', '{}');
    store.runs.saveCheckpoint(record.id, {
      history,
      turn: -1,
      costUsd: 0,
      toolResults: [],
      pending: true,
      pendingTool: { name: 'write_once', toolCallId: 'a', sideEffect: 'write', effectKey: 'effect-a', resultId: 'result-a' },
    });
    service = new RunService(environment);
    service.resume(record.id, 'default');
    await terminal(service, record.id);
    assert.equal(service.get(record.id, 'default').status, 'completed');
    assert.equal(calls, 1);
    assert.deepEqual(
      (store.runs.toolCalls(record.id) as { status: string }[]).map((call) => call.status),
      ['succeeded', 'failed'],
    );
    assert.equal(store.runs.events(record.id).filter((event) => event.type === 'tool_recovered').length, 2);
  } finally {
    await service.shutdown();
    store.close();
    await kernel.stop();
  }
});

test('legacy incomplete checkpoints cannot silently discard unpaired side effects', async () => {
  const store = new Store(':memory:');
  const source: ProviderDef = {
    id: 'legacy',
    label: 'legacy',
    defaultModel: 'legacy',
    async *chat() {
      throw new Error('must not call provider');
    },
  };
  const environment = {
    store,
    runner: () => undefined,
    workspace: () => process.cwd(),
    provider: () => ({ id: 'legacy', model: 'legacy' }),
    prepare: () => ({ provider: source, model: 'legacy', messages: [], traceId: '' }),
  };
  const service = new RunService(environment);
  try {
    const session = store.createSession('legacy', 'legacy');
    const record = service.create(session, { message: 'work' });
    service.cancel(record.id, 'default');
    await service.shutdown();
    store.runs.update(record, { status: 'interrupted' });
    store.runs.saveCheckpoint(record.id, {
      history: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'write', arguments: '{}' } }] },
      ],
      turn: -1,
      costUsd: 0,
      toolResults: [],
      pending: true,
    });
    const restored = new RunService(environment);
    assert.throws(
      () => restored.resume(record.id, 'default'),
      (error: unknown) => error instanceof RunError && error.code === 'CHECKPOINT_INCOMPLETE',
    );
    await restored.shutdown();
  } finally {
    store.close();
  }
});

test('native batch checkpoints retain completed observations and close the pending journal after service reconstruction', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mh-native-batch-'));
  const database = join(workspace, 'runs.db');
  const kernel = new Kernel(workspace);
  let store = new Store(database);
  let calls = 0;
  let writes = 0;
  let interrupt = true;
  const tool: ToolDef = {
    name: 'write_once',
    version: '2.0.0',
    description: 'Write once',
    permissions: ['workspace.write'],
    sideEffect: 'write',
    parameters: { type: 'object' },
    outputSchema: { type: 'object', required: ['applied'] },
    async handler() {
      writes++;
      return { ok: true, data: { applied: true } };
    },
  };
  const provider: ProviderDef = {
    id: 'native-batch',
    label: 'native-batch',
    defaultModel: 'native-batch',
    async *chat(history) {
      if (++calls === 1) {
        for (const id of ['first', 'second'])
          yield { type: 'tool_call', toolCall: { id, type: 'function', function: { name: tool.name, arguments: '{}' } } };
      } else {
        assert.equal(history.find((message) => message.tool_calls)?.tool_calls?.length, 2);
        const observations = history.filter((message) => message.role === 'tool');
        assert.equal(observations.length, 2);
        assert.equal(JSON.parse(observations[0].content!).data.applied, true);
        assert.equal(JSON.parse(observations[1].content!).failure.outcome, 'not_started');
        yield { type: 'delta', text: 'Completed observation retained; pending write was not executed.' };
      }
      yield { type: 'done' };
    },
  };
  const runner = (): AgentLoop => {
    const base = new AgentRunner(kernel as unknown as KernelLike, kernel.bus);
    return {
      approveApproval: (id, approved) => base.approveApproval(id, approved),
      async *run(options) {
        try {
          yield* base.run({
            ...options,
            onCheckpoint: (...args) => {
              options.onCheckpoint?.(...args);
              if (interrupt && args[3]?.pendingTool?.toolCallId === 'second') {
                interrupt = false;
                throw new Error('TEST_BATCH_BOUNDARY');
              }
            },
          });
        } catch (error) {
          if (!(error instanceof Error && error.message === 'TEST_BATCH_BOUNDARY')) throw error;
          yield { type: 'error', kind: 'max-turns', error: 'TEST_BATCH_BOUNDARY' };
        }
      },
    };
  };
  const environment = () => ({
    store,
    runner,
    workspace: () => workspace,
    provider: () => ({ id: provider.id, model: provider.defaultModel }),
    prepare: () => ({ provider, model: provider.defaultModel, messages: [], traceId: '', tools: [tool] }),
  });
  let service = new RunService(environment());
  try {
    const session = store.createSession(provider.id, provider.defaultModel);
    const run = service.create(session, { message: 'Execute two writes.' });
    await terminal(service, run.id);
    assert.equal(service.get(run.id, 'default').status, 'interrupted');
    assert.equal(writes, 1);
    const checkpoint = store.runs.checkpoint(run.id)!;
    assert.equal(checkpoint.history.find((message) => message.tool_calls)?.tool_calls?.length, 2);
    assert.equal(checkpoint.history.filter((message) => message.role === 'tool').length, 1);
    await service.shutdown();
    store.close();
    store = new Store(database);
    service = new RunService(environment());
    service.resume(run.id, 'default');
    await terminal(service, run.id);
    assert.equal(service.get(run.id, 'default').status, 'completed', service.get(run.id, 'default').error);
    assert.equal(writes, 1);
    assert.equal(calls, 2);
    const records = store.runs.toolCalls(run.id) as { id: string; status: string }[];
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.status),
      ['succeeded', 'failed'],
    );
    assert.ok(records.every((record) => store.runs.readTool(run.id, record.id)));
  } finally {
    await service.shutdown();
    store.close();
    await kernel.stop();
  }
});

test('a pending checkpoint without its native batch fails closed', async () => {
  const store = new Store(':memory:');
  const provider: ProviderDef = {
    id: 'missing-batch',
    label: 'missing-batch',
    defaultModel: 'mock',
    async *chat() {
      throw new Error('must not call provider');
    },
  };
  const environment = {
    store,
    runner: () => undefined,
    workspace: () => process.cwd(),
    provider: () => ({ id: provider.id, model: provider.defaultModel }),
    prepare: () => ({ provider, model: provider.defaultModel, messages: [], traceId: '' }),
  };
  const service = new RunService(environment);
  try {
    const session = store.createSession(provider.id, provider.defaultModel);
    const run = service.create(session, { message: 'work' });
    service.cancel(run.id, 'default');
    await service.shutdown();
    store.runs.update(run, { status: 'interrupted' });
    store.runs.saveCheckpoint(run.id, {
      history: [{ role: 'user', content: 'work' }],
      turn: -1,
      costUsd: 0,
      toolResults: [],
      pending: true,
      pendingTool: { name: 'write', toolCallId: 'missing', sideEffect: 'write', effectKey: 'missing', resultId: 'missing' },
    });
    const restored = new RunService(environment);
    try {
      assert.throws(
        () => restored.resume(run.id, 'default'),
        (error: unknown) => error instanceof RunError && error.code === 'CHECKPOINT_INCOMPLETE',
      );
    } finally {
      await restored.shutdown();
    }
  } finally {
    store.close();
  }
});

test('a custom tool cannot shadow the runtime observation reader', async () => {
  const kernel = new Kernel(mkdtempSync(join(tmpdir(), 'mh-reader-conflict-')));
  const source: ProviderDef = {
    id: 'conflict',
    label: 'conflict',
    defaultModel: 'conflict',
    async *chat() {
      throw new Error('must not call provider');
    },
  };
  const fake = { ...createResultTool(), handler: async () => ({ ok: true, data: {} }) };
  try {
    await assert.rejects(async () => {
      for await (const _event of new AgentRunner(kernel as unknown as KernelLike, kernel.bus).run({
        provider: source,
        model: 'conflict',
        messages: [],
        tools: [fake],
        traceId: 'conflict',
      })) {
        /* Consume until contract validation. */
      }
    }, /TOOL_DEFINITION_CONFLICT/);
  } finally {
    await kernel.stop();
  }
});
