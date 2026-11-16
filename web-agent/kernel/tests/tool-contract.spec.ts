import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateToolDef } from '../../core/chat/agent';
import { effectiveToolSideEffect, shouldJournalToolEffect, toolSideEffectLabel } from '../tool-contract';
import type { ToolDef } from '../types';

const tool = (sideEffect: ToolDef['sideEffect'] = 'external'): ToolDef => ({
  version: '2.0.0', permissions: [], outputSchema: {},
  name: 'demo',
  description: 'demo',
  parameters: { type: 'object', properties: {} },
  sideEffect,
  async handler() { return { ok: true }; },
});

describe('工具副作用契约', () => {
  test('只读/无副作用工具不进入恢复账本，写/外部/不可逆进入', () => {
    assert.equal(shouldJournalToolEffect(tool()), true, '未声明时保守处理为需要账本');
    assert.equal(shouldJournalToolEffect(tool('none')), false);
    assert.equal(shouldJournalToolEffect(tool('read')), false);
    assert.equal(shouldJournalToolEffect(tool('write')), true);
    assert.equal(shouldJournalToolEffect(tool('external')), true);
    assert.equal(shouldJournalToolEffect(tool('irreversible')), true);
    assert.equal(toolSideEffectLabel(tool()), 'external');
  });

  test('调用级副作用优先于静态保守声明，异常时回退静态声明', () => {
    const dynamic: ToolDef = {
      ...tool('irreversible'),
      classifySideEffect(args) {
        return (args as { read?: boolean }).read ? 'read' : 'irreversible';
      },
    };
    assert.equal(effectiveToolSideEffect(dynamic, { read: true }), 'read');
    assert.equal(shouldJournalToolEffect(dynamic, { read: true }), false);
    assert.equal(toolSideEffectLabel(dynamic, { read: true }), 'read');
    assert.equal(effectiveToolSideEffect(dynamic, { read: false }), 'irreversible');
    assert.equal(shouldJournalToolEffect(dynamic, { read: false }), true);
    assert.equal(effectiveToolSideEffect({ ...dynamic, classifySideEffect() { throw new Error('bad input'); } }, {}), 'irreversible');
  });

  test('工具描述保留副作用边界', () => {
    const annotated = annotateToolDef(tool('read'));
    assert.match(annotated.description, /副作用:read/);
    assert.match(annotated.description, /demo/);
  });

  test('只读工具自动获得幂等与有限重试，写工具保持保守', () => {
    const read = annotateToolDef(tool('read'));
    assert.equal(read.idempotent, true);
    assert.deepEqual(read.retry, { maxAttempts: 2, backoffMs: 300 });
    const write = annotateToolDef(tool('write'));
    assert.equal(write.idempotent, undefined);
    assert.equal(write.retry, undefined);
    const explicit = annotateToolDef({ ...tool('read'), idempotent: false, retry: { maxAttempts: 1 } });
    assert.equal(explicit.idempotent, false);
    assert.deepEqual(explicit.retry, { maxAttempts: 1 });
  });
});
