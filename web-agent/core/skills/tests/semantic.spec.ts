import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import skillsPlugin from '../index';

describe('技能语义路由', () => {
  it('embedding 可用时按语义而非纯关键词选择技能', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-skill-semantic-'));
    try {
      const dir = join(root, '.maharness', 'skills', 'quantum-target');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        [
          '---',
          'name: quantum-target',
          'description: 量子计算与 qubit 方法论',
          'triggers:',
          '  - 量子',
          'applies-when:',
          '  - 量子任务',
          'reject-when:',
          '  - 普通代码',
          'input: task',
          'output: result',
          '---',
          '正文',
        ].join('\n'),
      );

      let context:
        | {
            contentFn: (ctx: {
              history: unknown[];
              systemPrompt: string;
              scratchpad: Record<string, unknown>;
            }) => string | { content: string } | null;
          }
        | undefined;
      let beforeLlm: ((event: { data: unknown }) => Promise<void>) | undefined;
      const ctx = {
        config: {
          get: (key: string, fallback: unknown) =>
            key === 'sandboxRoot' ? root : key === 'skills.vendorDir' ? join(root, 'vendor') : fallback,
        },
        paths: { data: join(root, 'data') },
        register(value: any) {
          if (value.kind === 'context' && value.context?.id === 'skills-index') context = value.context;
        },
        inject(key: string, apply: (value: unknown) => void) {
          if (key === 'service:embedding') {
            apply({
              model: 'fake',
              async embed(text: string) {
                return /量子|qubit/.test(text) ? [1, 0] : [0, 1];
              },
            });
          } else apply(undefined);
        },
        on(event: string, handler: (event: { data: unknown }) => Promise<void>) {
          if (event === 'agent.before_llm') beforeLlm = handler;
          return () => undefined;
        },
        logger: { info() {} },
      };
      skillsPlugin.onLoad(ctx as never);
      assert.ok(beforeLlm);
      const scratchpad: Record<string, unknown> = {};
      const history = [{ role: 'user', content: '解释 qubit 的退相干' }];
      await beforeLlm!({ data: { history, scratchpad } });
      const injected = context!.contentFn({ history, systemPrompt: '', scratchpad });
      assert.match(String(typeof injected === 'string' ? injected : injected?.content), /quantum-target/);
    } finally {
      skillsPlugin.onStop?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
