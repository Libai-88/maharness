import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSkillEntries, topSkills, type SkillRouteEntry } from '../router';

const entries: SkillRouteEntry[] = [
  {
    name: 'plugin-authoring',
    description: '编写并现场加载 maharness 插件，使用 create_plugin 注册工具',
    triggers: ['写插件', '创建插件', 'plugin.json'],
    appliesWhen: ['扩展工具能力'],
    rejectWhen: ['不要插件', '只要技能'],
  },
  {
    name: 'skill-authoring',
    description: '编写 SKILL.md 技能包，定义触发条件与工作流',
    triggers: ['写技能', 'SKILL.md', '技能包'],
    appliesWhen: ['沉淀方法论'],
  },
  {
    name: 'thinking-chain',
    description: '用第一性原理拆解问题，形成可验证的推理链',
    triggers: ['第一性原理', '拆解问题'],
  },
];

describe('技能路由打分', () => {
  test('显式 trigger 优先命中对应技能', () => {
    const ranked = scoreSkillEntries(entries, '帮我写一个插件并现场加载');
    assert.equal(ranked[0]?.name, 'plugin-authoring');
    assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));

    const skill = scoreSkillEntries(entries, '这个 SKILL.md 技能包怎么写');
    assert.equal(skill[0]?.name, 'skill-authoring');
  });

  test('appliesWhen 提供额外权重，rejectWhen 可以否决误路由', () => {
    const positive = scoreSkillEntries(entries, '我需要扩展工具能力，写插件');
    assert.equal(positive[0]?.name, 'plugin-authoring');

    const negative = scoreSkillEntries(entries, '不要插件，只要技能，怎么沉淀方法论');
    assert.notEqual(negative[0]?.name, 'plugin-authoring');
    const negativeHit = negative.find((item) => item.name === 'plugin-authoring');
    assert.ok(negativeHit, '负例命中 plugin-authoring');
    assert.equal((negativeHit.score ?? 0) < 0, true);
  });

  test('topSkills 过滤零分并保留排序', () => {
    const ranked = topSkills(scoreSkillEntries(entries, '第一性原理拆解问题'), 2);
    assert.deepEqual(
      ranked.map((item) => item.name),
      ['thinking-chain'],
    );
  });
});
