import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adminToolDenied } from '../tool-privilege';

describe('tool principal privilege', () => {
  it('缺省/local 视为管理员', () => {
    assert.equal(adminToolDenied({}, 'install plugin'), null);
    assert.equal(adminToolDenied({ principal: { role: 'admin' } }, 'install plugin'), null);
  });

  it('member/readonly 被 fail-closed 拒绝', () => {
    assert.match(String(adminToolDenied({ principal: { role: 'member' } }, 'install plugin')), /需要 admin/);
    assert.match(String(adminToolDenied({ principal: { role: 'readonly' } }, 'install plugin')), /需要 admin/);
  });
});
