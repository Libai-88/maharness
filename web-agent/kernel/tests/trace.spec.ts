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
import { performance } from 'node:perf_hooks';
import { EventBus } from '../bus';
import { Trace, validateTraceSteps } from '../trace';
import type { TraceStep } from '../types';

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
      t1.startStep({ traceId: 'arch-1', turn: 0, attempt: 2, type: 'system', name: 'cost-breaker', parentId: 'par-9' }).fail('x');
      t1.flush(); // 同步落盘
      t1.dispose();

      // 新实例（模拟重启后）：ring 为空，archive 命中
      const t2 = new Trace(new EventBus(), dir);
      const steps = t2.queryArchive('arch-1');
      assert.equal(steps.length, 2, '归档应命中 2 条');
      assert.equal(steps.every((s) => s.traceId === 'arch-1'), true);
      const children = t2.queryArchive(undefined, { parentId: 'par-9' });
      assert.equal(children.length, 1, 'parentId 过滤应命中 1 条');
      assert.equal(children[0]?.attempt, 2, '归档应保留重试序号');
      const named = t2.queryArchive('arch-1', { name: 'read_file' });
      assert.equal(named.length, 1, 'name 过滤生效');
      t2.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('归档索引支持 session/plugin 维度和时间状态过滤', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      const t1 = new Trace(new EventBus(), dir);
      t1.startStep({ traceId: 'indexed', sessionId: 'session-a', pluginId: 'plugin-x', turn: 0, type: 'tool_call', name: 'read_file' })
        .finish();
      t1.startStep({ traceId: 'indexed', sessionId: 'session-b', pluginId: 'plugin-y', turn: 0, type: 'tool_call', name: 'write_file' })
        .fail('denied', { errorCategory: 'parameter' });
      t1.flush();
      t1.dispose();

      const t2 = new Trace(new EventBus(), dir);
      const bySession = t2.queryArchive('indexed', { sessionId: 'session-a', pluginId: 'plugin-x' });
      assert.equal(bySession.length, 1);
      assert.equal(bySession[0]?.name, 'read_file');
      const byStatus = t2.queryArchive('indexed', { status: 'error', errorCategory: 'parameter' });
      assert.equal(byStatus.length, 1);
      assert.equal(byStatus[0]?.name, 'write_file');
      t2.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('可从无索引旧 JSONL 重建索引并恢复随机查询', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const step = { id: 'legacy-1', traceId: 'legacy-run', sessionId: 'legacy-session', pluginId: 'legacy-plugin', turn: 0, type: 'system', name: 'legacy', status: 'done', ts: Date.now() };
      writeFileSync(join(dir, `${today}.jsonl`), `${JSON.stringify(step)}\n`, 'utf8');
      const trace = new Trace(new EventBus(), dir);
      assert.deepEqual(trace.rebuildArchiveIndexes(), { files: 1, entries: 1 });
      const found = trace.queryArchive('legacy-run', { sessionId: 'legacy-session', pluginId: 'legacy-plugin' });
      assert.equal(found.length, 1);
      assert.equal(found[0]?.id, 'legacy-1');
      assert.equal(found[0]?.attempt, 0, '旧 JSONL 缺少 attempt 时读取为首次尝试');
      assert.deepEqual(validateTraceSteps(found, { requireResolvedParents: true }), [], '兼容后的旧 JSONL 通过当前 schema');
      trace.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('步骤默认 attempt=0，并保留显式非负尝试序号', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const trace = new Trace(new EventBus(), join(root, 'traces'));
      const first = trace.startStep({ traceId: 'attempts', turn: 0, type: 'llm_call', name: 'llm' });
      const retry = trace.startStep({ traceId: 'attempts', turn: 0, attempt: 1, type: 'system', name: 'retry-policy' });
      const invalid = trace.startStep({ traceId: 'attempts', turn: 0, attempt: -1, type: 'system', name: 'invalid' });
      assert.equal(trace.query('attempts').find((s) => s.id === first.id)?.attempt, 0);
      assert.equal(trace.query('attempts').find((s) => s.id === retry.id)?.attempt, 1);
      assert.equal(trace.query('attempts').find((s) => s.id === invalid.id)?.attempt, 0);
      first.cancel(); retry.cancel(); invalid.cancel(); trace.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('缺失 traceId 的扩展事件自动进入可查询的 unscoped run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const trace = new Trace(new EventBus(), join(root, 'traces'));
      const step = trace.startStep({ traceId: '', turn: 0, type: 'system', name: 'extension-event' });
      step.finish();
      const recorded = trace.query(undefined, { name: 'extension-event' });
      assert.equal(recorded.length, 1);
      assert.match(recorded[0]!.traceId, /^p[0-9a-f]+-unscoped-[0-9]+$/);
      assert.deepEqual(validateTraceSteps(recorded, { requireResolvedParents: true }), []);
      trace.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Trace 步骤 schema 校验稳定 ID、run、尝试序号和父节点自环', () => {
    const valid = { id: 'a', traceId: 'run-1', turn: 0, attempt: 0, type: 'system' as const, status: 'done' as const, ts: 1 };
    assert.deepEqual(validateTraceSteps([valid]), []);
    assert.deepEqual(validateTraceSteps([
      valid,
      { ...valid, id: 'a', attempt: -1, parentId: 'a' },
    ]), [
      '重复或缺失步骤 id: a',
      '步骤 a 的 attempt 非法',
      '步骤 a 不能引用自身为 parentId',
      '步骤 a 的 parentId 形成环',
    ]);
  });

  test('Trace schema 拒绝非法 type/status/时间戳并识别多节点父链环', () => {
    const a = { id: 'a', traceId: 'run-1', turn: 0, attempt: 0, type: 'system' as const, status: 'done' as const, ts: 1, parentId: 'b' };
    const b = { ...a, id: 'b', parentId: 'a' };
    const invalid = { ...a, id: 'bad', type: 'unknown' as never, status: 'broken' as never, ts: Number.NaN };
    const errors = validateTraceSteps([a, b, invalid]);
    assert.ok(errors.includes('步骤 bad 的 type 非法'));
    assert.ok(errors.includes('步骤 bad 的 status 非法'));
    assert.ok(errors.includes('步骤 bad 的 ts 非法'));
    assert.ok(errors.some((error) => error.includes('parentId 形成环')));
  });

  test('Trace schema 校验可选字段的类型、范围和枚举', () => {
    const invalid = {
      id: 'optional-invalid', traceId: 'run-optional', turn: 0, attempt: 0,
      type: 'system' as const, status: 'done' as const, ts: 20,
      endTs: 10, durationMs: -1, tokensIn: 1.5, tokensOut: -1, tokensCached: 2.2,
      cost: Number.NaN, cacheLayer: 'L4' as never, errorCategory: 'fatal' as never,
      retryable: 'yes' as never, retryDelayMs: -5, pluginId: 42 as never,
    };
    const errors = validateTraceSteps([invalid]);
    assert.ok(errors.includes('步骤 optional-invalid 的 endTs 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 durationMs 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 tokensIn 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 tokensOut 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 tokensCached 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 cost 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 cacheLayer 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 errorCategory 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 retryable 类型非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 retryDelayMs 非法'));
    assert.ok(errors.includes('步骤 optional-invalid 的 pluginId 类型非法'));
  });

  test('Trace schema 接受全部受支持的步骤类型、状态和枚举值', () => {
    const types = ['llm_call', 'tool_call', 'cache_hit', 'user_msg', 'system', 'service_call'] as const;
    const statuses = ['running', 'done', 'error', 'cancelled'] as const;
    const steps = types.flatMap((type, typeIndex) => statuses.map((status, statusIndex) => ({
      id: `valid-${typeIndex}-${statusIndex}`, traceId: 'valid-enums', turn: 0, attempt: 0,
      type, status, ts: 10, ...(status === 'running' ? {} : { endTs: 11, durationMs: 1 }),
      sessionId: 'session', pluginId: 'plugin', name: 'step', inputSummary: 'input',
      cacheLayer: 'L1' as const, cacheKey: 'key', outputSummary: 'output',
      tokensIn: 2, tokensOut: 3, tokensCached: 1, cost: 0.25,
      error: 'detail', errorCategory: 'transient' as const, errorCode: 'HTTP_503', retryable: true, retryDelayMs: 1200,
    })));
    assert.deepEqual(validateTraceSteps(steps), []);
  });

  test('Trace 完整图校验可拒绝未解析父节点，默认仍兼容跨批次父 span', () => {
    const child = { id: 'child', traceId: 'run-child', turn: 0, attempt: 0, type: 'tool_call' as const, status: 'done' as const, ts: 2, parentId: 'parent' };
    assert.deepEqual(validateTraceSteps([child]), []);
    assert.deepEqual(validateTraceSteps([child], { requireResolvedParents: true }), [
      '步骤 child 的 parentId 未解析：parent',
    ]);
    const parent = { id: 'parent', traceId: 'run-parent', turn: 0, attempt: 0, type: 'system' as const, status: 'done' as const, ts: 1 };
    assert.deepEqual(validateTraceSteps([parent, child], { requireResolvedParents: true }), []);
  });

  test('查询结果可补齐跨 trace 的父链，并报告无法解析的父节点', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const trace = new Trace(new EventBus(), join(root, 'traces'));
      const parent = trace.startStep({ traceId: 'parent-run', turn: 0, type: 'tool_call', name: 'run_subagent' });
      parent.finish();
      const child = trace.startStep({ traceId: 'child-run', turn: 0, type: 'system', name: 'child', parentId: parent.id });
      child.finish();
      const resolved = trace.resolveParentChain([trace.query('child-run')[0]!]);
      assert.deepEqual(resolved.unresolvedParentIds, []);
      assert.deepEqual(resolved.steps.map((step) => step.id), [parent.id, child.id]);
      const missing = trace.resolveParentChain([{ ...trace.query('child-run')[0]!, parentId: 'missing-parent' } as TraceStep]);
      assert.deepEqual(missing.unresolvedParentIds, ['missing-parent']);
      trace.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  test('按归档索引从 10 万事件中定位旧 trace，P95 单次查询低于 500ms', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(dir, `${today}.jsonl`);
      const indexPath = join(dir, `${today}.idx`);
      const lines: string[] = [];
      const indexes: string[] = [];
      let offset = 0;
      for (let i = 0; i < 100_000; i++) {
        const step = { id: `p-${i}`, traceId: i === 12_345 ? 'old-target' : `run-${i}`, turn: 0, type: 'system', name: 'load', status: 'done', ts: i + 1 };
        const line = JSON.stringify(step);
        lines.push(line);
        if (step.traceId === 'old-target') indexes.push(JSON.stringify({ traceId: step.traceId, offset, length: Buffer.byteLength(line) }));
        offset += Buffer.byteLength(line) + 1;
      }
      writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf-8');
      writeFileSync(indexPath, `${indexes.join('\n')}\n`, 'utf-8');
      const trace = new Trace(new EventBus(), dir);
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const found = trace.queryArchive('old-target');
        samples.push(performance.now() - started);
        assert.equal(found.length, 1);
        assert.equal(found[0]?.id, 'p-12345');
      }
      samples.sort((a, b) => a - b);
      assert.ok(samples[4]! < 500, `P95 查询耗时 ${samples[4]!.toFixed(1)}ms`);
      trace.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('10 万事件游标分页无重叠且 P95 低于 500ms', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-trace-'));
    try {
      const dir = join(root, 'traces');
      mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(dir, `${today}.jsonl`);
      const indexPath = join(dir, `${today}.idx`);
      const lines: string[] = [];
      const indexes: string[] = [];
      let offset = 0;
      for (let i = 0; i < 100_000; i++) {
        const step = { id: `page-${i}`, traceId: 'page-run', turn: 0, type: 'system', name: 'page', status: 'done', ts: i + 1 };
        const line = JSON.stringify(step);
        lines.push(line);
        indexes.push(JSON.stringify({ traceId: step.traceId, ts: step.ts, offset, length: Buffer.byteLength(line) }));
        offset += Buffer.byteLength(line) + 1;
      }
      writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
      writeFileSync(indexPath, `${indexes.join('\n')}\n`, 'utf8');
      const trace = new Trace(new EventBus(), dir);
      const samples: number[] = [];
      const seen = new Set<string>();
      let before = Number.POSITIVE_INFINITY;
      for (let pageNo = 0; pageNo < 5; pageNo++) {
        const started = performance.now();
        const page = trace.queryArchive('page-run', { beforeTs: before, limit: 100 });
        samples.push(performance.now() - started);
        assert.equal(page.length, 100);
        for (const step of page) {
          assert.equal(seen.has(step.id), false, '游标分页不应重复返回步骤');
          seen.add(step.id);
        }
        before = page[0]!.ts;
      }
      samples.sort((a, b) => a - b);
      assert.ok(samples[4]! < 500, `分页 P95 查询耗时 ${samples[4]!.toFixed(1)}ms`);
      trace.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
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
