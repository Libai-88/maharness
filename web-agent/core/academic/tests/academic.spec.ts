import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import academic from '../index';

describe('学术智能体插件', () => {
  it('技能包存在时注册 ARS 路由 persona', () => {
    const personas: any[] = [];
    academic.onLoad({
      register(value: any) {
        if (value.kind === 'persona') personas.push(value.persona);
      },
      logger: { info() {}, warn() {} },
    } as never);
    assert.equal(personas.length, 2);
    assert.equal(personas[0].id, 'academic-light');
    assert.equal(personas[1].id, 'ars-routing');
    assert.match(personas[1].content, /deep-research/);
  });
});
