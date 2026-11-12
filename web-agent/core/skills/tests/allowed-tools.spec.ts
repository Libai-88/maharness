import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import skillsPlugin from '../index';

describe('技能 allowed-tools', () => {
  it('读取技能后按会话拦截未授权工具', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-skill-tools-'));
    try {
      const dir = join(root, '.maharness', 'skills', 'restricted');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), [
        '---', 'name: restricted', 'description: 受限技能',
        'allowed-tools:', '  - read_file',
        'triggers:', '  - 受限', 'applies-when:', '  - 受限任务',
        'reject-when:', '  - 其他', 'input: task', 'output: result', '---', '正文',
      ].join('\n'));

      const tools = new Map<string, any>();
      let beforeTool: ((event: { data: unknown }) => void) | undefined;
      const ctx = {
        config: { get: (key: string, fallback: unknown) => key === 'sandboxRoot' ? root
          : key === 'skills.vendorDir' ? join(root, 'vendor') : fallback },
        paths: { data: join(root, 'data') },
        register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
        inject(_key: string, apply: (value: unknown) => void) { apply(undefined); },
        on(event: string, handler: (event: { data: unknown }) => void) {
          if (event === 'agent.before_tool') beforeTool = handler;
          return () => undefined;
        },
        logger: { info() {} },
      };
      skillsPlugin.onLoad(ctx as never);
      await tools.get('get_skill').handler({ name: 'restricted' }, { sessionId: 's', turn: 0, sandboxRoot: root, cache: {}, trace: {} });
      assert.ok(beforeTool);

      const blocked = { sessionId: 's', tool: { name: 'web_search' }, blocked: false };
      beforeTool!({ data: blocked });
      assert.equal(blocked.blocked, true);

      const allowed = { sessionId: 's', tool: { name: 'read_file' }, blocked: false };
      beforeTool!({ data: allowed });
      assert.equal(allowed.blocked, false);

      const otherSession = { sessionId: 't', tool: { name: 'web_search' }, blocked: false };
      beforeTool!({ data: otherSession });
      assert.equal(otherSession.blocked, false);
    } finally {
      skillsPlugin.onStop?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
