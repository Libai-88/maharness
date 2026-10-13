/**
 * kernel/tests/sandbox.spec.ts —— 敏感路径双基座判定（A2）与沙箱根缺失（B10）回归
 *
 * A2 的失败形态：安全名单按 `sandboxRoot` 算相对路径，而 `.env`、`data/`、`kernel/`、
 * `core/chat/` 实际位于**项目根**。一旦 `SANDBOX_ROOT` 指到别处（真实部署即如此：
 * 沙箱根 = D:\DEEPSEEK，项目根 = …\maharness\web-agent），相对路径变成
 * `maharness/web-agent/data/secret.key`——既不等于 'data' 也不以 'data/' 开头，
 * 于是「.env/data 不可读」「kernel/ 写保护」**同时失效**，且写侧从来没有敏感名单。
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDeniedReadPath, isProtectedWritePath, isApprovalRequiredWritePath,
  sensitiveTarget, resolveInSandbox, resetCoreEditGuard,
} from '../sandbox';

/** 造一个「沙箱根 ≠ 项目根」的真实部署形态 */
function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), 'mh-sandbox-'));
  const sandboxRoot = join(base, 'workspace');          // Agent 的边界（宽）
  const projectRoot = join(sandboxRoot, 'maharness', 'web-agent'); // 内核与数据实际所在（在边界内）
  mkdirSync(join(projectRoot, 'kernel'), { recursive: true });
  mkdirSync(join(projectRoot, 'core', 'chat'), { recursive: true });
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  writeFileSync(join(projectRoot, '.env'), 'A=1', 'utf-8');
  writeFileSync(join(projectRoot, 'data', 'secret.key'), 'k', 'utf-8');
  writeFileSync(join(projectRoot, 'kernel', 'index.ts'), 'x', 'utf-8');
  writeFileSync(join(projectRoot, 'core', 'chat', 'agent.ts'), 'x', 'utf-8');
  writeFileSync(join(sandboxRoot, 'notes.md'), 'x', 'utf-8');
  return { base, sandboxRoot, projectRoot };
}

let r: ReturnType<typeof makeRoots>;
beforeEach(() => { r = makeRoots(); resetCoreEditGuard(); });
afterEach(() => {
  resetCoreEditGuard();
  delete process.env.AGENT_ALLOW_CORE_EDIT;
  rmSync(r.base, { recursive: true, force: true });
});

const abs = (p: string) => resolveInSandbox(r.sandboxRoot, p);

describe('A2：读保护按双基座判定', () => {
  test('项目根下的 data/ 与 .env 仍然读拒（旧实现只在沙箱根 == 项目根时有效）', () => {
    assert.equal(isDeniedReadPath(abs('maharness/web-agent/data/secret.key'), r.sandboxRoot), false,
      '单基座（仅沙箱根）下的旧行为——这正是要修的洞');
    assert.equal(isDeniedReadPath(abs('maharness/web-agent/data/secret.key'), r.sandboxRoot, r.projectRoot), true,
      '补上项目基座后必须拦');
    assert.equal(isDeniedReadPath(abs('maharness/web-agent/.env'), r.sandboxRoot, r.projectRoot), true);
    assert.equal(isDeniedReadPath(abs('notes.md'), r.sandboxRoot, r.projectRoot), false, '普通工作区文件不受影响');
  });

  test('沙箱根本下的 data/ 与 .env 照旧拦（两种写法都必须成立）', () => {
    assert.equal(isDeniedReadPath(abs('data/x.json'), r.sandboxRoot, r.projectRoot), true);
    assert.equal(isDeniedReadPath(abs('.env'), r.sandboxRoot, r.projectRoot), true);
  });
});

describe('A2：写侧敏感门（此前完全没有写侧名单）', () => {
  test('kernel/ 与 core/chat/ 硬拒，且长路径绕过无效', () => {
    assert.equal(isProtectedWritePath(abs('maharness/web-agent/kernel/index.ts'), r.sandboxRoot, r.projectRoot), true);
    assert.equal(isProtectedWritePath(abs('maharness/web-agent/core/chat/agent.ts'), r.sandboxRoot, r.projectRoot), true);
    assert.equal(isProtectedWritePath(abs('notes.md'), r.sandboxRoot, r.projectRoot), false);
  });

  test('.env 与 data/ 属「需批准」而非硬拒（用户仍可显式授权）', () => {
    assert.equal(isApprovalRequiredWritePath(abs('maharness/web-agent/.env'), { sandboxRoot: r.sandboxRoot, projectRoot: r.projectRoot }), true);
    assert.equal(isApprovalRequiredWritePath(abs('maharness/web-agent/data/rules.json'), { sandboxRoot: r.sandboxRoot, projectRoot: r.projectRoot }), true);
    assert.equal(isApprovalRequiredWritePath(abs('notes.md'), { sandboxRoot: r.sandboxRoot, projectRoot: r.projectRoot }), false);
    // 保护区不算「可批准的敏感写」——它是硬拒
    assert.equal(isApprovalRequiredWritePath(abs('maharness/web-agent/kernel/index.ts'), { sandboxRoot: r.sandboxRoot, projectRoot: r.projectRoot }), false);
  });

  test('sensitiveTarget 给出可读原因（审批卡要说明为什么拦）', () => {
    const t = sensitiveTarget(abs('maharness/web-agent/data/agent.db'), { sandboxRoot: r.sandboxRoot, projectRoot: r.projectRoot });
    assert.equal(t.hit, true);
    assert.match(t.reason, /data/);
  });
});

describe('B10：AGENT_ALLOW_CORE_EDIT 可重置', () => {
  test('设置开关并 reset 后放行；撤销并 reset 后恢复保护', () => {
    const target = abs('maharness/web-agent/kernel/index.ts');
    assert.equal(isProtectedWritePath(target, r.sandboxRoot, r.projectRoot), true, '默认保护');
    process.env.AGENT_ALLOW_CORE_EDIT = '1';
    resetCoreEditGuard();
    assert.equal(isProtectedWritePath(target, r.sandboxRoot, r.projectRoot), false, '放行开关生效');
    delete process.env.AGENT_ALLOW_CORE_EDIT;
    resetCoreEditGuard();
    assert.equal(isProtectedWritePath(target, r.sandboxRoot, r.projectRoot), true, 'reset 后可恢复（测试隔离）');
  });
});

describe('B10：沙箱根不存在时报错归因正确', () => {
  test('报「沙箱根目录不存在」而不是「指向沙箱外（符号链接）」', () => {
    const missing = join(r.base, 'gone', 'nowhere');
    assert.equal(existsSync(missing), false);
    assert.throws(() => resolveInSandbox(missing, 'new-file.md'), /沙箱根目录不存在/);
  });

  test('沙箱根存在时，在根下新建文件正常解析（不被误拒）', () => {
    const p = resolveInSandbox(r.sandboxRoot, 'brand-new.md');
    assert.equal(p.toLowerCase(), join(r.sandboxRoot, 'brand-new.md').toLowerCase());
  });

  test('越界仍然拒绝', () => {
    assert.throws(() => resolveInSandbox(r.sandboxRoot, '../../etc/passwd'), /越界/);
  });
});
