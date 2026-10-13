/**
 * server/tests/auth.spec.ts —— A6（HTTP 层无鉴权）+ A7（密钥）回归测试
 * 用**真实的 startServer**（临时 AGENT_DATA_DIR 隔离，端口取空闲端口），断言：
 *   (b) 设了 MAHARNESS_API_TOKEN：无头变更请求 401 / 带头成功 / 只读不受影响 /
 *       未设该变量时保持既有本机免鉴权行为（向后兼容）；
 *   (a) 危险工作区根：POST /api/workspaces 拒绝 C:\（以及家目录、过短路径），
 *       /switch 对「修复前已入库的危险行」同样复检拒绝；
 *   (c) 审批一次性凭据：强制模式下缺凭据 401、错凭据 403、凭据一次性（重放 403）；
 *       非强制模式下不带凭据仍可回答（不破坏现有前端）；
 *   A6-3：通配 allow 策略需显式确认；
 *   A7：keyBroken 暴露、拒绝静默重建密钥、icacls 失败不抛。
 * Host 头这类 fetch 不便伪造的请求走 node:http 裸请求。
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

// <web-agent>/server/tests/auth.spec.ts → <web-agent>（AGENT_ROOT 必须是仓库根，否则内核找不到 core/ 插件）
const webAgentRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 临时环境：必须在 import server/index 之前设好（rootDir/port 是模块级常量） ----
const tmp = mkdtempSync(join(tmpdir(), 'mh-auth-'));
const dataDir = join(tmp, 'data');
const pluginsDir = join(tmp, 'plugins');
const workspaceDir = join(tmp, 'project', 'demo-app');   // 合法工作区
const workspaceDir2 = join(tmp, 'project', 'other-app'); // 合法工作区（免鉴权回归用）
for (const d of [dataDir, pluginsDir, workspaceDir, workspaceDir2]) mkdirSync(d, { recursive: true });

/** 取一个空闲端口（bind 0 → 记下端口 → 立刻释放给 startServer） */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((res, rej) => s.close((e) => (e ? rej(e) : res())));
  return port;
}

const PORT = await freePort();
process.env.AGENT_ROOT = webAgentRoot;
process.env.PORT = String(PORT);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_USER_PLUGINS_DIR = pluginsDir;
process.env.SANDBOX_ROOT = workspaceDir;
process.env.MAHARNESS_SECRET_KEY_ACL = '0'; // 单测不碰真实 ACL（icacls 只在真实数据目录跑）
process.env.MAHARNESS_API_TOKEN = 'unit-test-token';

// 动态 import：以上环境变量必须先于模块加载生效（与 scripts/selftest.ts 同一手法）
const { startServer, MUTATION_TOKEN_HEADER, requiredApiToken, createApiTokenGuard } = await import('../index');
const { Store, hasEncryptedProviderKeys } = await import('../db');
const { resolveSecretKey, encryptSecret, isEncrypted, hardenSecretKeyPath } = await import('../secrets');
const { ApprovalTokenRegistry, approvalTokens } = await import('../routes/approvals');
const { assessWorkspaceRoot } = await import('../routes/workspaces');
const { isBlanketAllow } = await import('../routes/rules');

const base = `http://127.0.0.1:${PORT}`;
const TOKEN = 'unit-test-token';
const TOKEN_HDR = { 'Content-Type': 'application/json', [MUTATION_TOKEN_HEADER]: TOKEN };
let started: Awaited<ReturnType<typeof startServer>> | undefined;

const post = (path: string, body: unknown, headers: Record<string, string> = TOKEN_HDR) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

/** 取响应 JSON 并标注类型：undici 的 `Response.json()` 返回 `unknown`，
 *  直接点属性会报 TS2571/TS18046（strict 下不给 unknown 开口子）。 */
const jsonOf = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

/** 裸 HTTP 请求：用于伪造 Host / Origin 头（fetch 对 Host 的处理不可靠） */
function rawRequest(opts: { method: string; path: string; headers?: Record<string, string> }): Promise<number> {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, ...opts }, (r) => {
      r.resume(); // 丢掉响应体，只关心状态码
      r.on('end', () => res(r.statusCode ?? 0));
    });
    req.on('error', rej);
    req.end();
  });
}

