import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sseEventVisible } from '../routes/events';

const sessionTenant = (sessionId: string) => sessionId === 's-a' ? 'tenant-a' : sessionId === 's-b' ? 'tenant-b' : undefined;

describe('SSE 事件租户过滤', () => {
  test('显式 tenantId 只发给同租户', () => {
    assert.equal(sseEventVisible('todo.updated', { tenantId: 'tenant-a' }, 'tenant-a', sessionTenant), true);
    assert.equal(sseEventVisible('todo.updated', { tenantId: 'tenant-a' }, 'tenant-b', sessionTenant), false);
  });

  test('按 sessionId 归属过滤', () => {
    assert.equal(sseEventVisible('trace.step', { sessionId: 's-a' }, 'tenant-a', sessionTenant), true);
    assert.equal(sseEventVisible('trace.step', { sessionId: 's-a' }, 'tenant-b', sessionTenant), false);
    assert.equal(sseEventVisible('approval.requested', { sessionId: 's-b' }, 'tenant-a', sessionTenant), false);
  });

  test('无归属的插件事件只对 default 可见，全局 provider 事件放行', () => {
    assert.equal(sseEventVisible('workbench.updated', {}, 'default', sessionTenant), true);
    assert.equal(sseEventVisible('workbench.updated', {}, 'tenant-a', sessionTenant), false);
    assert.equal(sseEventVisible('items.updated', {}, 'tenant-a', sessionTenant), false);
    assert.equal(sseEventVisible('items.updated', {tenantId:'tenant-a'}, 'tenant-a', sessionTenant), true);
    assert.equal(sseEventVisible('items.updated', {tenantId:'tenant-a'}, 'tenant-b', sessionTenant), false);
    assert.equal(sseEventVisible('provider.error', { message: 'x' }, 'tenant-b', sessionTenant), true);
  });
});
