import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvalCase } from './manifest';

const casesDir = fileURLToPath(new URL('./cases/', import.meta.url));
const validCase = {
  name: 'fixture',
  messages: [{ role: 'user', content: 'hello' }],
  requests: [{ chunks: [{ type: 'delta', text: 'world' }, { type: 'done' }] }],
  expect: { answerContains: ['world'], llmCalls: 1 },
};

describe('versioned evaluation case manifests', () => {
  it('loads every checked-in case through the same schema contract', () => {
    const files = readdirSync(casesDir).filter((file) => file.endsWith('.json')).sort();
    assert.ok(files.length >= 20);
    for (const file of files) {
      const value = JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as unknown;
      assert.equal(validateEvalCase(value, file).schemaVersion, 1, file);
    }
  });

  it('normalizes a legacy case without an explicit version', () => {
    assert.equal(validateEvalCase(validCase).schemaVersion, 1);
    assert.throws(() => validateEvalCase({ ...validCase, schemaVersion: 2 }), /不支持的 schemaVersion/);
  });

  it('rejects incomplete case, request, and assertion contracts before execution', () => {
    assert.throws(() => validateEvalCase({ ...validCase, expect: undefined }), /manifest 无效/);
    assert.throws(() => validateEvalCase({ ...validCase, messages: [] }), /messages 不能为空/);
    assert.throws(() => validateEvalCase({ ...validCase, requests: [{ chunks: [] }] }), /chunks 均不能为空/);
    assert.throws(() => validateEvalCase({
      ...validCase,
      requests: [{ chunks: [{ type: 'tool_call', toolCall: { id: 'x', type: 'function', function: { name: 'x', arguments: '{' } } }] }],
    }), /arguments 必须是 JSON 对象/);
    assert.throws(() => validateEvalCase({
      ...validCase,
      task: { objective: 'verify', acceptance: [{ type: 'output_matches', pattern: '[', flags: '' }] },
    }), /task contract 无效/);
  });

  it('rejects assertions that cannot be reached by the declared fixture', () => {
    assert.throws(() => validateEvalCase({
      ...validCase,
      expect: { repeats: 1, cachedOn: [2] },
    }), /不能超过 expect.repeats/);
    assert.throws(() => validateEvalCase({
      ...validCase,
      securityAttack: { category: 'tool_output_injection', sourceTool: 'read', payload: 'attack', protectedTool: 'write' },
      expect: { securityOutcome: 'blocked' },
    }), /必须断言 blocked 与 rejected/);
  });

  it('keeps at least three deterministic examples for each task and approval outcome', () => {
    const cases = readdirSync(casesDir).filter((file) => file.endsWith('.json')).map((file) =>
      validateEvalCase(JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as unknown, file));
    for (const outcome of ['verified', 'partial', 'failed'] as const) {
      assert.ok(cases.filter((c) => c.expect.taskOutcome === outcome).length >= 3, `${outcome} coverage regressed`);
    }
    for (const outcome of ['approved', 'rejected'] as const) {
      assert.ok(cases.filter((c) => c.expect.approvalOutcome === outcome).length >= 3, `${outcome} approval coverage regressed`);
    }
    const providerFaults = cases.filter((c) => c.requests.some((request) => request.chunks.some((chunk) => chunk.type === 'throw')));
    assert.ok(providerFaults.length >= 3, 'provider retry/stop fault coverage regressed');
    assert.ok(cases.some((c) => c.name === 'provider-rate-limit-retry' && c.expect.llmCalls === 2), '429 rate limit retry coverage regressed');
    assert.ok(cases.some((c) => c.name === 'provider-timeout-retry' && c.expect.llmCalls === 2), 'timeout retry coverage regressed');
    for (const name of ['provider-auth-stop', 'provider-parameter-stop', 'provider-business-stop', 'provider-aborted-stop']) {
      assert.ok(cases.some((c) => c.name === name && c.expect.llmCalls === 1), `${name} must remain a single-attempt stop case`);
    }
    assert.ok(cases.some((c) => c.recovery && c.expect.taskOutcome === 'verified' && c.expect.recoveryToolCalls === 1), 'checkpoint recovery golden coverage regressed');
    for (const category of ['user_prompt_injection', 'tool_output_injection', 'plugin_tool_output_injection', 'plugin_capability_escalation'] as const) {
      assert.ok(cases.some((c) => c.securityAttack?.category === category && c.expect.securityOutcome === 'blocked'), `${category} coverage regressed`);
    }
  });

  it('capability escalation requires denial without an approval outcome', () => {
    const attack = { category: 'plugin_capability_escalation', allowedName: 'safe_read', attemptedName: 'delete_data' };
    assert.throws(() => validateEvalCase({ ...validCase, securityAttack: attack, expect: { securityOutcome: 'blocked', approvalOutcome: 'rejected' } }), /不得要求审批结果/);
    assert.throws(() => validateEvalCase({ ...validCase, securityAttack: attack, expect: {} }), /必须断言 blocked/);
  });
});
