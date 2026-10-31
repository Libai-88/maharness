import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFact, isFactActive, normalizeFact } from '../schema';

describe('长期记忆 schema', () => {
  it('旧 facts 懒迁移为带来源与置信度的活动记录', () => {
    const fact = normalizeFact({ id: 'old', text: '项目约束', ts: 10 });
    assert.deepEqual(fact, { id: 'old', text: '项目约束', ts: 10, source: 'agent', confidence: 0.8, conflictsWith: [] });
    assert.equal(isFactActive(fact, 10), true);
  });

  it('置信度归一化，过期和撤回统一不再活动', () => {
    const expired = buildFact('expired', '短期事实', 100, { source: 'user', confidence: 2, expiresAt: 200 });
    assert.equal(expired.confidence, 1);
    assert.equal(isFactActive(expired, 200), false);
    assert.equal(isFactActive({ ...expired, expiresAt: undefined, revokedAt: 150 }, 160), false);
  });

  it('保留冲突引用和来源元数据，供召回审计', () => {
    const fact = buildFact('new', '新结论', 100, { source: 'tool', confidence: 0.35, conflictsWith: ['old'] });
    assert.equal(fact.source, 'tool');
    assert.equal(fact.confidence, 0.35);
    assert.deepEqual(fact.conflictsWith, ['old']);
  });
});
