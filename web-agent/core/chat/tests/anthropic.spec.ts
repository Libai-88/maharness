import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildBody, mapMessages, reduceEvent, createStreamState, usageChunks, imageSource } from '../anthropic';
import { createProvider } from '../provider';
import type { LLMChunk, LLMMessage } from '../../../kernel/types';
import { capabilityFor } from '../provider';
import { routeForCapability, capabilitySatisfied } from '../routing';

const sys: LLMMessage = { role: 'system', content: '你是测试助手' };
const user = (content: string, images?: string[]): LLMMessage => ({ role: 'user', content, ...(images ? { images } : {}) });
const asst = (content: string): LLMMessage => ({ role: 'assistant', content });

describe('Anthropic 请求组装', () => {
  it('system 提为顶层参数，其余按 user/assistant 交替', () => {
    const b = buildBody('claude-sonnet-4-5', [sys, user('一'), asst('二'), user('三')], {});
    assert.equal(b.system, '你是测试助手');
    assert.deepEqual(b.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(b.messages[0].content[0].text, '一');
  });

  it('连续同角色合并为一条；末条为 assistant 时补一次继续提示', () => {
    const b = buildBody('m', [sys, user('a'), user('b'), asst('c'), asst('d')], {});
    assert.deepEqual(b.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(b.messages[0].content.map(x => x.text), ['a', 'b']);
    assert.deepEqual(b.messages[1].content.map(x => x.text), ['c', 'd']);
    assert.equal(b.messages[2].content[0].text, '请继续。');
  });

  it('max_tokens 必填并带默认值；tools 转 input_schema', () => {
    const b = buildBody('m', [user('x')], {
      maxTokens: 900,
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } }, handler: async () => ({ ok: true }) }],
    });
    assert.equal(b.max_tokens, 900);
    assert.equal((b.tools ?? [])[0].name, 'read_file');
    assert.equal((b.tools ?? [])[0].input_schema.type, 'object');
    assert.equal(buildBody('m', [user('x')], {}).max_tokens, 4096);
  });

  it('data URL 图片 → base64 source；http URL → url source；非法值丢弃', () => {
    assert.deepEqual(imageSource('data:image/png;base64,AAAA'), { type: 'base64', media_type: 'image/png', data: 'AAAA' });
    assert.deepEqual(imageSource('https://x/a.jpg'), { type: 'url', url: 'https://x/a.jpg' });
    assert.equal(imageSource('javascript:alert(1)'), null);
    const b = buildBody('claude-sonnet-4-5', [user('看图', ['data:image/png;base64,AAAA'])], {});
    const blocks = b.messages[0].content;
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[1].source?.type, 'base64');
    assert.equal(blocks[1].source?.media_type, 'image/png');
  });

  it('tool 消息合并进 user 的 tool_result 块（防御性映射）', () => {
    const msgs: LLMMessage[] = [
      { role: 'assistant', content: '先读文件', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: '文件内容', tool_call_id: 'call_1' },
    ];
    const { messages } = mapMessages([sys, ...msgs]);
    const assistantBlocks = messages[0].content;
    assert.equal(assistantBlocks[0].type, 'text');
    assert.equal(assistantBlocks[1].type, 'tool_use');
    assert.equal(assistantBlocks[1].id, 'call_1');
    assert.deepEqual((assistantBlocks[1] as { input?: unknown }).input, { path: 'a.ts' });
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content[0].type, 'tool_result');
    assert.equal(messages[1].content[0].tool_use_id, 'call_1');
  });

  it('空内容消息被丢弃；末条 assistant 时补继续提示', () => {
    const { messages } = mapMessages([sys, { role: 'user', content: '' }, asst('只有回复')]);
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'user']);
    assert.equal(messages[1].content[0].text, '请继续。');
  });
});

