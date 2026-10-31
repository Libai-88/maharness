/**
 * core/mcp/tests/security.spec.ts —— MCP 客户端安全边界回归测试（缺陷清单 A4）
 * 覆盖四点：
 *  1. spawn env 默认最小透传（不再把 *_API_KEY / *_PROXY / AGENT_* / 连接串交给外部 MCP
 *     server），仅 cfg.inheritEnv===true 时全量透传（向后兼容逃生口）；
 *  2. wrapMcpTool 默认产出 approval===true（内核唯一门是 approval/assessApproval，
 *     risk 标签不是防护），cfg.approval:false 才关闭；
 *  3. win32 close() 用 taskkill /T /F 回收 npx 的孙进程（参数表驱动，不真实 spawn）；
 *  4. http 传输的 URL 协议/私网校验 + 协议版本单一常量。
 * 全部为纯函数断言：不联网、不打真实 DNS、不 spawn 任何外部包。
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildSpawnEnv,
  buildSpawnPlan,
  assessApprovalGate,
  taskkillArgs,
  assertSafeMcpUrl,
  isPrivateHostAddress,
  wrapMcpTool,
  MCP_PROTOCOL_VERSION,
  StdioConnection,
  HttpConnection,
  type ServerCfg,
} from '../index';

const MCP_FIXTURE = [
  "let cancelled=false;",
  "const readline=require('node:readline');",
  "const rl=readline.createInterface({input:process.stdin});",
  "rl.on('line',line=>{ const m=JSON.parse(line);",
  "if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-07-28'}})+'\\n');",
  "else if(m.method==='tools/call' && m.params.name==='fast') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:cancelled?'cancel-seen':'cancel-missing'}]}})+'\\n');",
  "else if(m.method==='$/cancelRequest') cancelled=true;",
  "});",
].join('');

/** 模拟宿主进程环境：含密钥/代理/内核配置 + Windows 运行必需项（故意混排大小写，如 Path/PATHEXT） */
const FAKE_PARENT_ENV: Record<string, string> = {
  Path: 'C:\\nodejs;C:\\Windows\\system32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\tester',
  HOME: '/home/tester',
  TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  // —— 以下均属"不该透传给外部 MCP server"的敏感/内部变量 ——
  TAVILY_API_KEY: 'tvly-secret',
  OPENAI_API_KEY: 'sk-secret',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  GOOGLE_API_KEY: 'google-secret',
  SEARCH_PROXY: 'http://127.0.0.1:7890',
  HTTPS_PROXY: 'http://127.0.0.1:7890',
  AGENT_ALLOW_PRIVATE_URLS: '1',
  AGENT_DATA_DIR: 'D:\\data',
  DATABASE_URL: 'postgres://user:pw@internal/db',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
};

const parentKeys = () => Object.keys(FAKE_PARENT_ENV);

