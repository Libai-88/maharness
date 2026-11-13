import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../kernel';
import type { KernelLike, LLMMessage, ProviderDef, ToolDef } from '../kernel/types';
import { ReferenceLoop } from './reference-loop';
import { releaseTasks } from './release-cases';

test('release task set contains thirty distinct, executable artifact checks in five categories', () => {
  const tasks = releaseTasks();
  assert.equal(tasks.length, 30); assert.equal(new Set(tasks.map(task => task.id)).size, 30);
  for (const category of ['code', 'research', 'document', 'recovery', 'tool-failure']) assert.equal(tasks.filter(task => task.category === category).length, 6);
  assert.ok(tasks.every(task => Object.keys(task.files).length && task.prompt && typeof task.check === 'function'));
});

test('reference loop calls native tools, returns observations and completes without workflow instructions', async () => {
  const kernel = new Kernel(mkdtempSync(join(tmpdir(), 'mh-reference-test-')));
  let calls = 0; let operations = 0; const inputs: LLMMessage[][] = [];
  const tool: ToolDef = { name: 'read', version: '2.0.0', description: 'read', sideEffect: 'read', permissions: ['workspace.read'], parameters: { type: 'object' }, outputSchema: { type: 'object', required: ['value'] }, async handler() { operations++; return { ok: true, data: { value: 42 } }; } };
  const provider: ProviderDef = { id: 'mock', label: 'mock', defaultModel: 'mock', prices: { in: 0, out: 0 }, async *chat(messages) {
    inputs.push(structuredClone(messages));
    if (++calls === 1) yield { type: 'tool_call', toolCall: { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } } };
    else yield { type: 'delta', text: '42' };
    yield { type: 'usage', input: 10, output: 4 }; yield { type: 'done' };
  } };
  try {
    const events = [];
    for await (const event of new ReferenceLoop(kernel as unknown as KernelLike).run({ provider, model: 'mock', tools: [tool], messages: [{ role: 'user', content: 'read' }], traceId: 'reference' })) events.push(event);
    assert.equal(operations, 1); assert.equal(calls, 2);
    assert.equal(events.at(-1)?.type, 'assistant_done');
    assert.equal(inputs[1].at(-1)?.role, 'tool');
    assert.ok(inputs[1].at(-1)?.content?.includes('42'));
  } finally { await kernel.stop(); }
});

test('reference loop never completes an incomplete provider stream', async () => {
  const kernel = new Kernel(mkdtempSync(join(tmpdir(), 'mh-reference-test-')));
  const provider: ProviderDef = { id: 'mock', label: 'mock', defaultModel: 'mock', async *chat() { yield { type: 'delta', text: 'partial' }; } };
  try {
    const events = [];
    for await (const event of new ReferenceLoop(kernel as unknown as KernelLike).run({ provider, model: 'mock', tools: [], messages: [], traceId: 'incomplete' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(events.some(event => event.type === 'assistant_done'), false);
  } finally { await kernel.stop(); }
});

test('reference loop stops after an unknown side effect rather than asking the model to replay it', async () => {
  const kernel = new Kernel(mkdtempSync(join(tmpdir(), 'mh-reference-unknown-')));
  let calls = 0; let writes = 0;
  const tool: ToolDef = { name: 'uncertain_write', version: '2.0.0', description: 'write', sideEffect: 'write', permissions: ['workspace.write'], parameters: { type: 'object' }, outputSchema: {}, async handler() { writes++; throw new Error('connection lost after write'); } };
  const provider: ProviderDef = { id: 'mock', label: 'mock', defaultModel: 'mock', async *chat() { calls++; yield { type: 'tool_call', toolCall: { id: 'write', type: 'function', function: { name: tool.name, arguments: '{}' } } }; yield { type: 'done' }; } };
  try {
    const events = [];
    for await (const event of new ReferenceLoop(kernel as unknown as KernelLike).run({ provider, model: 'mock', tools: [tool], messages: [], traceId: 'unknown' })) events.push(event);
    assert.equal(writes, 1); assert.equal(calls, 1);
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(events.some(event => event.type === 'assistant_done'), false);
  } finally { await kernel.stop(); }
});
