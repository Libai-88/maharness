import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTraceSteps } from '../trace-diff';
import type { TraceStep } from '../types';

const step = (id: string, name: string, status: TraceStep['status'] = 'done'): TraceStep => ({
  id, traceId: 'trace', turn: 0, type: 'system', name, status, ts: 1,
});

describe('Trace 步骤差异', () => {
  test('报告新增、删除和字段变化', () => {
    const before = [step('same', 'old'), step('removed', 'gone')];
    const after = [step('same', 'new', 'error'), step('added', 'new')];
    const diff = diffTraceSteps(before, after);
    assert.deepEqual(diff.added.map((change) => change.id), ['added']);
    assert.deepEqual(diff.removed.map((change) => change.id), ['removed']);
    assert.deepEqual(diff.changed, [{
      id: 'same', before: before[0], after: after[0], fields: ['name', 'status'],
    }]);
  });

  test('相同步骤产生空差异且不执行任何外部行为', () => {
    const original = step('same', 'stable');
    assert.deepEqual(diffTraceSteps([original], [{ ...original }]), { added: [], removed: [], changed: [] });
  });
});
