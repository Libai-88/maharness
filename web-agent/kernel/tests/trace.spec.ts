/**
 * kernel/tests/trace.spec.ts —— Trace 生命周期回归测试
 * 覆盖：构造登记 process exit 监听器；dispose 移除——反复创建 Kernel/Trace
 * 不再累积监听器（MaxListenersExceededWarning 根因）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../bus';
import { Trace } from '../trace';

describe('Trace 生命周期', () => {
  test('构造登记 exit 监听器，dispose 移除（不累积）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const before = process.listenerCount('exit');
      const t1 = new Trace(new EventBus(), join(root, 't1'));
      const t2 = new Trace(new EventBus(), join(root, 't2'));
      assert.equal(process.listenerCount('exit'), before + 2);

      t1.dispose();
      t2.dispose();
      assert.equal(process.listenerCount('exit'), before, 'dispose 后监听器应全部移除');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dispose 可重复调用（幂等，不抛错）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const before = process.listenerCount('exit');
      const t = new Trace(new EventBus(), join(root, 't'));
      t.dispose();
      t.dispose(); // 幂等
      assert.equal(process.listenerCount('exit'), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('记录步骤后 flush 落盘；dispose 后实例仍可 flush（关闭前兜底）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const trace = new Trace(new EventBus(), join(root, 'traces'));
      const step = trace.startStep({ traceId: 'a', turn: 0, type: 'llm_call', name: 'llm' });
      step.finish({ outputSummary: 'x' });
      trace.dispose();
      trace.flush(); // Kernel.stop 顺序：flush 后 dispose；此处验证 dispose 后仍可手动 flush
      assert.equal(trace.stats().steps, 1);
      assert.equal(trace.stats().llmCalls, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});