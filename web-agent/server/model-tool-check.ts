import { createHash, randomUUID } from 'node:crypto';
import type { ProviderRow } from './db';

export function modelCheckFingerprint(provider: Pick<ProviderRow, 'baseUrl' | 'protocol' | 'apiKey'>): string {
  return createHash('sha256')
    .update(JSON.stringify([provider.baseUrl, provider.protocol, provider.apiKey]))
    .digest('hex');
}

/** A harmless native tool call confirms observed behavior, not every model capability. */
export function buildModelToolCheck(baseUrl: string, protocol: string, apiKey: string, model: string) {
  const nonce = randomUUID();
  const name = 'confirm_tool_support';
  const parameters = {
    type: 'object',
    properties: { nonce: { type: 'string', enum: [nonce] } },
    required: ['nonce'],
    additionalProperties: false,
  };
  const description = 'Return the supplied nonce without performing any operation.';
  const messages = [{ role: 'user', content: `Call ${name} with nonce ${nonce}. Do not answer in text.` }];
  const base = baseUrl.replace(/\/+$/, '');
  const url =
    protocol === 'anthropic'
      ? `${base.replace(/\/v1$/, '')}/v1/messages`
      : protocol === 'ollama'
        ? `${base.replace(/\/api$/, '')}/api/chat`
        : base.endsWith('/chat/completions')
          ? base
          : `${base}/chat/completions`;
  const body =
    protocol === 'anthropic'
      ? { model, max_tokens: 256, messages, tools: [{ name, description, input_schema: parameters }], tool_choice: { type: 'tool', name } }
      : {
          model,
          stream: false,
          messages,
          tools: [{ type: 'function', function: { name, description, parameters } }],
          ...(protocol === 'ollama'
            ? { options: { num_predict: 256 } }
            : { max_tokens: 256, tool_choice: { type: 'function', function: { name } } }),
        };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const confirm = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const response = value as {
      content?: { type?: string; name?: string; input?: unknown }[];
      message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
      choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }[];
    };
    const calls =
      protocol === 'anthropic'
        ? (response.content ?? []).filter((item) => item.type === 'tool_use').map((item) => ({ name: item.name, args: item.input }))
        : (protocol === 'ollama' ? (response.message?.tool_calls ?? []) : (response.choices?.[0]?.message?.tool_calls ?? [])).map(
            (item) => ({ name: item.function?.name, args: item.function?.arguments }),
          );
    return calls.some((call) => {
      try {
        const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
        return call.name === name && args && typeof args === 'object' && args.nonce === nonce;
      } catch {
        return false;
      }
    });
  };
  return {
    url,
    init: { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) } satisfies RequestInit,
    confirm,
  };
}
