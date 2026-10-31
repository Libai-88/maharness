import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPluginSource } from '../plugin-review';

describe('插件静态审查', () => {
  test('安全的 ctx.register 插件通过并提取能力', () => {
    const r = reviewPluginSource("ctx.register({ kind: 'tool', tool: { name: 'safe_read' } });", {
      capabilities: { tool: ['safe_read'] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.highRisk, false);
    assert.deepEqual(r.capabilities, [{ kind: 'tool', name: 'safe_read' }]);
  });

  test('原生进程、文件、动态代码、密钥和网络访问均拒绝', () => {
    const source = [
      "import { spawn } from 'node:child_process';",
      "import { readFileSync } from 'node:fs';",
      'eval(userInput);',
      'process.env.SECRET;',
      'fetch(url);',
    ].join('\n');
    const r = reviewPluginSource(source);
    assert.equal(r.ok, false);
    assert.equal(r.highRisk, true);
    assert.deepEqual(new Set(r.issues.map((i) => i.code)), new Set(['native-process', 'raw-filesystem', 'dynamic-code', 'secret-access', 'network-egress']));
  });

  test('能力未列入白名单时拒绝并给出可修复原因', () => {
    const r = reviewPluginSource("ctx.register({ kind: 'tool', tool: { name: 'delete_data' } });", { capabilities: { tool: ['safe_read'] } });
    assert.equal(r.ok, false);
    assert.equal(r.highRisk, false);
    assert.equal(r.issues[0]?.code, 'missing-permissions');
  });
});
