import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchRegistryServers, normalizeRegistryServer, registryInstallCandidate } from '../registry';

describe('MCP registry 发现与安装候选', () => {
  test('兼容 server 包裹层并只保留可验证字段', () => {
    const entry = normalizeRegistryServer({
      server: {
        name: 'io.example/files',
        title: 'Files',
        description: 'file tools',
        version: '1.2.3',
        packages: [{ registryType: 'npm', identifier: '@example/files-mcp', version: '1.2.3', transport: { type: 'stdio' } }],
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
        env: { SECRET: 'x' },
      },
    });
    assert.ok(entry);
    assert.equal(entry.name, 'io.example/files');
    assert.equal(entry.packages?.[0]?.identifier, '@example/files-mcp');
    assert.equal(entry.remotes?.[0]?.url, 'https://mcp.example.com/mcp');
  });

  test('npm stdio 与 https remote 生成受控配置，拒绝不安全形态', () => {
    const npm = registryInstallCandidate({
      name: 'npm-server',
      packages: [{ registryType: 'npm', identifier: '@scope/pkg', version: '1.0.0', transport: { type: 'stdio' } }],
    })!;
    assert.equal(npm.transport, 'stdio');
    assert.deepEqual(npm.cfg.args, ['-y', '@scope/pkg@1.0.0']);
    assert.equal(npm.cfg.approval, true);

    const remote = registryInstallCandidate({
      name: 'remote-server',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    })!;
    assert.equal(remote.transport, 'http');
    assert.equal(remote.cfg.url, 'https://mcp.example.com/mcp');

    assert.equal(
      registryInstallCandidate({
        name: 'bad-npm',
        packages: [{ registryType: 'npm', identifier: '../../evil' }],
      }),
      null,
    );
    assert.equal(
      registryInstallCandidate({
        name: 'bad-remote',
        remotes: [{ type: 'streamable-http', url: 'http://mcp.example.com/mcp' }],
      }),
      null,
    );
  });

  test('registry 搜索带 search/limit 并解析返回列表', async (t) => {
    let seen = '';
    const server = createServer((req, res) => {
      seen = String(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ servers: [{ server: { name: 'io.example/demo', description: 'demo' } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const list = await fetchRegistryServers({
      baseUrl: `http://127.0.0.1:${port}`,
      query: 'demo',
      limit: 5,
    });
    assert.equal(list[0]?.name, 'io.example/demo');
    const url = new URL(seen, 'http://127.0.0.1');
    assert.equal(url.pathname, '/v0/servers');
    assert.equal(url.searchParams.get('search'), 'demo');
    assert.equal(url.searchParams.get('limit'), '5');
  });
});
