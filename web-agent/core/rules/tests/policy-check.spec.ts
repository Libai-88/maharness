import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rulesPlugin from '../index';

describe('check_policy', () => {
  it('返回命中规则的判定与未命中默认值', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-rules-check-'));
    try {
      const data = join(root, 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'rules.json'), JSON.stringify([
        { id: 'allow-docs', effect: 'allow', tool: 'read_file', pathPattern: 'docs/**' },
        { id: 'deny-kill', effect: 'deny', tool: 'powershell_execute', argPattern: 'taskkill' },
      ]), 'utf8');
      const tools = new Map<string, any>();
      const ctx = {
        config: {
          get: (key: string, fallback: unknown) => key === 'sandboxRoot' ? root
            : key === 'rules.enabled' ? true
              : key === 'rules.policyEnabled' ? true : fallback,
        },
        paths: { data, root },
        register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); return () => undefined; },
        watchConfig() { return () => undefined; },
        on() { return () => undefined; },
        logger: { info() {} },
      };
      rulesPlugin.onLoad(ctx as never);
      const check = tools.get('check_policy');
      assert.ok(check);
      const allowed = await check.handler({ tool: 'read_file', args: { path: 'docs/a.md' } });
      assert.equal(allowed.data.decision, 'allow');
      assert.equal(allowed.data.ruleId, 'allow-docs');
      const denied = await check.handler({ tool: 'powershell_execute', args: { command: 'taskkill /PID 1' } });
      assert.equal(denied.data.decision, 'deny');
      assert.equal(denied.data.ruleId, 'deny-kill');
      const fallback = await check.handler({ tool: 'write_file', args: { path: 'a.txt' } });
      assert.equal(fallback.data.decision, 'default');
      assert.equal(fallback.data.matched, false);
      const candidate = await check.handler({
        tool: 'read_file',
        args: { path: 'docs/a.md' },
        candidate: [{ id: 'allow-docs', effect: 'deny', tool: 'read_file', pathPattern: 'docs/**' }],
      });
      assert.equal(candidate.data.decision, 'allow');
      assert.equal(candidate.data.candidate.decision, 'deny');
      assert.equal(candidate.data.changed, true);
      assert.equal(candidate.data.diff[0].change, 'changed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
