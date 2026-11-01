/**
 * server/tests/deploy-mode.spec.ts —— API-02 部署模式回归
 * 覆盖：模式解析（local/trusted/remote 前置校验、fail-closed）、
 * trusted 下 GET 也强制 token、审批凭据在 trusted 模式自动强制。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeployMode, methodRequiresAuth, deployPosture } from '../deploy-mode';
import { approvalTokenRequired } from '../routes/approvals';
import { createApiTokenGuard } from '../index';

function guardCall(deployMode: string | undefined, method: string, headers: Record<string, string>): Promise<{ next: boolean; status: number }> {
  if (deployMode) process.env.MAHARNESS_MODE = deployMode; else delete process.env.MAHARNESS_MODE;
  process.env.MAHARNESS_API_TOKEN = 'tok-test';
  const resolved = resolveDeployMode();
  const guard = createApiTokenGuard(undefined, undefined, undefined, resolved.ok ? resolved.config : undefined);
  return new Promise((done) => {
    let next = false;
    const res = { status: (c: number) => ({ json: () => done({ next, status: c }) }) };
    guard({ method, headers } as never, res as never, () => { next = true; done({ next, status: 0 }); });
  });
}

// 跨文件测试隔离：本文件会改全局 env（MAHARNESS_MODE / MAHARNESS_API_TOKEN），
// describe 结束时还原，避免污染按文件名顺序在其后运行的 auth.spec 等。
const savedMode = process.env.MAHARNESS_MODE;
const savedToken = process.env.MAHARNESS_API_TOKEN;
import { after } from 'node:test';
after(() => {
  if (savedMode === undefined) delete process.env.MAHARNESS_MODE; else process.env.MAHARNESS_MODE = savedMode;
  if (savedToken === undefined) delete process.env.MAHARNESS_API_TOKEN; else process.env.MAHARNESS_API_TOKEN = savedToken;
});

describe('部署模式解析（API-02）', () => {
  test('local：默认回环 + 免鉴权；禁止 MAHARNESS_BIND', () => {
    const r = resolveDeployMode({ MAHARNESS_MODE: 'local', MAHARNESS_API_TOKEN: '' });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.config.bindHost, '127.0.0.1');
      assert.equal(r.config.authRequired, false);
      assert.equal(methodRequiresAuth(r.config), false);
    }
    const bad = resolveDeployMode({ MAHARNESS_MODE: 'local', MAHARNESS_BIND: '0.0.0.0' });
    assert.ok(!bad.ok);
  });

  test('trusted：必须带 token；TLS 配置拒绝', () => {
    const missing = resolveDeployMode({ MAHARNESS_MODE: 'trusted' });
    assert.ok(!missing.ok && missing.errors.some((e) => /MAHARNESS_API_TOKEN/.test(e)));
    const withTls = resolveDeployMode({ MAHARNESS_MODE: 'trusted', MAHARNESS_API_TOKEN: 'x', MAHARNESS_TLS_CERT: 'a', MAHARNESS_TLS_KEY: 'b' });
    assert.ok(!withTls.ok && withTls.errors.some((e) => /trusted 模式只绑回环/.test(e)));
    const ok = resolveDeployMode({ MAHARNESS_MODE: 'trusted', MAHARNESS_API_TOKEN: 'x' });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.config.authRequired, true);
      assert.equal(ok.config.approvalEnforced, true);
      assert.equal(methodRequiresAuth(ok.config), true, 'trusted 下 GET 也受门');
    }
  });

  test('remote：TLS 与 token 缺一即拒；齐备时绑定非回环并启用 TLS', () => {
    const noTls = resolveDeployMode({ MAHARNESS_MODE: 'remote', MAHARNESS_API_TOKEN: 'x' });
    assert.ok(!noTls.ok && noTls.errors.some((e) => /TLS/.test(e)));
    const noToken = resolveDeployMode({ MAHARNESS_MODE: 'remote', MAHARNESS_TLS_CERT: 'a', MAHARNESS_TLS_KEY: 'b' });
    assert.ok(!noToken.ok && noToken.errors.some((e) => /MAHARNESS_API_TOKEN/.test(e)));
    const halfTls = resolveDeployMode({ MAHARNESS_MODE: 'remote', MAHARNESS_API_TOKEN: 'x', MAHARNESS_TLS_CERT: 'a' });
    assert.ok(!halfTls.ok && halfTls.errors.some((e) => /成对/.test(e)));
    const ok = resolveDeployMode({ MAHARNESS_MODE: 'remote', MAHARNESS_API_TOKEN: 'x', MAHARNESS_TLS_CERT: 'a', MAHARNESS_TLS_KEY: 'b', MAHARNESS_BIND: '192.168.1.10' });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.config.bindHost, '192.168.1.10');
      assert.ok(ok.config.tls);
      assert.deepEqual(deployPosture(ok.config), { mode: 'remote', bind: '192.168.1.10', tls: true, apiAuthRequired: true, approvalEnforced: true });
    }
  });

  test('无效模式名 fail-closed', () => {
    const r = resolveDeployMode({ MAHARNESS_MODE: 'yolo' });
    assert.ok(!r.ok && r.errors[0].includes('无效值'));
  });

  test('审批凭据：trusted/remote 模式自动强制', () => {
    const prev = process.env.MAHARNESS_APPROVAL_TOKEN;
    process.env.MAHARNESS_APPROVAL_TOKEN = '';
    process.env.MAHARNESS_MODE = 'trusted';
    assert.equal(approvalTokenRequired(), true);
    process.env.MAHARNESS_MODE = 'local';
    assert.equal(approvalTokenRequired(), false);
    process.env.MAHARNESS_MODE = prev ?? '';
    if (!prev) delete process.env.MAHARNESS_MODE;
  });

  test('guard：trusted 下无头 GET 401、带头放行；local 下 GET 放行', async () => {
    const trustedGet = await guardCall('trusted', 'GET', {});
    assert.equal(trustedGet.status, 401, 'trusted 模式 GET 必须带 token');
    const trustedGetOk = await guardCall('trusted', 'GET', { 'x-maharness-token': 'tok-test' });
    assert.equal(trustedGetOk.next, true);
    const localGet = await guardCall(undefined, 'GET', {});
    assert.equal(localGet.next, true, 'local 模式 GET 免鉴权');
    const localPost = await guardCall(undefined, 'POST', {});
    assert.equal(localPost.status, 401, 'local 且已设 token：无头 POST 仍受门（既有行为）');
  });
});
