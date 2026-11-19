import type { ToolDef, ToolResult } from '../../kernel/plugin-sdk';

export interface McpServerOptions {
  tools: ToolDef[];
  allowlist: ReadonlySet<string>;
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
  version?: string;
}

export interface McpRpcResponse {
  status: number;
  body: unknown | null;
}

function ok(id: unknown, result: unknown): McpRpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function error(id: unknown, code: number, message: string): McpRpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export async function handleMcpRpc(body: unknown, opts: McpServerOptions): Promise<McpRpcResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return error(null, -32600, 'Invalid Request');
  }
  const request = body as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (id === undefined) return { status: 204, body: null };
  if (!method) return error(id, -32600, 'Invalid Request');

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'maharness', version: opts.version ?? '0.1.0' },
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    const tools = opts.tools
      .filter((tool) => opts.allowlist.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }));
    return ok(id, { tools });
  }
  if (method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as { name?: unknown; arguments?: unknown }
      : {};
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name || !opts.allowlist.has(name)) return error(id, -32602, `Tool 不允许调用: ${name || '(empty)'}`);
    try {
      const result = await opts.invoke(name, params.arguments ?? {});
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: result.ok !== true,
      });
    } catch (err) {
      return ok(id, {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      });
    }
  }
  return error(id, -32601, `Method not found: ${method}`);
}