describe('A4-1 stdio spawn env：默认最小透传', () => {
  it('默认不透传任何 *_API_KEY / 代理 / AGENT_* / 连接串', () => {
    const env = buildSpawnEnv({ type: 'stdio', command: 'npx' }, FAKE_PARENT_ENV);
    const leaked = Object.keys(env).filter(
      (k) => /_API_KEY$|^API_KEY$/i.test(k)
        || /_PROXY$/i.test(k)
        || /^AGENT_/i.test(k)
        || /^(AWS_SECRET|DATABASE_URL|SECRET|TOKEN)/i.test(k),
    );
    assert.deepEqual(leaked, [], `env 泄漏敏感变量: ${leaked.join(', ')}`);
    assert.equal(env.TAVILY_API_KEY, undefined);
    assert.equal(env.SEARCH_PROXY, undefined);
    assert.equal(env.AGENT_ALLOW_PRIVATE_URLS, undefined);
    assert.equal(env.DATABASE_URL, undefined);
  });

  it('默认仍透传运行必需项（大小写不敏感）——Windows 上 npx 靠 PATH+PATHEXT 解析', () => {
    const env = buildSpawnEnv({ type: 'stdio', command: 'npx' }, FAKE_PARENT_ENV);
    const lowered = new Set(Object.keys(env).map((k) => k.toLowerCase()));
    for (const need of ['path', 'pathext', 'systemroot', 'windir', 'comspec', 'userprofile',
      'home', 'temp', 'tmp', 'lang', 'lc_all']) {
      assert.ok(lowered.has(need), `缺少运行必需 env: ${need}`);
    }
    // 保留父进程原始键名大小写（Windows 子进程按原键名读取）
    assert.equal(env.Path, FAKE_PARENT_ENV.Path);
    assert.equal(env.PATHEXT, FAKE_PARENT_ENV.PATHEXT);
    assert.equal(env.SystemRoot, 'C:\\Windows');
  });

  it('cfg.env 显式声明的凭据一定透传（给 server 传密钥的唯一正道）', () => {
    const cfg: ServerCfg = { type: 'stdio', command: 'node', env: { GITHUB_TOKEN: 'ghp_x', TAVILY_API_KEY: 'tvly-secret' } };
    const env = buildSpawnEnv(cfg, FAKE_PARENT_ENV);
    assert.equal(env.GITHUB_TOKEN, 'ghp_x');
    assert.equal(env.TAVILY_API_KEY, 'tvly-secret');
  });

  it('cfg.inheritEnv === true → 全量透传（旧行为，向后兼容逃生口）', () => {
    const env = buildSpawnEnv({ type: 'stdio', command: 'node', inheritEnv: true }, FAKE_PARENT_ENV);
    assert.equal(env.TAVILY_API_KEY, 'tvly-secret');
    assert.equal(env.OPENAI_API_KEY, 'sk-secret');
    assert.equal(env.SEARCH_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.AGENT_ALLOW_PRIVATE_URLS, '1');
    assert.equal(Object.keys(env).length, parentKeys().length, 'inheritEnv 应等价于原行为（全量）');
  });

  it('inheritEnv 下 cfg.env 覆盖父进程同名变量', () => {
    const cfg: ServerCfg = { type: 'stdio', command: 'node', inheritEnv: true, env: { LANG: 'zh_CN.UTF-8' } };
    assert.equal(buildSpawnEnv(cfg, FAKE_PARENT_ENV).LANG, 'zh_CN.UTF-8');
  });
});

describe('A4-2 审批门：默认需要审批', () => {
  const conn = {
    initialize: async () => {},
    toolsList: async () => [],
    toolsCall: async () => ({}),
    close: () => {},
  };
  const mt = { name: 'read_file' };

  it('wrapMcpTool 默认（不写 approval）产出 approval === true', () => {
    const tool = wrapMcpTool('fs', mt, conn, { type: 'stdio', command: 'npx' });
    assert.equal(tool.approval, true, '外部 MCP 工具必须默认要求审批');
    const gate = assessApprovalGate({}, 'fs/read_file');
    assert.equal(gate.needsApproval, true);
    assert.match(gate.reason, /默认/);
  });

  it('cfg.approval: false → approval 为 false（显式关闭，写明风险）', () => {
    const tool = wrapMcpTool('fs', mt, conn, { type: 'stdio', command: 'npx', approval: false });
    assert.equal(tool.approval, false);
    assert.match(String(tool.limits), /关闭审批|approval:false/);
  });

  it('cfg.approval: true 与未设置同义（都是要求审批）', () => {
    assert.equal(wrapMcpTool('fs', mt, conn, { type: 'http', url: 'https://x.example/mcp', approval: true }).approval, true);
    assert.equal(assessApprovalGate({ approval: undefined }).approval, true);
  });

  it('risk 标签不当作防护：默认审批与 risk 无关（恒 medium 仍需审批）', () => {
    const tool = wrapMcpTool('fs', mt, conn, { type: 'stdio', command: 'npx' });
    assert.equal(tool.risk, 'medium');
    assert.equal(tool.approval, true);
  });
});

describe('A4-3 win32 孙进程回收：taskkill /T /F 参数', () => {
  it('win32 + 有 pid → /PID <pid> /T /F（杀整棵进程树）', () => {
    assert.deepEqual(taskkillArgs('win32', 4321), ['/PID', '4321', '/T', '/F']);
  });
  it('无 pid / 非 win32 → null（维持 proc.kill 现状，不 spawn taskkill）', () => {
    assert.equal(taskkillArgs('win32', undefined), null);
    assert.equal(taskkillArgs('win32', 0), null);
    assert.equal(taskkillArgs('linux', 4321), null);
    assert.equal(taskkillArgs('darwin', 4321), null);
  });
});

