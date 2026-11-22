import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema, validateToolArguments } from '../validate';
import type { ToolDef } from '../types';

describe('JSONSchema 子集校验', () => {
  it('对象中的 undefined 与 JSON 序列化后的缺省字段具有相同语义', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      maxProperties: 1,
      additionalProperties: false,
      properties: { name: { type: 'string' }, limit: { type: 'integer' } },
    };
    assert.deepEqual(validateAgainstSchema({ name: 'ok', limit: undefined, extra: undefined }, schema), []);
    assert.ok(validateAgainstSchema({ name: undefined }, schema).some((issue) => issue.includes('缺少必填字段')));
    assert.ok(validateAgainstSchema(Object.create({ name: 'inherited' }), schema).some((issue) => issue.includes('缺少必填字段')));
  });
  it('校验 required、类型、枚举和数值边界', () => {
    const schema = {
      type: 'object',
      required: ['name', 'count'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 8 },
        count: { type: 'integer', minimum: 1, maximum: 5 },
        mode: { type: 'string', enum: ['fast', 'safe'] },
      },
    };
    assert.deepEqual(validateAgainstSchema({ name: 'ok', count: 3, mode: 'safe' }, schema), []);
    const issues = validateAgainstSchema({ name: 'x', count: 9, mode: 'bad', extra: true }, schema);
    assert.ok(issues.some((issue) => issue.includes('minLength')));
    assert.ok(issues.some((issue) => issue.includes('maximum')));
    assert.ok(issues.some((issue) => issue.includes('允许枚举')));
    assert.ok(issues.some((issue) => issue.includes('额外属性')));
  });

  it('校验 patternProperties、minProperties 和 maxProperties', () => {
    const schema = {
      type: 'object',
      minProperties: 1,
      maxProperties: 2,
      patternProperties: {
        '^x-': { type: 'string' },
      },
      additionalProperties: false,
    };
    assert.deepEqual(validateAgainstSchema({ 'x-trace': 'abc' }, schema), []);
    const issues = validateAgainstSchema({ 'x-trace': 1, y: 'no' }, schema);
    assert.ok(issues.some((issue) => issue.includes('期望 string')));
    assert.ok(issues.some((issue) => issue.includes('额外属性')));
  });

  it('校验数组边界和去重', () => {
    const schema = {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string' },
    };
    assert.deepEqual(validateAgainstSchema(['a', 'b'], schema), []);
    const issues = validateAgainstSchema(['a', 'a'], { ...schema, minItems: 3 });
    assert.ok(issues.some((issue) => issue.includes('minItems')));
    assert.ok(issues.some((issue) => issue.includes('uniqueItems')));
  });

  it('校验 pattern、const 和组合 schema', () => {
    const schema = {
      oneOf: [
        { type: 'string', pattern: '^[a-z]+$' },
        { type: 'integer', const: 42 },
      ],
    };
    assert.deepEqual(validateAgainstSchema('abc', schema), []);
    assert.deepEqual(validateAgainstSchema(42, schema), []);
    assert.ok(validateAgainstSchema('ABC', schema).length > 0);
    assert.ok(validateAgainstSchema(7, schema).length > 0);
  });

  it('工具参数直接复用同一校验器', () => {
    const tool: ToolDef = {
      version: '2.0.0',
      permissions: [],
      sideEffect: 'external',
      outputSchema: {},
      name: 'demo',
      description: 'demo',
      parameters: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', pattern: '^[a-z/]+\\.md$' },
          limit: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 100 },
        },
      },
      handler: async () => ({ ok: true }),
    };
    assert.deepEqual(validateToolArguments(tool, { path: 'docs/a.md', limit: 10 }), []);
    const issues = validateToolArguments(tool, { path: 'DOCS/A.txt', limit: 100, extra: 1 });
    assert.ok(issues.some((issue) => issue.includes('pattern')));
    assert.ok(issues.some((issue) => issue.includes('exclusiveMaximum')));
    assert.ok(issues.some((issue) => issue.includes('额外属性')));
  });
});
