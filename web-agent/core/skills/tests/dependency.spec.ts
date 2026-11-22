import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import skillsPlugin from '../index';

describe('技能版本与依赖', () => {
  it('暴露 version/requires 并检测缺失依赖', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-skill-deps-'));
    try {
      const base = join(root, '.maharness', 'skills', 'base');
      const dependent = join(root, '.maharness', 'skills', 'dependent');
      mkdirSync(base, { recursive: true });
      mkdirSync(dependent, { recursive: true });
      writeFileSync(
        join(base, 'SKILL.md'),
        '---\nname: base\ndescription: base\ntriggers:\n  - base\napplies-when:\n  - base\nreject-when:\n  - none\ninput: task\noutput: result\n---\n',
      );
      writeFileSync(
        join(dependent, 'SKILL.md'),
        [
          '---',
          'name: dependent',
          'description: dependent',
          'version: 1.2.0',
          'requires:',
          '  - base',
          '  - missing',
          'triggers:',
          '  - dep',
          'applies-when:',
          '  - dep',
          'reject-when:',
          '  - none',
          'input: task',
          'output: result',
          '---',
        ].join('\n'),
      );

      let service: { list: () => Array<Record<string, any>> } | undefined;
      const ctx = {
        config: {
          get: (key: string, fallback: unknown) =>
            key === 'sandboxRoot' ? root : key === 'skills.vendorDir' ? join(root, 'vendor') : fallback,
        },
        paths: { data: join(root, 'data') },
        register(value: any) {
          if (value.kind === 'service' && value.service?.id === 'skills') service = value.service.instance;
          return () => undefined;
        },
        inject(_key: string, apply: (value: unknown) => void) {
          apply(undefined);
        },
        on() {
          return () => undefined;
        },
        logger: { info() {} },
      };
      skillsPlugin.onLoad(ctx as never);
      const info = service!.list().find((skill) => skill.name === 'dependent');
      assert.equal(info?.version, '1.2.0');
      assert.deepEqual(info?.requires, ['base', 'missing']);
      assert.ok(info?.contractWarnings?.some((warning: string) => warning.includes('missing')));
      assert.ok(!info?.contractWarnings?.some((warning: string) => warning.includes('base,')));
    } finally {
      skillsPlugin.onStop?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