describe('A4-4 http 传输 URL 校验（与 search/providers 防护对齐）', () => {
  /** 显式传 allowPrivate:false —— 避免宿主 AGENT_ALLOW_PRIVATE_URLS 干扰判定 */
  const reject = async (raw: string, pattern: RegExp) => {
    await assert.rejects(() => assertSafeMcpUrl(raw, { allowPrivate: false }), pattern, `${raw} 应被拒绝`);
  };

  it('拒绝 http/https 之外的协议（file:// 等）与非法格式', async () => {
    await reject('file:///C:/Windows/win.ini', /仅支持 http\/https/);
    await reject('ftp://example.com/mcp', /仅支持 http\/https/);
    await reject('not-a-url', /地址格式无效/);
  });

  it('拒绝回环/私网/链路本地 IP 字面量（含 IPv4-mapped 十六进制形式）', async () => {
    await reject('http://127.0.0.1:3000/mcp', /内网|回环/);
    await reject('http://[::ffff:7f00:1]:3000/mcp', /内网|回环/); // WHATWG 规范化后的 127.0.0.1
    await reject('http://[::ffff:127.0.0.1]:3000/mcp', /内网|回环/);
    await reject('http://[::ffff:c0a8:1]:8080/mcp', /内网|回环/);  // 192.168.0.1
    await reject('http://[::ffff:a9fe:a9fe]:80/mcp', /内网|回环/); // 169.254.169.254 云 metadata
    await reject('http://[::1]:8080/mcp', /内网|回环/);
    await reject('http://[::]:8080/mcp', /内网|回环/);
    await reject('http://10.1.2.3:9000/mcp', /内网|回环/);
    await reject('http://192.168.1.10/mcp', /内网|回环/);
    await reject('http://172.16.0.1/mcp', /内网|回环/);
    await reject('http://100.64.0.1/mcp', /内网|回环/);            // CGNAT/Tailscale
    await reject('http://198.18.0.1/mcp', /内网|回环/);            // 基准测试段
    await reject('http://0.0.0.0/mcp', /内网|回环/);
    await reject('http://[fe80::1]/mcp', /内网|回环/);
    await reject('http://[fc00::1]/mcp', /内网|回环/);
  });

  it('拒绝本机/内网主机名', async () => {
    await reject('http://localhost:8080/mcp', /内网主机名/);
    await reject('http://mcp.internal/mcp', /内网主机名/);
    await reject('http://srv.local:9000/mcp', /内网主机名/);
  });

  it('公网主机名：DNS 交由注入的 resolve（不联网），公网通过、解析到内网拒绝', async () => {
    const seen: string[] = [];
    const u = await assertSafeMcpUrl('https://mcp.example.com/mcp', {
      allowPrivate: false,
      resolve: async (host) => { seen.push(host); return ['93.184.216.34']; },
    });
    assert.equal(u.hostname, 'mcp.example.com');
    assert.deepEqual(seen, ['mcp.example.com'], '应调用注入的解析器而非真实 DNS');

    await assert.rejects(
      () => assertSafeMcpUrl('https://evil.example.com/mcp', { allowPrivate: false, resolve: async () => ['10.0.0.5'] }),
      /SSRF|内网/,
    );
    await assert.rejects(
      () => assertSafeMcpUrl('https://gone.example.com/mcp', { allowPrivate: false, resolve: async () => [] }),
      /无法解析/,
    );
  });

  it('逃生口：AGENT_ALLOW_PRIVATE_URLS=1 或 cfg.allowPrivate 放行本机端点', async () => {
    const prev = process.env.AGENT_ALLOW_PRIVATE_URLS;
    process.env.AGENT_ALLOW_PRIVATE_URLS = '1';
    try {
      const u = await assertSafeMcpUrl('http://127.0.0.1:8080/mcp');
      assert.equal(u.hostname, '127.0.0.1');
    } finally {
      if (prev === undefined) delete process.env.AGENT_ALLOW_PRIVATE_URLS;
      else process.env.AGENT_ALLOW_PRIVATE_URLS = prev;
    }
    const perServer = await assertSafeMcpUrl('http://127.0.0.1:8080/mcp', { allowPrivate: true });
    assert.equal(perServer.protocol, 'http:');
  });

  it('isPrivateHostAddress 表驱动（覆盖 A3 同族的十六进制映射绕过与保留段）', () => {
    const cases: [string, boolean][] = [
      ['127.0.0.1', true], ['7f00:1', true], ['::ffff:7f00:1', true], ['::ffff:127.0.0.1', true],
      ['a9fe:a9fe', true], ['169.254.169.254', true], ['100.64.0.1', true], ['100.127.255.255', true],
      ['100.128.0.0', false], ['198.18.0.1', true], ['192.0.0.1', true], ['192.0.2.1', false],
      ['8.8.8.8', false], ['::1', true], ['::', true], ['fe80::1', true], ['fec0::1', true],
      ['2001:4860:4860::8888', false], ['2002:7f00:1::1', true], ['[::ffff:7f00:1]', true],
      ['garbage', true],
    ];
    for (const [addr, priv] of cases) {
      assert.equal(isPrivateHostAddress(addr), priv, `isPrivateHostAddress(${addr}) 应为 ${priv}`);
    }
  });

  it('协议版本单一常量：stdio 与 http 共用 2026-07-28', () => {
    assert.equal(MCP_PROTOCOL_VERSION, '2026-07-28');
  });
});