describe('Anthropic 流事件归约', () => {
  it('text_delta / thinking_delta 分别产 delta 与 reasoning', () => {
    const st = createStreamState();
    const a = reduceEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } }, st);
    const b = reduceEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答' } }, st);
    assert.deepEqual(a, [{ type: 'reasoning', text: '想一下' }]);
    assert.deepEqual(b, [{ type: 'delta', text: '答' }]);
  });

  it('tool_use 的分片 input_json 拼成完整 arguments 后在 block_stop 产出', () => {
    const st = createStreamState();
    reduceEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'grep' } }, st);
    reduceEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pat' } }, st);
    reduceEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'tern":"x"}' } }, st);
    const out = reduceEvent({ type: 'content_block_stop', index: 1 }, st);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'tool_call');
    const tc = (out[0] as { toolCall: { id: string; function: { name: string; arguments: string } } }).toolCall;
    assert.equal(tc.id, 'tu_1');
    assert.equal(tc.function.name, 'grep');
    assert.deepEqual(JSON.parse(tc.function.arguments), { pattern: 'x' });
  });

  it('usage 分两处回报：input 在 message_start（不含缓存），output 在 message_delta', () => {
    const st = createStreamState();
    reduceEvent({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 20 } } }, st);
    reduceEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }, st);
    const u = usageChunks(st);
    assert.equal(u.input, 920, '总输入 = 未缓存 + 缓存读 + 缓存写');
    assert.equal(u.output, 42);
    assert.equal(u.cachedInput, 800);
    assert.equal(u.missInput, 120);
  });

  it('message_stop 置收尾位；error 事件记录错误供上层抛出', () => {
    const st = createStreamState();
    reduceEvent({ type: 'message_stop' }, st);
    assert.equal(st.finished, true);
    const st2 = createStreamState();
    reduceEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, st2);
    assert.match(st2.errored ?? '', /overloaded_error: Overloaded/);
  });
});

// ---------- 端到端：起一个会讲 Anthropic SSE 的 mock 端点 ----------

let server: Server | null = null;
let lastRequest: { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> } | null = null;
let sseFrames: string[] = ['data: {"type":"message_stop"}\n\n'];
let httpStatus = 200;

after(() => { server?.close(); server = null; });

