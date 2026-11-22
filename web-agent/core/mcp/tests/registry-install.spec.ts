import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../../kernel/index';
import type { ToolContext } from '../../../kernel/types';

function json(res: import('node:http').ServerResponse, value: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

describe('MCP registry 安装链路', () => {
  test('从 registry 条目生成受控配置、写入并立即连接 tools/list', async (t) => {
    const mcp = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
        if (rpc.method === 'tools/list') {
          json(res, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
        } else {
          json(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        }
      })();
    });
    await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
    const mcpPort = (mcp.address() as { port: number }).port;

    const registry = createServer((_req, res) => {
      json(res, {
        servers: [
          {
            server: {
              name: 'io.example/demo',
              title: 'Demo',
              version: '1.0.0',
              remotes: [{ type: 'streamable-http', url: `http://127.0.0.1:${mcpPort}/mcp` }],
            },
          },
        ],
      });
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const registryPort = (registry.address() as { port: number }).port;

    const root = mkdtempSync(join(tmpdir(), 'mh-registry-install-'));
    const userPluginsDir = join(root, 'plugins');
    mkdirSync(userPluginsDir, { recursive: true });
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        mcp: {
          servers: {},
          registry: { url: `http://127.0.0.1:${registryPort}`, allowPrivate: true },
        },
      }),
    );
    const webAgentRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const kernel = new Kernel(
      root,
      {},
      {
        dataDir: join(root, 'data'),
        userPluginsDir,
        corePluginsDir: join(webAgentRoot, 'core'),
      },
    );
    t.after(async () => {
      try {
        await kernel.stop();
      } catch {
        /* 已停止 */
      }
      await new Promise<void>((resolve) => mcp.close(() => resolve()));
      await new Promise<void>((resolve) => registry.close(() => resolve()));
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows 句柄迟释放 */
      }
    });

    await kernel.plugins.loadAll();
    const mcpPlugin = kernel.plugins.get('mcp');
    assert.equal(mcpPlugin?.state, 'started', `mcp 插件应启动: ${mcpPlugin?.error ?? ''}`);
    const install = kernel.plugins.capabilities('tool').find((cap) => cap.tool.name === 'mcp_registry_install')?.tool;
    assert.ok(install, 'mcp_registry_install 应可用');
    const result = (await install.handler({ name: 'io.example/demo', server: 'demo' }, {
      turn: 0,
      sandboxRoot: root,
      cache: kernel.cache,
      trace: kernel.trace,
    } as ToolContext)) as { ok: boolean; data?: { server?: string; tools?: number }; error?: string };
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data?.server, 'demo');
    assert.equal(result.data?.tools, 1);
    assert.ok(
      kernel.plugins.capabilities('tool').some((cap) => cap.tool.name === 'mcp_demo_echo'),
      '安装后 MCP 工具应注册',
    );
  });
});
