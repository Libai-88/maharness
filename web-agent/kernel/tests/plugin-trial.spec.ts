import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runPluginTrial } from '../plugin-trial';

describe('插件隔离试运行', () => {
  test('在临时 Kernel 进程中启动并回收安全插件', async () => {
    const result = await runPluginTrial({
      id: 'trial-safe',
      manifest: {
        id: 'trial-safe', name: 'trial-safe', version: '0.1.0', entry: 'index.ts',
        permissions: { capabilities: { tool: ['trial_hello'] } },
      },
      source: `export default { id: 'trial-safe', name: 'trial-safe', version: '0.1.0', onLoad(ctx) {
        ctx.register({ kind: 'tool', tool: { name: 'trial_hello', description: 'trial', parameters: { type: 'object', properties: {} }, async handler() { return { ok: true, data: {} }; } } });
      } };`,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'started');
    assert.deepEqual(result.caps, ['tool']);
  });

  test('插件启动失败时返回失败状态而不泄漏到宿主', async () => {
    const result = await runPluginTrial({
      id: 'trial-bad',
      manifest: { id: 'trial-bad', name: 'trial-bad', version: '0.1.0', entry: 'index.ts' },
      source: `export default { id: 'trial-bad', name: 'trial-bad', version: '0.1.0', onLoad() { throw new Error('trial failure'); } };`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'error');
    assert.match(String(result.error), /试运行加载失败/);
  });
});
