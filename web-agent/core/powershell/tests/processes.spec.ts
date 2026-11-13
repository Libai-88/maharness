import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandProcesses } from '../processes';
import type { ToolContext } from '../../../kernel/types';

function setup(capacity = 16, outputLimit?: number) {
  const states = new Map<string, unknown>();
  const commands = new CommandProcesses((id, state) => states.set(id, structuredClone(state)), id => states.get(id) as never, capacity, outputLimit);
  const abort = new AbortController();
  const ctx = { tenantId: 'a', runId: 'run', sandboxRoot: process.cwd(), runSignal: abort.signal } as ToolContext;
  return { commands, ctx, abort };
}

test('background commands preserve paged output and are scoped to their task and tenant', { skip: process.platform !== 'win32' }, async () => {
  const { commands, ctx } = setup();
  try {
    const run = commands.start("Write-Output 'abcdefgh'", ctx);
    const result = await commands.wait(run.id, ctx, 10000);
    assert.equal(result.status, 'exited');
    assert.equal(commands.read(run.id, ctx, 2, 3).output, 'cde');
    assert.throws(() => commands.read(run.id, { ...ctx, tenantId: 'b' }), /命令不存在/);
    assert.throws(() => commands.read(run.id, { ...ctx, runId: 'other' }), /命令不存在/);
  } finally { commands.stopAll(); }
});

test('wait timeout leaves process running; cancellation and capacity track physical exit', { skip: process.platform !== 'win32' }, async () => {
  const { commands, ctx, abort } = setup(1);
  const run = commands.start('Start-Sleep -Seconds 60', ctx);
  try {
    assert.equal((await commands.wait(run.id, ctx, 5)).status, 'running');
    assert.throws(() => commands.start('Get-Date', ctx), /容量/);
    const waitAbort = new AbortController();
    const waiting = commands.wait(run.id, { ...ctx, signal: waitAbort.signal }, 10000);
    waitAbort.abort();
    await assert.rejects(waiting, /等待已取消/);
    assert.equal(commands.read(run.id, ctx).status, 'running');
    abort.abort();
    assert.equal((await commands.wait(run.id, ctx, 10000)).status, 'cancelled');
    const second = commands.start('Get-Date', { ...ctx, runSignal: undefined });
    assert.equal((await commands.wait(second.id, ctx, 10000)).status, 'exited');
  } finally { commands.stopAll(); }
});

test('output capacity stops the command and reports the incomplete observation', { skip: process.platform !== 'win32' }, async () => {
  const { commands, ctx } = setup(1, 20);
  try {
    const run = commands.start("Write-Output ('x' * 1000); Start-Sleep -Seconds 60", ctx);
    const result = await commands.wait(run.id, ctx, 10000);
    assert.equal(result.status, 'failed'); assert.equal(result.outputLimited, true);
    assert.equal(result.output.length, 20); assert.equal(result.truncated, true);
  } finally { commands.stopAll(); }
});
