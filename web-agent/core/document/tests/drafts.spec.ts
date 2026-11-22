import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import plugin from '../index';
import { readContent } from '../formats';
import type { ToolDef, ToolContext } from '../../../kernel/types';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mh-draft-'));
  const tools = new Map<string, ToolDef>();
  plugin.onLoad!({
    register: (value: any) => {
      if (value.kind === 'tool') tools.set(value.tool.name, value.tool);
    },
    kernel: { rootDir: root },
    logger: { info() {} },
    config: { get: (_: string, fallback: unknown) => fallback },
  } as never);
  const context = {
    sandboxRoot: root,
    runId: 'run-one',
    tenantId: 'default',
    quota: { assertWritable() {}, invalidate() {} },
  } as unknown as ToolContext;
  const call = (name: string, args: any, ctx = context) => tools.get(name)!.handler(args, ctx) as Promise<any>;
  return { root, context, call, close: () => rmSync(root, { recursive: true, force: true }) };
}
for (const format of ['md', 'docx', 'pptx'])
  test(`${format} segmented snapshots, readback, replace and finalize`, async () => {
    const f = fixture();
    try {
      const begun = await f.call('begin_document_draft', { format, name: 'result', title: '标题' });
      assert.equal(begun.ok, true, begun.error);
      const part = (id: string, text: string) =>
        format === 'pptx' ? { id, type: 'slide', title: id, text } : { id, type: format === 'md' ? 'section' : 'paragraph', text };
      const first = await f.call('update_document_draft', { ...begun.data, operationId: 'one', parts: [part('one', '第一部分')] });
      assert.equal(first.ok, true, first.error);
      const second = await f.call('update_document_draft', {
        draftId: begun.data.draftId,
        version: first.data.version,
        operationId: 'two',
        parts: [part('two', '第二部分'), part('one', '第一部分修订')],
      });
      assert.equal(second.ok, true, second.error);
      assert.notEqual(first.data.path, second.data.path);
      assert.equal(second.evidence[0].value.status, 'draft');
      const original = await readContent(readFileSync(join(f.root, first.data.path)), format);
      assert.ok(original.blocks.some((b) => b.text.includes('第一部分')));
      assert.ok(!original.blocks.some((b) => b.text.includes('修订')));
      const read = await f.call('read_document_draft', { draftId: begun.data.draftId });
      assert.equal(read.data.count, 2);
      assert.equal(read.data.content, undefined);
      const focus = await f.call('read_document_draft', { draftId: begun.data.draftId, partId: 'one' });
      assert.equal(focus.data.content[0].text, '第一部分修订');
      const final = await f.call('finalize_document_draft', { draftId: begun.data.draftId, version: second.data.version });
      assert.equal(final.ok, true, final.error);
      assert.equal(final.evidence[0].value.status, 'final');
      const content = await readContent(readFileSync(join(f.root, final.data.path)), format);
      assert.ok(content.blocks.some((b) => b.text.includes('第一部分修订')));
      assert.ok(content.blocks.some((b) => b.text.includes('第二部分')));
    } finally {
      f.close();
    }
  });
