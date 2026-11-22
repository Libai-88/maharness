import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { McpOAuthClient, OAuthLoginRequiredError, type OAuthTokenData, type OAuthTokenStore } from '../oauth';
import { buildHttpHeaders, HttpConnection } from '../index';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function memoryStore(): OAuthTokenStore & { data: OAuthTokenData | null } {
  const store = {
    data: null as OAuthTokenData | null,
    load: () => store.data,
    save: (data: OAuthTokenData) => {
      store.data = data;
    },
    clear: () => {
      store.data = null;
    },
  };
  return store;
}

describe('MCP OAuth 2.1 PKCE', () => {
  test('授权 URL 带 S256 challenge，code 换 token 后可按 Bearer 调用 MCP', async (t) => {
    let expectedChallenge = '';
    let tokenCalls = 0;
    let mcpCalls = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/token') {
          tokenCalls++;
          const form = new URLSearchParams(await body(req));
          if (form.get('grant_type') === 'authorization_code') {
            assert.equal(form.get('code'), 'auth-code');
            assert.equal(form.get('client_id'), 'client-1');
            const challenge = base64url(
              createHash('sha256')
                .update(String(form.get('code_verifier')))
                .digest(),
            );
            assert.equal(challenge, expectedChallenge, 'code_verifier 必须匹配授权 URL 的 challenge');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ access_token: 'access-token-1', refresh_token: 'refresh-token-1', expires_in: 60 }));
            return;
          }
          if (form.get('grant_type') === 'refresh_token') {
            assert.ok(form.get('refresh_token'), 'refresh_token 必须存在');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ access_token: 'access-token-2', expires_in: 3600 }));
            return;
          }
          res.statusCode = 400;
          res.end('bad grant');
          return;
        }
        if (url.pathname === '/mcp') {
          mcpCalls++;
          assert.match(String(req.headers.authorization), /^Bearer .+$/, 'MCP 请求必须携带 OAuth access token');
          const rpc = JSON.parse(await body(req)) as { id?: number; method?: string };
          res.setHeader('Content-Type', 'application/json');
          if (rpc.method === 'tools/list') {
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] },
              }),
            );
          } else {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
          }
          return;
        }
        res.statusCode = 404;
        res.end();
      })().catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    let now = 1_000_000;
    const store = memoryStore();
    const client = new McpOAuthClient(
      'demo',
      {
        type: 'oauth',
        authorizationUrl: `http://127.0.0.1:${port}/authorize`,
        tokenUrl: `http://127.0.0.1:${port}/token`,
        clientId: 'client-1',
        scopes: ['mcp.read'],
        redirectUri: 'http://127.0.0.1:33418/callback',
        resource: `http://127.0.0.1:${port}/mcp`,
      },
      store,
      {},
      async () => undefined,
      () => now,
    );

    const authorization = await client.authorizationUrl();
    const url = new URL(authorization.url);
    expectedChallenge = String(url.searchParams.get('code_challenge'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), expectedChallenge);
    assert.equal(url.searchParams.get('state'), authorization.state);
    assert.equal(url.searchParams.get('scope'), 'mcp.read');
    assert.equal(client.status().state, 'authorization-pending');

    await assert.rejects(() => client.complete('auth-code', 'wrong-state'), /state/);
    const token = await client.complete('auth-code', authorization.state);
    assert.ok(token.accessToken.length > 0);
    assert.ok(store.data?.refreshToken);
    assert.equal(client.status().state, 'authorized');
    assert.equal(tokenCalls, 1);

    const conn = new HttpConnection(
      'demo',
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        allowPrivate: true,
      },
      client,
    );
    await conn.initialize();
    const tools = await conn.toolsList();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['echo'],
    );
    assert.equal(mcpCalls, 2);
    conn.close();

    now += 120_000;
    assert.ok((await client.getAccessToken()).length > 0);
    assert.equal(tokenCalls, 2, '过期后应走 refresh_token');
  });

  test('缺少 refresh token 时明确要求重新登录', async () => {
    const store = memoryStore();
    store.save({ accessToken: 'expired', expiresAt: 1, tokenUrl: 'http://127.0.0.1:1/token', clientId: 'c' });
    const client = new McpOAuthClient(
      'demo',
      {
        type: 'oauth',
        authorizationUrl: 'http://127.0.0.1:1/authorize',
        tokenUrl: 'http://127.0.0.1:1/token',
        clientId: 'c',
      },
      store,
      {},
      async () => undefined,
      () => 1_000_000,
    );
    await assert.rejects(() => client.getAccessToken(), OAuthLoginRequiredError);
  });

  test('logout 清除 token 并回到需要登录状态', async () => {
    const store = memoryStore();
    store.save({
      accessToken: 'still-valid',
      refreshToken: 'r',
      expiresAt: 9_000_000,
      tokenUrl: 'http://127.0.0.1:1/token',
      clientId: 'c',
    });
    const client = new McpOAuthClient(
      'demo',
      {
        type: 'oauth',
        authorizationUrl: 'http://127.0.0.1:1/authorize',
        tokenUrl: 'http://127.0.0.1:1/token',
        clientId: 'c',
      },
      store,
      {},
      async () => undefined,
      () => 1_000_000,
    );
    assert.equal(await client.getAccessToken(), 'still-valid');
    client.logout();
    assert.equal(store.data, null);
    await assert.rejects(() => client.getAccessToken(), OAuthLoginRequiredError);
  });

  test('OAuth 认证不写静态 Authorization 头，Bearer 行为保持不变', () => {
    assert.deepEqual(buildHttpHeaders({ auth: { type: 'oauth', authorizationUrl: 'https://a', tokenUrl: 'https://t' } }, {}), {});
    assert.equal(buildHttpHeaders({ auth: { type: 'bearer', token: 'x' } }, {}).Authorization, 'Bearer x');
  });
});
