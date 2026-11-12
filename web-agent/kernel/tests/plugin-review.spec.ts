import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPluginRuntimeSource, reviewPluginSource, reviewPluginWrite } from '../plugin-review';

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
    assert.deepEqual(new Set(r.issues.map((i) => i.code)), new Set(['native-process', 'raw-filesystem', 'dynamic-code', 'secret-access', 'network-egress', 'dependency-policy']));
  });

  test('能力未列入白名单时拒绝并给出可修复原因', () => {
    const r = reviewPluginSource("ctx.register({ kind: 'tool', tool: { name: 'delete_data' } });", { capabilities: { tool: ['safe_read'] } });
    assert.equal(r.ok, false);
    assert.equal(r.highRisk, false);
    assert.equal(r.issues[0]?.code, 'missing-permissions');
  });

  test('直接写入 plugins/ 的源码走同一审查', () => {
    const root = 'C:/workspace';
    const safe = reviewPluginWrite(root, 'C:/workspace/plugins/demo/index.ts', "ctx.register({ kind: 'tool', tool: { name: 'safe' } });");
    assert.equal(safe?.ok, true);
    const bad = reviewPluginWrite(root, 'C:/workspace/plugins/demo/index.ts', "import { spawn } from 'node:child_process';");
    assert.equal(bad?.ok, false);
    assert.equal(bad?.highRisk, true);
  });

  test('非 plugins 路径与非源码文件不触发审查', () => {
    assert.equal(reviewPluginWrite('C:/workspace', 'C:/workspace/src/a.ts', 'eval(x)'), null);
    assert.equal(reviewPluginWrite('C:/workspace', 'C:/workspace/plugins/demo/plugin.json', '{}'), null);
  });

  test('外部依赖默认拒绝，白名单内包与安全 Node 内置模块放行', () => {
    const source = [
      "import path from 'node:path';",
      "import { z } from 'zod';",
      'export default { onLoad() {} };',
    ].join('\n');
    const denied = reviewPluginSource(source);
    assert.equal(denied.ok, false);
    assert.ok(denied.issues.some((issue) => issue.code === 'dependency-policy' && issue.message.includes('zod')));
    assert.deepEqual(denied.dependencies, ['node:path', 'zod']);

    const allowed = reviewPluginSource(source, undefined, { allowedDependencies: ['zod'] });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.issues));
  });

  test('危险 Node 内置模块即使不在文件系统规则内也拒绝', () => {
    const result = reviewPluginSource("import http from 'node:http';\nexport default { onLoad() {} };");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'dependency-policy'));
  });

  test('runtime 声明按文件/网络/进程能力过滤静态审查', () => {
    const source = [
      "import { readFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "fetch('https://example.com');",
      'export default { onLoad() {} };',
    ].join('\n');
    const restricted = reviewPluginRuntimeSource(source, { filesystem: 'sandbox', network: 'none', process: false });
    assert.equal(restricted.ok, false);
    assert.deepEqual(new Set(restricted.issues.map((issue) => issue.code)), new Set(['raw-filesystem', 'native-process', 'network-egress', 'dependency-policy']));
    const full = reviewPluginRuntimeSource(source, { filesystem: 'full', network: 'full', process: true });
    assert.equal(full.ok, true, JSON.stringify(full.issues));
  });
});
