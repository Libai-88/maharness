import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRpc } from '../server';
import type { ToolDef } from '../../../kernel/types';

const tools: ToolDef[] = [{
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (args) => ({ ok: true, data: args }),
}];

describe('MCP server JSON-RPC', () => {
  it('initialize 返回协议与 serverInfo', async () => {
    const response = await handleMcpRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, {
      tools, allowlist: new Set(['echo']), invoke: async () => ({ ok: true }),
    });
    assert.equal(response.status, 200);
    const body = response.body as any;
    assert.equal(body.result.serverInfo.name, 'maharness');
    assert.equal(body.result.capabilities.tools.listChanged, false);
  });

  it('tools/list 只暴露 allowlist 内工具', async () => {
    const response = await handleMcpRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      tools, allowlist: new Set(['echo']), invoke: async () => ({ ok: true }),
    });
    const body = response.body as any;
    assert.equal(body.result.tools.length, 1);
    assert.equal(body.result.tools[0].name, 'echo');
    assert.deepEqual(body.result.tools[0].inputSchema, tools[0]!.parameters);
  });

  it('tools/call 调用 allowlist 内工具并返回 MCP content', async () => {
    const response = await handleMcpRpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    }, {
      tools,
      allowlist: new Set(['echo']),
      invoke: async (_name, args) => tools[0]!.handler(args, {} as never),
    });
    const body = response.body as any;
    assert.equal(body.result.isError, false);
    assert.match(body.result.content[0].text, /"hi"/);
  });

  it('拒绝 allowlist 外的工具与未知方法', async () => {
    const denied = await handleMcpRpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} },
    }, { tools, allowlist: new Set(['echo']), invoke: async () => ({ ok: true }) });
    assert.equal((denied.body as any).error.code, -32602);

    const unknown = await handleMcpRpc({ jsonrpc: '2.0', id: 5, method: 'unknown' }, {
      tools, allowlist: new Set(['echo']), invoke: async () => ({ ok: true }),
    });
    assert.equal((unknown.body as any).error.code, -32601);
  });

  it('notification 不返回响应体', async () => {
    const response = await handleMcpRpc({ jsonrpc: '2.0', method: 'ping' }, {
      tools, allowlist: new Set(['echo']), invoke: async () => ({ ok: true }),
    });
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });
});