test('idempotent operations retain exact snapshots; version and operation conflicts do not write', async () => {
  const f = fixture();
  try {
    const { data } = await f.call('begin_document_draft', { format: 'md' });
    const args = {
      draftId: data.draftId,
      version: data.version,
      operationId: 'save-1',
      parts: [{ id: 'p1', type: 'section', text: 'stored' }],
    };
    const a = await f.call('update_document_draft', args);
    const b = await f.call('update_document_draft', args);
    assert.deepEqual(a, b);
    const reordered = await f.call('update_document_draft', {
      parts: [{ text: 'stored', type: 'section', id: 'p1' }],
      operationId: 'save-1',
      version: data.version,
      draftId: data.draftId,
    });
    assert.deepEqual(reordered, a);
    assert.match((await f.call('update_document_draft', { ...args, operationId: 'new' })).error, /VERSION_CONFLICT/);
    assert.match(
      (await f.call('update_document_draft', { ...args, parts: [{ ...args.parts[0], text: 'different' }] })).error,
      /OPERATION_CONFLICT/,
    );
    assert.equal(readdirSync(join(f.root, 'outputs/run-one')).filter((name) => name.endsWith('.md')).length, 1);
  } finally {
    f.close();
  }
});
test('cross-tenant, cross-run, traversal and changed sources are refused; previous snapshot survives', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'source.md'), 'source');
    const sourceVersion = createHash('sha256').update('source').digest('hex');
    const { data } = await f.call('begin_document_draft', { format: 'md', sources: [{ path: 'source.md', version: sourceVersion }] });
    const first = await f.call('update_document_draft', {
      draftId: data.draftId,
      version: data.version,
      operationId: 'one',
      parts: [{ id: 'p', type: 'section', text: 'saved' }],
    });
    assert.equal(first.ok, true, first.error);
    assert.equal((await f.call('read_document_draft', { draftId: data.draftId }, { ...f.context, tenantId: 'other' })).ok, false);
    assert.equal((await f.call('read_document_draft', { draftId: data.draftId }, { ...f.context, runId: 'other' })).ok, false);
    assert.equal((await f.call('read_document_draft', { draftId: '../run-one' })).ok, false);
    const cloneContext = { ...f.context, runId: 'run-clone' };
    const clone = await f.call(
      'begin_document_draft',
      { format: 'md', sources: [], fromDraft: { runId: 'run-one', draftId: data.draftId, version: first.data.version } },
      cloneContext,
    );
    assert.equal(clone.ok, true, clone.error);
    writeFileSync(join(f.root, 'source.md'), 'changed');
    assert.match(
      (await f.call('finalize_document_draft', { draftId: clone.data.draftId, version: clone.data.version }, cloneContext)).error,
      /FILE_VERSION_CONFLICT/,
    );
    assert.match(
      (
        await f.call(
          'begin_document_draft',
          { format: 'md', sources: [], fromDraft: { runId: 'run-one', draftId: data.draftId, version: first.data.version } },
          { ...f.context, runId: 'run-two' },
        )
      ).error,
      /FILE_VERSION_CONFLICT/,
    );
    assert.match(
      (await f.call('finalize_document_draft', { draftId: data.draftId, version: first.data.version })).error,
      /FILE_VERSION_CONFLICT/,
    );
    assert.equal(readFileSync(join(f.root, first.data.path), 'utf8'), 'saved');
  } finally {
    f.close();
  }
});
test('cloning exact saved revision preserves original and ordered DOCX tables', async () => {
  const f = fixture();
  try {
    const { data } = await f.call('begin_document_draft', { format: 'docx' });
    const saved = await f.call('update_document_draft', {
      draftId: data.draftId,
      version: data.version,
      operationId: 'one',
      parts: [
        { id: 'p1', type: 'paragraph', text: 'before' },
        { id: 't', type: 'table', rows: [['head'], ['cell']] },
        { id: 'p2', type: 'paragraph', text: 'after' },
      ],
    });
    assert.equal(saved.ok, true, saved.error);
    const bytes = readFileSync(join(f.root, saved.data.path));
    const content = await readContent(bytes, 'docx');
    const text = content.blocks.map((b) => b.text);
    assert.ok(text.indexOf('before') < text.indexOf('head') && text.indexOf('cell') < text.indexOf('after'));
    const cloned = await f.call(
      'begin_document_draft',
      { format: 'docx', fromDraft: { runId: 'run-one', draftId: data.draftId, version: saved.data.version } },
      { ...f.context, runId: 'run-two' },
    );
    assert.equal(cloned.ok, true, cloned.error);
    assert.equal(cloned.data.count, 3);
    assert.notEqual(cloned.data.draftId, data.draftId);
    assert.deepEqual(readFileSync(join(f.root, saved.data.path)), bytes);
  } finally {
    f.close();
  }
});
test('empty, invalid and oversized updates, quota errors and cancellation retain last version', async () => {
  const f = fixture();
  try {
    const { data } = await f.call('begin_document_draft', { format: 'md' });
    assert.match((await f.call('finalize_document_draft', data)).error, /EMPTY_DRAFT/);
    const args = { draftId: data.draftId, version: data.version, operationId: 'one', parts: [{ id: 'p', type: 'section', text: 'saved' }] };
    assert.equal((await f.call('update_document_draft', { ...args, parts: [{ id: 'p', type: 'slide', title: 'wrong' }] })).ok, false);
    assert.match(
      (await f.call('update_document_draft', { ...args, parts: [{ ...args.parts[0], text: 'x'.repeat(65536) }] })).error,
      /TOO_LARGE/,
    );
    assert.equal(
      (
        await f.call('update_document_draft', args, {
          ...f.context,
          quota: {
            assertWritable() {
              throw new Error('quota exceeded');
            },
          },
        })
      ).ok,
      false,
    );
    const ac = new AbortController();
    const cancelled = await f.call('update_document_draft', args, {
      ...f.context,
      signal: ac.signal,
      quota: {
        assertWritable() {
          ac.abort();
        },
      },
    });
    assert.equal(cancelled.ok, false);
    const after = await f.call('read_document_draft', { draftId: data.draftId });
    assert.equal(after.data.version, data.version);
    assert.equal(after.data.count, 0);
    assert.equal(readdirSync(join(f.root, 'outputs/run-one')).filter((name) => name.endsWith('.md') || name.endsWith('.tmp')).length, 0);
  } finally {
    f.close();
  }
});

