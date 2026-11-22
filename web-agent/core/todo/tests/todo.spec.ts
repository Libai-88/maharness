import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import todoPlugin from '../index';
import type { ToolContext, ToolDef } from '../../../kernel/types';

const root = mkdtempSync(join(tmpdir(), 'mh-todo-'));
const data = join(root, 'data');
const tools = new Map<string, ToolDef>();
let router: ((req: unknown, res: unknown) => Promise<void>) | undefined;
const events: string[] = [];
const ctx = {
  paths: { data, root },
  config: { get: (_key: string, fallback: unknown) => fallback },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  bus: {
    emit: (event: { type: string }) => {
      events.push(event.type);
    },
  },
  register(cap: { kind: string; tool?: ToolDef; api?: { router: typeof router } }) {
    if (cap.kind === 'tool' && cap.tool) tools.set(cap.tool.name, cap.tool);
    if (cap.kind === 'api' && cap.api) router = cap.api.router;
  },
};
(todoPlugin as unknown as { onLoad(ctx: unknown): void }).onLoad(ctx);
after(() => rmSync(root, { recursive: true, force: true }));

const tctx = (tenantId: string, sessionId: string): ToolContext =>
  ({
    turn: 0,
    sessionId,
    tenantId,
    sandboxRoot: root,
  }) as ToolContext;

async function call(name: string, args: unknown, tenantId: string, sessionId: string) {
  const tool = tools.get(name);
  assert.ok(tool, `${name} missing`);
  return (await tool.handler(args, tctx(tenantId, sessionId))) as { ok: boolean; data?: any; error?: string };
}

function api(method: string, path: string, tenantId: string, body?: unknown): Promise<{ status: number; body: any }> {
  assert.ok(router);
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      json: (value: unknown) => resolve({ status, body: value }),
      status: (code: number) => {
        status = code;
        return { json: (value: unknown) => resolve({ status, body: value }) };
      },
      writeHead: () => undefined,
      end: () => undefined,
    };
    void router!({ method, path, body, tenantId }, res);
  });
}

describe('todo tenant isolation', () => {
  it('tool list/update only sees and mutates own tenant cards', async () => {
    const a = await call('todo_add', { title: 'A task' }, 'tenant-a', 's-a');
    assert.equal(a.ok, true);
    const b = await call('todo_add', { title: 'B task' }, 'tenant-b', 's-b');
    assert.equal(b.ok, true);
    const listA = await call('todo_list', { all: true }, 'tenant-a', 's-a');
    const listB = await call('todo_list', { all: true }, 'tenant-b', 's-b');
    assert.deepEqual(
      listA.data.cards.map((c: any) => c.title),
      ['A task'],
    );
    assert.deepEqual(
      listB.data.cards.map((c: any) => c.title),
      ['B task'],
    );
    const stolen = await call('todo_update', { id: a.data.id, status: 'done' }, 'tenant-b', 's-b');
    assert.equal(stolen.ok, false);
  });

  it('REST API filters every operation by tenant', async () => {
    const a = await call('todo_add', { title: 'panel A' }, 'tenant-a', 's-a');
    const b = await call('todo_add', { title: 'panel B' }, 'tenant-b', 's-b');
    const listA = await api('GET', '/board/cards', 'tenant-a');
    assert.deepEqual(
      listA.body.cards.map((c: any) => c.title),
      ['A task', 'panel A'],
    );
    const foreignDelete = await api('DELETE', `/board/cards/${b.data.id}`, 'tenant-a');
    assert.equal(foreignDelete.status, 404);
    const ownDelete = await api('DELETE', `/board/cards/${a.data.id}`, 'tenant-a');
    assert.equal(ownDelete.status, 200);
    const listB = await api('GET', '/board/cards', 'tenant-b');
    assert.ok(listB.body.cards.some((c: any) => c.title === 'panel B'));
    const cleared = await api('POST', '/board/clear-done', 'tenant-b');
    assert.equal(cleared.status, 200);
    assert.equal(typeof cleared.body.removed, 'number');
  });

  it('reorder 端点不会被 /cards/:id 抢先匹配', async () => {
    const a = await call('todo_add', { title: 'first' }, 'tenant-c', 's-c');
    const b = await call('todo_add', { title: 'second' }, 'tenant-c', 's-c');
    const reordered = await api('PATCH', '/board/cards/reorder', 'tenant-c', {
      cards: [
        { id: a.data.id, order: 9 },
        { id: b.data.id, order: 1 },
      ],
    });
    assert.equal(reordered.status, 200);
    const list = await api('GET', '/board/cards', 'tenant-c');
    assert.deepEqual(
      list.body.cards.map((c: any) => c.title),
      ['second', 'first'],
    );
  });
});
