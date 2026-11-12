import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTenantToolCall, resetTenantToolLimit, TenantToolQuotaError, tenantToolCallCount,
} from '../tenant-limits';

describe('租户工具调用频率配额', () => {
  test('0 不限制；窗口内超过上限抛出 429 语义错误', () => {
    resetTenantToolLimit('t');
    assert.doesNotThrow(() => assertTenantToolCall('t', 0));
    assert.doesNotThrow(() => assertTenantToolCall('t', 2, 1000));
    assert.doesNotThrow(() => assertTenantToolCall('t', 2, 1500));
    assert.equal(tenantToolCallCount('t', 1600), 2);
    assert.throws(
      () => assertTenantToolCall('t', 2, 2000),
      (error: unknown) => error instanceof TenantToolQuotaError
        && error.status === 429
        && error.code === 'TENANT_TOOL_QUOTA',
    );
  });

  test('窗口过期后重新计数', () => {
    resetTenantToolLimit('t2');
    assertTenantToolCall('t2', 1, 0);
    assert.equal(tenantToolCallCount('t2', 30_000), 1);
    assert.doesNotThrow(() => assertTenantToolCall('t2', 1, 60_001));
    assert.equal(tenantToolCallCount('t2', 60_002), 1);
    resetTenantToolLimit('t2');
    assert.equal(tenantToolCallCount('t2'), 0);
  });
});
