import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelToolCheck, modelCheckFingerprint } from '../model-tool-check';
import { Store } from '../db';

for (const protocol of ['openai', 'anthropic', 'ollama']) {
  test(`${protocol}: capability confirmation requires a native call with matching arguments`, () => {
    const probe = buildModelToolCheck('https://model.example/v1', protocol, 'test-key', 'test-model');
    const request = JSON.parse(probe.init.body);
    const nonce = request.messages[0].content.match(/nonce ([\da-f-]+)/)[1];
    const native = protocol === 'anthropic'
      ? { content: [{ type: 'tool_use', name: 'confirm_tool_support', input: { nonce } }] }
      : protocol === 'ollama'
        ? { message: { tool_calls: [{ function: { name: 'confirm_tool_support', arguments: { nonce } } }] } }
        : { choices: [{ message: { tool_calls: [{ function: { name: 'confirm_tool_support', arguments: JSON.stringify({ nonce }) } }] } }] };
    assert.equal(probe.confirm(native), true);
    assert.equal(probe.confirm({ choices: [{ message: { content: `confirm_tool_support(${nonce})` } }] }), false);
    assert.equal(probe.confirm(JSON.parse(JSON.stringify(native).replaceAll(nonce, 'wrong'))), false);
    assert.equal(probe.confirm(null), false);
  });
}

test('observed model capability is scoped to endpoint, protocol, credentials and model', () => {
  const provider = { baseUrl: 'https://model.example', protocol: 'openai', apiKey: 'test-key' };
  const fingerprint = modelCheckFingerprint(provider);
  const store = new Store(':memory:');
  try {
    store.runs.saveModelToolCheck('p', 'm', { status: 'confirmed', checkedAt: 1, fingerprint });
    assert.equal(store.runs.modelToolCheck('p', 'm')?.status, 'confirmed');
    assert.equal(store.runs.modelToolCheck('p', 'other'), undefined);
    assert.notEqual(modelCheckFingerprint({ ...provider, apiKey: 'changed' }), fingerprint);
    assert.notEqual(modelCheckFingerprint({ ...provider, protocol: 'anthropic' }), fingerprint);
    assert.notEqual(modelCheckFingerprint({ ...provider, baseUrl: 'https://other.example' }), fingerprint);
  } finally { store.close(); }
});

test('artifact identities survive updates and full tool results remain paged', () => {
  const store = new Store(':memory:');
  try {
    store.runs.startTool('run', 'call-1', 'write_file', 'report.md');
    const result = { ok: true, data: { text: 'a'.repeat(20000) }, evidence: [{ kind: 'file' as const, label: '报告', ref: 'report.md', artifact: true }] };
    store.runs.finishTool('run', 'call-1', result);
    const [first] = store.runs.artifacts('run');
    store.runs.startTool('run', 'call-2', 'edit_file', 'report.md');
    store.runs.finishTool('run', 'call-2', result);
    const [updated] = store.runs.artifacts('run');
    assert.equal(first.id, updated.id);
    assert.equal(updated.callId, 'call-2');
    assert.deepEqual(store.runs.artifacts('another-run'), []);
    const page = store.runs.readTool('run', 'call-1', 0, 8000)!;
    assert.equal(page.truncated, true);
    assert.equal(page.content.length, 8000);
    assert.equal(store.runs.readTool('run', 'call-1', page.nextOffset, 16000)?.truncated, false);
  } finally { store.close(); }
});