async function startMock(): Promise<string> {
  if (server) {
    const a = server.address() as AddressInfo;
    return `http://127.0.0.1:${a.port}`;
  }
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
    req.on('end', () => {
      lastRequest = {
        path: String(req.url),
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
      };
      if (httpStatus !== 200) { res.writeHead(httpStatus, { 'Content-Type': 'application/json' }); res.end('{"type":"error"}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const f of sseFrames) res.write(f);
      res.end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  server.unref();
  const a = server.address() as AddressInfo;
  return `http://127.0.0.1:${a.port}`;
}

async function collect(p: ReturnType<typeof createProvider>, messages: LLMMessage[], model: string, opts = {}): Promise<LLMChunk[]> {
  const out: LLMChunk[] = [];
  for await (const c of p.chat(messages, { model, ...opts })) out.push(c);
  return out;
}

describe('Anthropic 原生端点端到端', () => {
  it('走 /v1/messages + x-api-key + anthropic-version，收齐文本/用量/done', async () => {
    const base = await startMock();
    httpStatus = 200;
    sseFrames = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":0}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，世界"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const p = createProvider({ id: 'anth', baseUrl: base, apiKey: 'sk-test', model: 'claude-sonnet-4-5', protocol: 'anthropic' });
    const chunks = await collect(p, [sys, user('在吗')], 'claude-sonnet-4-5');
    const text = chunks.filter(c => c.type === 'delta').map(c => (c as { text: string }).text).join('');
    assert.equal(text, '你好，世界');
    const usage = chunks.find(c => c.type === 'usage') as { input: number; output: number };
    assert.deepEqual([usage.input, usage.output], [11, 7]);
    assert.equal(chunks[chunks.length - 1].type, 'done');

    assert.equal(lastRequest?.path, '/v1/messages');
    assert.equal(lastRequest?.headers['x-api-key'], 'sk-test');
    assert.equal(lastRequest?.headers['anthropic-version'], '2023-06-01');
    assert.equal(lastRequest?.body.system, '你是测试助手');
    assert.equal(lastRequest?.body.max_tokens, 4096);
    assert.equal((lastRequest?.body.messages as LLMMessage[]).length, 1);
  });

  it('原生工具调用：tool_use 块转成 tool_call 供执行器接管', async () => {
    const base = await startMock();
    sseFrames = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_9","name":"glob"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"**/*.ts\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const p = createProvider({ id: 'anth', baseUrl: base, apiKey: 'k', model: 'claude-sonnet-4-5', protocol: 'anthropic' });
    const chunks = await collect(p, [sys, user('找 ts 文件')], 'claude-sonnet-4-5', {
      tools: [{ name: 'glob', description: 'd', parameters: { type: 'object', properties: {} }, handler: async () => ({ ok: true }) }],
    });
    const tc = chunks.find(c => c.type === 'tool_call') as { toolCall: { id: string; function: { name: string; arguments: string } } };
    assert.equal(tc.toolCall.id, 'tu_9');
    assert.equal(tc.toolCall.function.name, 'glob');
    assert.deepEqual(JSON.parse(tc.toolCall.function.arguments), { pattern: '**/*.ts' });
    assert.equal((lastRequest?.body.tools as unknown[]).length, 1);
  });

  it('图片经原生端点发出：messages[0].content 含 base64 image 块（视觉借道的落点）', async () => {
    const base = await startMock();
    sseFrames = ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"图里是报错弹窗"}}\n\n', 'data: {"type":"message_stop"}\n\n'];
    const p = createProvider({ id: 'anth', baseUrl: base, apiKey: 'k', model: 'claude-sonnet-4-5', protocol: 'anthropic' });
    await collect(p, [user('这张图写了什么？', ['data:image/png;base64,iVBORw0KGgo='])], 'claude-sonnet-4-5');
    const msgs = lastRequest?.body.messages as { role: string; content: { type: string; source?: { type: string } }[] }[];
    assert.equal(msgs[0].content[1].type, 'image');
    assert.equal(msgs[0].content[1].source?.type, 'base64');
  });

  it('HTTP 非 2xx 抛错含状态码与 provider 名（进 failover 链）', async () => {
    const base = await startMock();
    httpStatus = 401;
    const p = createProvider({ id: 'anth', baseUrl: base, apiKey: 'bad', model: 'm', protocol: 'anthropic' });
    await assert.rejects(() => collect(p, [user('x')], 'm'), /LLM 请求失败 \[anth\] 401/);
    httpStatus = 200;
  });

  it('流内 error 事件抛错；缺 message_stop 视为断流抛错', async () => {
    const base = await startMock();
    sseFrames = ['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n', 'data: {"type":"message_stop"}\n\n'];
    const p = createProvider({ id: 'anth', baseUrl: base, apiKey: 'k', model: 'm', protocol: 'anthropic' });
    await assert.rejects(() => collect(p, [user('x')], 'm'), /overloaded_error/);

    sseFrames = ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n'];
    await assert.rejects(() => collect(p, [user('x')], 'm'), /未收到 message_stop/);
  });

  it('OpenAI 兼容路径不受影响：仍打 /chat/completions + Bearer', async () => {
    const base = await startMock();
    httpStatus = 200;
    sseFrames = ['data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n', 'data: [DONE]\n\n'];
    const p = createProvider({ id: 'oai', baseUrl: base, apiKey: 'sk-x', model: 'gpt-4o', protocol: 'openai' });
    const chunks = await collect(p, [sys, user('hi')], 'gpt-4o');
    assert.equal(chunks.filter(c => c.type === 'delta').length, 1);
    assert.equal(lastRequest?.path, '/chat/completions');
    assert.equal(lastRequest?.headers.authorization, 'Bearer sk-x');
  });
});

describe('Anthropic 模型参与能力路由（视觉借道再回切）', () => {
  const textOnly = { id: 'deepseek', label: 'D', defaultModel: 'deepseek-chat', protocol: 'openai', models: [], prices: { in: 0.3, out: 1.2 }, chat: async function* () {} };
  const claude = {
    id: 'anth', label: 'A', defaultModel: 'claude-sonnet-4-5', protocol: 'anthropic',
    models: [{ modelId: 'claude-sonnet-4-5', contextWindow: 200_000, maxOutput: 8192, vision: true, tools: true, reasoning: false, priceIn: 3, priceOut: 15, enabled: true, source: 'pulled' }],
    prices: { in: 3, out: 15 }, chat: async function* () {},
  };

  it('Anthropic provider 的视觉模型可被选中借道', () => {
    assert.equal(capabilitySatisfied({ vision: true }, textOnly, 'deepseek-chat'), false);
    const r = routeForCapability({ vision: true }, [textOnly, claude], { providerId: 'deepseek', model: 'deepseek-chat' });
    assert.equal(r?.provider.id, 'anth');
    assert.equal(r?.model, 'claude-sonnet-4-5');
  });

  it('借道结束回切原模型：路由不改写 session 模型，current 保持不变', () => {
    const r = routeForCapability({ vision: true }, [textOnly, claude], { providerId: 'deepseek', model: 'deepseek-chat' });
    assert.equal(r?.provider.id, 'anth');
    assert.notEqual(r?.model, 'deepseek-chat', '借道目标是别人的模型');
    assert.equal(capabilityFor(claude, 'claude-sonnet-4-5')?.vision, true);
  });

  it('未登记能力的 Anthropic 模型走目录推断兜底', () => {
    const bare = { ...claude, models: [] };
    assert.equal(capabilityFor(bare, 'claude-3-5-sonnet-latest')?.vision, true);
  });
});