before(async () => {
  started = await startServer();
});

after(async () => {
  started?.server.close();
  started?.closeEnvWatcher();
  started?.store.close();
  try { await started?.kernel.stop(); } catch { /* 停插件失败不影响清理 */ }
  delete process.env.MAHARNESS_API_TOKEN;
  delete process.env.MAHARNESS_APPROVAL_TOKEN;
  delete process.env.MAHARNESS_ALLOW_BLANKET_ALLOW;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 句柄迟释放 */ }
});

describe('A6-b 变更类端点的可选 token 门', () => {
  test('设置 MAHARNESS_API_TOKEN 后：无头 POST 得 401，带头 POST 成功', async () => {
    const noHeader = await post('/api/workspaces', { path: workspaceDir }, { 'Content-Type': 'application/json' });
    assert.equal(noHeader.status, 401, '变更类请求缺 token 必须 401');
    assert.match(String((await jsonOf(noHeader)).error ?? ''), /未授权/, '错误信息为中文口径');

    const withHeader = await post('/api/workspaces', { path: workspaceDir });
    assert.equal(withHeader.status, 200, '带正确 token 的变更请求应成功');
    assert.equal((await jsonOf<{ path: string }>(withHeader)).path, workspaceDir);

    const wrong = await post('/api/workspaces', { path: workspaceDir }, { ...TOKEN_HDR, [MUTATION_TOKEN_HEADER]: 'wrong' });
    assert.equal(wrong.status, 401, 'token 不匹配仍须 401');
  });

  test('PUT/PATCH/DELETE 同受门管辖；GET 只读不受影响', async () => {
    const put = await fetch(`${base}/api/rules/policy`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [] }),
    });
    assert.equal(put.status, 401, 'PUT 是变更类');
    const del = await fetch(`${base}/api/workspaces/nope`, { method: 'DELETE' });
    assert.equal(del.status, 401, 'DELETE 是变更类');
    assert.equal((await fetch(`${base}/api/workspaces`)).status, 200, 'GET 只读放行（不破坏页面/SSE）');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });

  test('未设置该环境变量时回到本机免鉴权（既有使用方式不变）', async () => {
    delete process.env.MAHARNESS_API_TOKEN;
    assert.equal(requiredApiToken(), '');
    const r = await post('/api/workspaces', { path: workspaceDir2 }, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 200, '门关闭时变更请求应照常放行');
    process.env.MAHARNESS_API_TOKEN = TOKEN;
    // 逐请求读 env：设回去即刻恢复（与 .env 热更新同一心智模型）
    assert.equal((await post('/api/workspaces', { path: workspaceDir2 }, { 'Content-Type': 'application/json' })).status, 401);
  });

  test('门是可复用中间件：未启用透传 / 启用后缺头 401 / 只读透传', async () => {
    const guard = createApiTokenGuard();
    const call = (method: string, headers: Record<string, string>) => new Promise<{ next: boolean; status: number }>((done) => {
      let next = false;
      let status = 0;
      const res = { status: (c: number) => { status = c; return { json: () => done({ next, status }) }; } };
      guard({ method, headers } as never, res as never, () => { next = true; done({ next, status }); });
    });
    delete process.env.MAHARNESS_API_TOKEN;
    assert.equal((await call('POST', {})).next, true, '未启用：透传');
    process.env.MAHARNESS_API_TOKEN = TOKEN;
    assert.equal((await call('POST', {})).status, 401, '启用且缺头：401');
    assert.equal((await call('GET', {})).next, true, '只读方法：透传');
    assert.equal((await call('POST', { [MUTATION_TOKEN_HEADER]: TOKEN })).next, true, '带头：透传');
  });

  test('Host/Origin 白名单仍在（token 门不替代 DNS rebinding 防护）', async () => {
    assert.equal(await rawRequest({ method: 'GET', path: '/api/workspaces', headers: { Host: `evil.example:${PORT}` } }), 403);
    assert.equal(await rawRequest({ method: 'GET', path: '/api/workspaces', headers: { Origin: 'http://evil.example' } }), 403);
    assert.equal(await rawRequest({ method: 'GET', path: '/api/workspaces' }), 200, '无 Origin（同机非浏览器工具）仍放行');
  });

  test('插件 API 挂载点（/api/plugins/*）同样受门管辖', async () => {
    // 注册顺序上插件 API 在 registerRoutes 之后，门在其之前 → 变更类必须带头
    const noHeader = await fetch(`${base}/api/plugins/todo/board/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'auth-spec-不该落库' }),
    });
    assert.equal(noHeader.status, 401, '插件 API 的写路径也是变更类端点');
    const withHeader = await fetch(`${base}/api/plugins/todo/board/cards`, {
      method: 'POST', headers: TOKEN_HDR, body: JSON.stringify({ title: 'auth-spec-看板卡片' }),
    });
    assert.equal(withHeader.status, 200, '带头后插件路由照常工作');
    const created = await withHeader.json() as { card?: { id: string } };
    if (created.card?.id) {
      await fetch(`${base}/api/plugins/todo/board/cards/${created.card.id}`, { method: 'DELETE', headers: TOKEN_HDR });
    }
  });
});

describe('A6-a 危险工作区根', () => {
  test('POST /api/workspaces 拒绝 C:\\（盘符根），中文理由', async () => {
    const r = await post('/api/workspaces', { path: 'C:\\' });
    assert.equal(r.status, 400, '盘符根必须被拒绝');
    const b = await jsonOf<{ rule?: string; error?: string }>(r);
    assert.equal(b.rule, 'fs-root');
    assert.match(String(b.error), /拒绝/);
    assert.match(String(b.error), /文件系统根/);
  });

  test('判定函数：家目录/其祖先/过短路径拒；普通项目目录与本项目根放行', () => {
    assert.equal(assessWorkspaceRoot(homedir()).rule, 'home');
    assert.equal(assessWorkspaceRoot(join(homedir(), '..')).rule, 'home-ancestor');
    assert.equal(assessWorkspaceRoot('D:\\a').rule, 'too-shallow');
    assert.equal(assessWorkspaceRoot('/').rule, 'fs-root');
    assert.equal(assessWorkspaceRoot(join(tmp, 'project', 'demo-app')).ok, true);
    assert.equal(assessWorkspaceRoot(webAgentRoot).ok, true, '不误伤现有部署（项目根可作工作区）');
  });

  test('POST 家目录 → 400 且理由明确', async () => {
    const b = await jsonOf<{ rule?: string; error?: string }>(await post('/api/workspaces', { path: homedir() }));
    assert.equal(b.rule, 'home');
    assert.match(String(b.error), /家目录/);
  });

  test('/switch 对已入库的危险行复检拒绝（兜住修复前登记的路径）', async () => {
    const legacy = 'D:\\';
    const row = started!.store.addWorkspace(legacy); // 直接写库，模拟修复前已登记
    const r = await post('/api/workspaces/switch', { path: legacy });
    assert.equal(r.status, 400);
    const b = await jsonOf<{ rule?: string }>(r);
    assert.equal(b.rule, 'fs-root');
    // 列表里如实标出危险项，前端可禁用切换并提示删除
    const list = await jsonOf<{ id: string; path: string; dangerous?: boolean }[]>(await fetch(`${base}/api/workspaces`));
    assert.equal(list.find((w) => w.path === legacy)?.dangerous, true);
    assert.equal(started!.store.removeWorkspace(row.id), true);
  });
});

describe('A6-c 审批一次性凭据', () => {
  test('凭据登记处：铸发稳定、一次性、错值/重放/超时分别拒', () => {
    const reg = new ApprovalTokenRegistry();
    const id = 'a-1';
    const t = reg.issue(id, 'sess', Date.now() + 60_000);
    assert.match(t, /^[0-9a-f]{32}$/, '随机 16 字节 hex');
    assert.equal(reg.issue(id, 'sess', Date.now() + 60_000), t, '同一挂起重复列举拿同一枚');
    assert.equal(reg.verify(id, '0'.repeat(32)), 'invalid', '错凭据须拒');
    assert.equal(reg.verify(id, t), 'ok', '正确凭据通过');
    assert.equal(reg.verify(id, t), 'invalid', '一次性：重放必拒');
    const gone = reg.issue('a-2', undefined, Date.now() - 1);
    assert.equal(reg.verify('a-2', gone), 'expired', '挂起已超时不再接受');
    reg.prune(new Set(['a-1']));
    assert.equal(reg.size(), 1, '剪枝后只留仍在挂起的条目');
  });

  test('强制模式：缺凭据 401、错凭据 403（先于执行器判定）', async () => {
    process.env.MAHARNESS_APPROVAL_TOKEN = '1';
    const missing = await post('/api/approvals/app-x', { approved: true });
    assert.equal(missing.status, 401, '强制模式缺一次性凭据应 401');
    const bad = await fetch(`${base}/api/approvals/app-x`, {
      method: 'POST',
      headers: { ...TOKEN_HDR, 'x-maharness-approval-token': 'f'.repeat(32) },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(bad.status, 403, '凭据不匹配应 403');
    delete process.env.MAHARNESS_APPROVAL_TOKEN;
  });

  test('默认（非强制）模式：不带凭据仍按既有方式回答（不破坏现有前端）', async () => {
    approvalTokens.issue('app-y', undefined, Date.now() + 60_000); // 有记录但请求不带凭据
    const r = await post('/api/approvals/app-y', { approved: true });
    assert.notEqual(r.status, 401, '未强制时不该因为没带凭据就拒绝');
    assert.notEqual(r.status, 403);
  });

  test('GET /api/approvals 形状不变（挂起项带 approvalToken 字段供前端接线）', async () => {
    const b = await (await fetch(`${base}/api/approvals`)).json() as { pending: Record<string, unknown>[] };
    assert.ok(Array.isArray(b.pending), 'pending 仍是数组');
    for (const item of b.pending) assert.equal(typeof item.approvalToken, 'string');
  });
});

describe('A6-3 策略注入旁路审批门', () => {
  test('通配 allow 需显式确认；具体工具名的 allow 不受影响', async () => {
    const blocked = await fetch(`${base}/api/rules/policy`, {
      method: 'PUT', headers: TOKEN_HDR, body: JSON.stringify({ scope: 'global', rules: [{ tool: '*', effect: 'allow' }] }),
    });
    assert.equal(blocked.status, 400, '{tool:"*",effect:"allow"} 不得静默写入');
    assert.match(String((await jsonOf(blocked)).error ?? ''), /审批门/);

    const ok = await fetch(`${base}/api/rules/policy`, {
      method: 'PUT', headers: TOKEN_HDR, body: JSON.stringify({ scope: 'global', rules: [{ tool: 'read_file', effect: 'allow' }] }),
    });
    assert.equal(ok.status, 200, '具体工具的 allow 属正常用法');

    const confirmed = await fetch(`${base}/api/rules/policy`, {
      method: 'PUT', headers: TOKEN_HDR, body: JSON.stringify({ scope: 'global', rules: [{ tool: '*', effect: 'allow' }], confirm: true }),
    });
    assert.equal(confirmed.status, 200, '显式 confirm:true 可放行');
    assert.equal(((await confirmed.json()) as { blanketAllow?: { tool: string }[] }).blanketAllow?.[0]?.tool, '*',
      '响应里如实回报整体放行状态');

    // 复位：别把通配 allow 留给后续用例
    const reset = await fetch(`${base}/api/rules/policy`, {
      method: 'PUT', headers: TOKEN_HDR, body: JSON.stringify({ scope: 'global', rules: [] }),
    });
    assert.equal(reset.status, 200);
  });

  test('isBlanketAllow 只把「纯通配 + allow」算作整体放行', () => {
    assert.equal(isBlanketAllow({ id: '1', tool: '*', effect: 'allow' }), true);
    assert.equal(isBlanketAllow({ id: '2', tool: '**', effect: 'allow' }), true);
    assert.equal(isBlanketAllow({ id: '3', tool: '*', effect: 'deny' }), false, 'deny 不是旁路');
    assert.equal(isBlanketAllow({ id: '4', tool: 'powershell_*', effect: 'allow' }), false, '带具体前缀不算');
  });

  test('GET /api/security 报出安全姿态且不含任何密钥材料', async () => {
    const s = await (await fetch(`${base}/api/security`)).json() as Record<string, unknown>;
    assert.equal(s.mutationAuthRequired, true);
    assert.equal(s.mutationTokenHeader, MUTATION_TOKEN_HEADER);
    assert.equal(s.approvalTokenRequired, false);
    const text = JSON.stringify(s);
    assert.equal(text.includes(TOKEN), false, '状态接口不得回显 token');
    assert.equal(text.includes('v1:'), false, '不得回显凭据密文');
    const mk = s.masterKey as { available: boolean; state: string };
    assert.equal(mk.available, true);
    assert.equal((s.credentials as { hasMasterKey: boolean }).hasMasterKey, true);
    assert.equal(typeof (s.policy as { available: boolean }).available, 'boolean');
  });
});

describe('A7 密钥存储', () => {
  const KEY_A = Buffer.from('a1'.repeat(32), 'hex');
  const KEY_B = Buffer.from('b2'.repeat(32), 'hex');

  test('解密失败不再静默：ProviderRow.keyBroken + keyStatus() 明细，重录后自动摘除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-keybroken-'));
    try {
      const s1 = new Store(join(dir, 'kb.db'), { secretKey: KEY_A });
      s1.upsertProvider({ id: 'p1', label: '甲', baseUrl: 'https://x.example', apiKey: 'sk-1', model: 'm' });
      s1.upsertProvider({ id: 'p2', label: '乙', baseUrl: 'https://y.example', apiKey: 'sk-2', model: 'm' });
      s1.close();

      // 换了主密钥：旧密文不可解 → 行级 keyBroken，状态接口给出「是谁、为什么」
      const s2 = new Store(join(dir, 'kb.db'), { secretKey: KEY_B });
      const rows = s2.listProviders();
      assert.equal(rows.find((r) => r.id === 'p1')?.keyBroken, true);
      assert.equal(rows.find((r) => r.id === 'p1')?.keyBrokenReason, 'decrypt-failed');
      assert.equal(rows.find((r) => r.id === 'p1')?.apiKey, '', '不可解时不返回垃圾值');
      const st = s2.keyStatus();
      assert.equal(st.hasMasterKey, true);
      assert.equal(st.hasCiphertext, true);
      assert.equal(st.broken.length, 2);
      assert.equal(st.broken[0]?.reason, 'decrypt-failed');

      // 重新录入密钥 → 故障标记自动摘掉，不留残余
      s2.upsertProvider({ id: 'p1', label: '甲', baseUrl: 'https://x.example', apiKey: 'sk-new', model: 'm' });
      assert.equal(s2.getProvider('p1')?.keyBroken, undefined);
      assert.equal(s2.getProvider('p1')?.apiKey, 'sk-new');
      assert.equal(s2.keyStatus().broken.length, 1, '只剩尚未重录的那个');
      s2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('无主密钥但库里有密文：标记 no-master-key（不再"看起来已配置"）+ 只读密文探测', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-nokey-'));
    try {
      const file = join(dir, 'nk.db');
      const s1 = new Store(file, { secretKey: KEY_A });
      s1.upsertProvider({ id: 'p1', label: '甲', baseUrl: 'https://x.example', apiKey: 'sk-1', model: 'm' });
      s1.close();
      assert.equal(hasEncryptedProviderKeys(file), true, '只读探测应认出 v1: 密文');
      const emptyDir = mkdtempSync(join(tmpdir(), 'mh-nodb-'));
      assert.equal(hasEncryptedProviderKeys(join(emptyDir, 'none.db')), false, '无库 = 无密文');
      rmSync(emptyDir, { recursive: true, force: true });

      const raw = new Store(file); // 不带密钥
      assert.equal(raw.getProvider('p1')?.keyBroken, true);
      assert.equal(raw.getProvider('p1')?.keyBrokenReason, 'no-master-key');
      assert.equal(raw.keyStatus().hasMasterKey, false);
      assert.equal(raw.keyStatus().hasCiphertext, true);
      raw.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('api_key 不可解时留空写入不覆盖既有密文（二次丢失防护）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-patch-'));
    try {
      const s = new Store(join(dir, 'p.db'), { secretKey: KEY_A });
      s.upsertProvider({ id: 'p1', label: '甲', baseUrl: 'https://x.example', apiKey: 'sk-keep', model: 'm' });
      s.upsertProvider({ id: 'p1', label: '甲改名', baseUrl: 'https://x.example', apiKey: '', model: 'm2' });
      assert.equal(s.getProvider('p1')?.apiKey, 'sk-keep', '空 key = 不改动');
      assert.equal(s.getProvider('p1')?.label, '甲改名', '其他字段照常更新');
      s.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('密钥文件异常 + 已有密文 → 拒绝重新生成（原字节不动）；显式授权才重建且先备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-seckey-'));
    try {
      const keyPath = join(dir, 'secret.key');
      writeFileSync(keyPath, 'abcdef-not-32-bytes', 'utf-8');
      const before = readFileSync(keyPath, 'utf-8');
      const info = resolveSecretKey(dir, { hasExistingCiphertext: () => true });
      assert.equal(info.state, 'malformed-preserved');
      assert.equal(info.key, undefined, '不该给出新密钥');
      assert.equal(readFileSync(keyPath, 'utf-8'), before, '异常文件字节必须原样保留');
      assert.match(info.message, /拒绝重新生成/);

      process.env.MAHARNESS_ALLOW_SECRET_KEY_RESET = '1';
      const forced = resolveSecretKey(dir, { hasExistingCiphertext: () => true });
      delete process.env.MAHARNESS_ALLOW_SECRET_KEY_RESET;
      assert.equal(forced.state, 'malformed-reset');
      assert.equal(forced.key?.length, 32);
      assert.ok(forced.backupPath && existsSync(forced.backupPath), '重建前必须留下原文件备份');
      assert.equal(readFileSync(forced.backupPath!, 'utf-8'), before);

      // 密钥文件缺失 + 有密文：仍生成（否则服务不可用），但状态必须说出来
      const dir2 = mkdtempSync(join(tmpdir(), 'mh-seckey2-'));
      try {
        const missing = resolveSecretKey(dir2, { hasExistingCiphertext: () => true });
        assert.equal(missing.state, 'created-with-ciphertext');
        assert.match(missing.message, /旧密文/);
        // 首启（无密钥、无密文）→ 与历史行为一致
        const dir3 = mkdtempSync(join(tmpdir(), 'mh-seckey3-'));
        try {
          const first = resolveSecretKey(dir3, { hasExistingCiphertext: () => false });
          assert.equal(first.state, 'created');
          assert.ok(first.key);
          assert.equal(isEncrypted(encryptSecret('x', first.key)), true);
        } finally { rmSync(dir3, { recursive: true, force: true }); }
      } finally { rmSync(dir2, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('hardenSecretKeyPath 失败只告警不抛（加固绝不能挡住启动）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-acl-'));
    try {
      const f = join(dir, 'secret.key');
      writeFileSync(f, 'a1'.repeat(32), 'utf-8');
      process.env.MAHARNESS_SECRET_KEY_ACL = '0';
      assert.doesNotThrow(() => hardenSecretKeyPath(f), '关闭开关时不做事');
      delete process.env.MAHARNESS_SECRET_KEY_ACL;
      // 真实路径（Windows 会尝试 icacls）同样不允许抛出
      assert.doesNotThrow(() => hardenSecretKeyPath(f), 'icacls 失败也不阻断');
      assert.equal(readFileSync(f, 'utf-8'), 'a1'.repeat(32), '加固不该改动内容');
    } finally {
      process.env.MAHARNESS_SECRET_KEY_ACL = '0';
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