describe('LR-05 MCP 取消传播与 pending 回收', () => {
  it('取消发送 $/cancelRequest，释放 pending，连接可继续调用', async () => {
    const conn = new StdioConnection('fixture', {
      type: 'stdio', command: process.execPath, args: ['-e', MCP_FIXTURE],
    });
    await conn.initialize();
    const controller = new AbortController();
    const cancelled = conn.toolsCall('slow', {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /请求已取消/);
    const result = await conn.toolsCall('fast', {});
    assert.equal(result.content?.[0]?.text, 'cancel-seen', '后续调用应观察到服务端已收到取消通知');
    conn.close();
  });

  it('HTTP MCP 调用取消后关闭底层请求连接', async () => {
    let closed = false;
    const server = createServer((_req, res) => {
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"jsonrpc":"2.0","id":3,"result":{"content":[');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const conn = new HttpConnection('fixture-http', {
      type: 'http', url: `http://127.0.0.1:${port}/mcp`, allowPrivate: true,
    });
    const controller = new AbortController();
    try {
      const pending = conn.toolsCall('slow', {}, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      await assert.rejects(pending, /abort|取消|停止/i);
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, true, '取消后服务端应观察到 HTTP 请求关闭');
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

/** B18 回归：Windows 上 npx/npm 是 .cmd 垫片，Node 禁止无 shell 启动（CVE-2024-27980）
 *  实测 spawn('npx') → ENOENT、spawn('npx.cmd') → EINVAL，
 *  于是 config.example.json 推荐的 MCP filesystem server 在 Windows 上根本起不来。 */
describe('stdio 启动计划（B18：Windows .cmd 垫片必须经 cmd.exe）', () => {
  test('win32 + 裸 npx → 经 shell，命令行由我们组装', () => {
    const p = buildSpawnPlan('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\My Files'], 'win32');
    assert.equal(p.shell, true);
    assert.deepEqual(p.args, [], '参数不得再交给 Node 拼接（引号规则要可控）');
    assert.equal(p.file, 'npx -y @modelcontextprotocol/server-filesystem "D:\\My Files"',
      '含空格的路径参数整体加引号，其余保持原样');
  });

  test('win32 + .exe → 保持直接 spawn（不绕 shell）', () => {
    const p = buildSpawnPlan('python.exe', ['-m', 'x'], 'win32');
    assert.equal(p.shell, false);
    assert.equal(p.file, 'python.exe');
    assert.deepEqual(p.args, ['-m', 'x']);
  });

  test('非 win32 一律直接 spawn（行为不变）', () => {
    const p = buildSpawnPlan('npx', ['-y', 'x'], 'linux');
    assert.equal(p.shell, false);
    assert.equal(p.file, 'npx');
    assert.deepEqual(p.args, ['-y', 'x']);
  });

  test('含命令分隔符的参数被引号包住，不被 cmd.exe 当管道/分隔', () => {
    const p = buildSpawnPlan('npx', ['a&b', 'c|d'], 'win32');
    assert.match(p.file, /"a&b" "c\|d"/);
  });
});
