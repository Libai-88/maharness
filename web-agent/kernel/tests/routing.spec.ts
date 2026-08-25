/**
 * kernel/tests/routing.spec.ts —— 任务复杂度模型路由（B）回归测试（node:test，零新依赖）
 * 覆盖：routeForTask 按 classifyTask 路由到目标 provider/model、providerId@model 指定模型、
 *       默认键兜底、未配置/目标不存在时返回 undefined、空配置短路。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { routeForTask } from '../../core/chat/routing';
import type { ProviderDef } from '../types';

const cheap: ProviderDef = {
  id: 'cheap', label: 'CHEAP', defaultModel: 'cheap-model',
  async *chat() { yield { type: 'done' } as never; },
};
const strong: ProviderDef = {
  id: 'strong', label: 'STRONG', defaultModel: 'strong-model',
  async *chat() { yield { type: 'done' } as never; },
};
const providers = [cheap, strong];

describe('routeForTask 任务复杂度路由', () => {
  test('按任务类型路由到目标 provider（默认模型）', () => {
    const r = routeForTask('解释一下什么是递归算法', { 问答: 'cheap', 代码: 'strong' }, providers);
    assert.ok(r, '问答任务应命中路由');
    assert.equal(r?.provider.id, 'cheap');
    assert.equal(r?.model, 'cheap-model');
  });

  test('providerId@model 可同时指定模型', () => {
    const r = routeForTask('帮我修复这个 bug', { 代码: 'strong@strong-reasoner' }, providers);
    assert.ok(r);
    assert.equal(r?.provider.id, 'strong');
    assert.equal(r?.model, 'strong-reasoner');
  });

  test('未命中具体类型时走「默认」键兜底', () => {
    const r = routeForTask('随便说点什么', { 默认: 'cheap' }, providers);
    assert.ok(r);
    assert.equal(r?.provider.id, 'cheap');
  });

  test('目标 provider 不存在 → 返回 undefined（调用方回退默认）', () => {
    const r = routeForTask('写一份周报', { 写作: 'ghost' }, providers);
    assert.equal(r, undefined);
  });

  test('空路由配置 / 空 provider 列表 → undefined（不改变现有行为）', () => {
    assert.equal(routeForTask('读取配置文件', {}, providers), undefined);
    assert.equal(routeForTask('读取配置文件', { 文件操作: 'cheap' }, []), undefined);
  });
});
