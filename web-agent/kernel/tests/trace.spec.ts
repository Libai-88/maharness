/**
 * kernel/tests/trace.spec.ts —— Trace 生命周期回归测试
 * 覆盖：构造登记 process exit 监听器；dispose 移除——反复创建 Kernel/Trace
 * 不再累积监听器（MaxListenersExceededWarning 根因）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

  test('queryArchive：ring 未命中时从 JSONL 归档检索（跨实例/跨重启历史可查）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      const t1 = new Trace(new EventBus(), dir);
      t1.startStep({ traceId: 'arch-1', turn: 0, type: 'tool_call', name: 'read_file' }).finish({ outputSummary: 'ok' });
      t1.startStep({ traceId: 'arch-1', turn: 0, type: 'system', name: 'cost-breaker', parentId: 'par-9' }).fail('x');
      t1.flush(); // 同步落盘
      t1.dispose();

      // 新实例（模拟重启后）：ring 为空，archive 命中
      const t2 = new Trace(new EventBus(), dir);
      const steps = t2.queryArchive('arch-1');
      assert.equal(steps.length, 2, '归档应命中 2 条');
      assert.equal(steps.every((s) => s.traceId === 'arch-1'), true);
      const children = t2.queryArchive(undefined, { parentId: 'par-9' });
      assert.equal(children.length, 1, 'parentId 过滤应命中 1 条');
      const named = t2.queryArchive('arch-1', { name: 'read_file' });
      assert.equal(named.length, 1, 'name 过滤生效');
      t2.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * C2 回归：归档读取从"整文件同步读"改为"尾部按块回读"；归档加保留期轮转。
 * 旧实现 readFileSync(整个文件).split() 的代价随运行时间线性上升（按天只追加、无清理），
 * 叠加 C1 噪声时 ring 未命中的回退查询会明显卡顿。
 */
describe('Trace 归档读取与保留期（C2）', () => {
  test('queryArchive 只读尾部即可命中最新步骤（大文件不全读）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const file = join(dir, `${today}.jsonl`);
      // 造一个"很大"的归档：前面塞垃圾行（不可解析），末尾放两条真步骤
      const junk = Array.from({ length: 50_000 }, (_, i) => `junk-line-${i}-${'x'.repeat(40)}`).join('\n');
      const real = [
        { id: 'p1-1', traceId: 'big', turn: 0, type: 'llm_call', name: 'llm', status: 'done', ts: Date.now() },
        { id: 'p1-2', traceId: 'big', turn: 0, type: 'tool_call', name: 'tool', status: 'done', ts: Date.now() },
      ].map((s) => JSON.stringify(s)).join('\n');
      writeFileSync(file, `${junk}\n${real}\n`, 'utf-8');

      const t = new Trace(new EventBus(), dir);
      const steps = t.queryArchive('big');
      assert.equal(steps.length, 2, '尾部两条真步骤应命中（前面的坏行被跳过）');
      assert.deepEqual(steps.map((s) => s.id), ['p1-1', 'p1-2']);
      t.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pruneOld 按文件名日期删除超期归档，保留期内不动', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
      const names = [day(40), day(20), day(10), day(2), day(0)].map((d) => `${d}.jsonl`);
      for (const n of names) writeFileSync(join(dir, n), '{}\n', 'utf-8');

      const t = new Trace(new EventBus(), dir, 14); // 保留 14 天
      t.pruneOld();
      const left = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
      assert.ok(!left.includes(`${day(40)}.jsonl`), '40 天前的应删');
      assert.ok(!left.includes(`${day(20)}.jsonl`), '20 天前的应删');
      assert.ok(left.includes(`${day(10)}.jsonl`), '10 天内的应留');
      assert.ok(left.includes(`${day(0)}.jsonl`), '今天的应留');
      t.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retainDays=0 关闭清理（不删任何归档）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const old = `${new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)}.jsonl`;
      writeFileSync(join(dir, old), '{}\n', 'utf-8');
      const t = new Trace(new EventBus(), dir, 0);
      t.pruneOld();
      assert.ok(readdirSync(dir).includes(old), 'retainDays=0 时 400 天前的也不删');
      t.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('setRetainDays 热更新生效（缩小后立即清理）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const day = (o: number) => `${new Date(Date.now() - o * 86_400_000).toISOString().slice(0, 10)}.jsonl`;
      writeFileSync(join(dir, day(10)), '{}\n', 'utf-8');
      const t = new Trace(new EventBus(), dir, 30);
      t.pruneOld();
      assert.ok(readdirSync(dir).includes(day(10)), '30 天保留期下 10 天前的不动');
      t.setRetainDays(5);
      t.pruneOld();
      assert.ok(!readdirSync(dir).includes(day(10)), '改 5 天后应清掉');
      t.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});