test('unknown snapshot commit is never reported as a successful idempotent update', async () => {
  const f = fixture();
  try {
    const { data } = await f.call('begin_document_draft', { format: 'md' });
    const args = {
      draftId: data.draftId,
      version: data.version,
      operationId: 'one',
      parts: [{ id: 'p', type: 'section', text: 'snapshot' }],
    };
    const saved = await f.call('update_document_draft', args);
    assert.equal(saved.ok, true, saved.error);
    const head = join(f.root, 'outputs/run-one/.drafts', data.draftId, 'HEAD');
    writeFileSync(head, data.version);
    assert.match((await f.call('update_document_draft', args)).error, /COMMIT_UNCERTAIN/);
    assert.equal((await f.call('read_document_draft', { draftId: data.draftId })).data.count, 0);
    assert.equal(readFileSync(join(f.root, saved.data.path), 'utf8'), 'snapshot');
  } finally {
    f.close();
  }
});

test('exact state quota failure after snapshot publication cleans new files and retains prior HEAD', async () => {
  const f = fixture();
  try {
    const { data } = await f.call('begin_document_draft', { format: 'md' });
    const saved = await f.call('update_document_draft', {
      draftId: data.draftId,
      version: data.version,
      operationId: 'one',
      parts: [{ id: 'p', type: 'section', text: 'saved' }],
    });
    const before = readdirSync(join(f.root, 'outputs/run-one')).sort();
    let invalidated = false;
    const result = await f.call(
      'update_document_draft',
      {
        draftId: data.draftId,
        version: saved.data.version,
        operationId: 'two',
        parts: [{ id: 'p', type: 'section', text: 'replacement' }],
      },
      {
        ...f.context,
        quota: {
          invalidate() {
            invalidated = true;
          },
          assertWritable() {
            if (invalidated) throw new Error('exact state quota exceeded');
          },
        },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /exact state quota/);
    assert.deepEqual(readdirSync(join(f.root, 'outputs/run-one')).sort(), before);
    assert.equal((await f.call('read_document_draft', { draftId: data.draftId })).data.version, saved.data.version);
    assert.equal(readFileSync(join(f.root, saved.data.path), 'utf8'), 'saved');
    const retry = await f.call('update_document_draft', {
      draftId: data.draftId,
      version: saved.data.version,
      operationId: 'two',
      parts: [{ id: 'p', type: 'section', text: 'replacement' }],
    });
    assert.equal(retry.ok, true, retry.error);
  } finally {
    f.close();
  }
});
