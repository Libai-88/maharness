import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunEvent } from '../../kernel/run';
import { RunJournal } from '../run/journal';
import { statusAfterAbort, statusOnEvent, terminalStatus } from '../run/state';

test('statusAfterAbort 覆盖关停、暂停、超时与取消四种来源', () => {
  assert.equal(statusAfterAbort('user_pause', false), 'interrupted');
  assert.equal(statusAfterAbort('server_shutdown', true), 'interrupted');
  assert.equal(statusAfterAbort('user_cancel', true), 'interrupted');
  assert.equal(statusAfterAbort('deadline_exceeded', false), 'failed');
  assert.equal(statusAfterAbort('user_cancel', false), 'cancelled');
  assert.equal(statusAfterAbort('run_finished', false), 'cancelled');
  assert.equal(statusAfterAbort(undefined, false), 'cancelled');
});

test('terminalStatus 完成优先，不可恢复与轮数耗尽算失败，其余保持可恢复', () => {
  assert.equal(terminalStatus({ completed: true, nonRecoverable: true, exhausted: true }), 'completed');
  assert.equal(terminalStatus({ completed: false, nonRecoverable: true, exhausted: false }), 'failed');
  assert.equal(terminalStatus({ completed: false, nonRecoverable: false, exhausted: true }), 'failed');
  assert.equal(terminalStatus({ completed: false, nonRecoverable: false, exhausted: false }), 'interrupted');
});

test('statusOnEvent 只改审批边界，其它事件把等待态拉回运行态', () => {
  assert.equal(statusOnEvent('running', 'approval_required'), 'waiting_approval');
  assert.equal(statusOnEvent('waiting_approval', 'approval_required'), 'waiting_approval');
  assert.equal(statusOnEvent('waiting_approval', 'model_call_started'), 'running');
  assert.equal(statusOnEvent('running', 'model_call_started'), undefined);
  assert.equal(statusOnEvent('queued', 'start'), undefined);
});

const event = (runId: string, seq: number): RunEvent => ({ runId, seq, type: 'start', data: {} }) as RunEvent;

test('RunJournal 广播按 run 分组，退订后不再收到事件', () => {
  const seen: number[] = [];
  const journal = new RunJournal();
  const off = journal.subscribe('run-a', (item) => seen.push(item.seq));
  journal.publish(event('run-a', 1));
  journal.publish(event('run-b', 2));
  off();
  journal.publish(event('run-a', 3));
  assert.deepEqual(seen, [1]);
});

test('订阅者抛错不影响其它订阅者，广播前先回调 onEvent', () => {
  const order: string[] = [];
  const journal = new RunJournal((item) => order.push(`refresh:${item.seq}`));
  journal.subscribe('run-a', () => {
    throw new Error('reader failed');
  });
  journal.subscribe('run-a', (item) => order.push(`sub:${item.seq}`));
  assert.doesNotThrow(() => journal.publish(event('run-a', 7)));
  assert.deepEqual(order, ['refresh:7', 'sub:7']);
});

test('close 清空订阅表，之后发布不再触达旧订阅者', () => {
  const seen: number[] = [];
  const journal = new RunJournal();
  journal.subscribe('run-a', (item) => seen.push(item.seq));
  journal.close();
  journal.publish(event('run-a', 9));
  assert.deepEqual(seen, []);
});
