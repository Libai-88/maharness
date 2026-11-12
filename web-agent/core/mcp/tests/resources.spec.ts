import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpConnection } from '../index';

describe('MCP resources / prompts', () => {
  test('列表分页跟随 nextCursor 直到末页', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        const msg = JSON.parse(body) as { id: number; method: string; params?: { cursor?: string } };
        const result = msg.method === 'resources/list'
          ? msg.params?.cursor === 'page-2'
            ? { resources: [{ uri: 'docs://b', name: 'B' }] }
            : { resources: [{ uri: 'docs://a', name: 'A' }], nextCursor: 'page-2' }
          : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const conn = new HttpConnection('paging', { type: 'http', url: `http://127.0.0.1:${port}/mcp`, allowPrivate: true });
    try {
      assert.deepEqual((await conn.resourcesList()).map((r) => r.uri), ['docs://a', 'docs://b']);
    } finally {
      conn.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('HTTP 连接可发现并读取资源和 prompt 模板', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        const msg = JSON.parse(body) as { id: number; method: string; params?: { uri?: string; name?: string } };
        const result = msg.method === 'resources/list'
          ? { resources: [{ uri: 'docs://readme', name: 'README', mimeType: 'text/markdown' }] }
          : msg.method === 'resources/read'
            ? { contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: 'resource body' }] }
            : msg.method === 'prompts/list'
              ? { prompts: [{ name: 'review', description: 'Review helper' }] }
              : msg.method === 'prompts/get'
                ? { description: 'Review helper', messages: [{ role: 'user', content: { type: 'text', text: `review ${msg.params?.name}` } }] }
                : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const conn = new HttpConnection('fixture', { type: 'http', url: `http://127.0.0.1:${port}/mcp`, allowPrivate: true });
    try {
      assert.deepEqual((await conn.resourcesList()).map((r) => r.uri), ['docs://readme']);
      assert.equal((await conn.resourcesRead('docs://readme'))[0]?.text, 'resource body');
      assert.deepEqual((await conn.promptsList()).map((p) => p.name), ['review']);
      const prompt = await conn.promptsGet('review', {});
      assert.match(String(prompt.messages?.[0]?.content?.text), /review/);
    } finally {
      conn.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('HTTP 401 时 refresh-token 换新并只重试一次', async () => {
    let tokenCalls = 0;
    let mcpCalls = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        if (req.url === '/token') {
          tokenCalls++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'fresh' }));
          return;
        }
        mcpCalls++;
        if (req.headers.authorization !== 'Bearer fresh') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        const msg = JSON.parse(body) as { id: number };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.MCP_TEST_REFRESH = 'refresh-secret';
    const conn = new HttpConnection('auth', {
      type: 'http', url: `http://127.0.0.1:${port}/mcp`, allowPrivate: true,
      auth: {
        type: 'bearer', token: 'stale',
        refresh: { tokenUrl: `http://127.0.0.1:${port}/token`, refreshTokenEnv: 'MCP_TEST_REFRESH' },
      },
    });
    try {
      assert.equal((await conn.toolsCall('echo', {})).content?.[0]?.text, 'ok');
      assert.equal(tokenCalls, 1);
      assert.equal(mcpCalls, 2);
    } finally {
      delete process.env.MCP_TEST_REFRESH;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
