import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StdioConnection, normalizeSamplingParams } from '../index';

const FIXTURE = [
  "const readline=require('node:readline');",
  "const rl=readline.createInterface({input:process.stdin});",
  "let capabilities=null, sampling=null, roots=null;",
  "rl.on('line',line=>{ const m=JSON.parse(line);",
  "if(m.method==='initialize'){ capabilities=m.params.capabilities;",
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-07-28'}})+'\\n');",
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'sampling/createMessage',params:{messages:[{role:'user',content:{type:'text',text:'hello'}}],maxTokens:16}})+'\\n');",
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:100,method:'roots/list',params:{}})+'\\n'); }",
  "else if(m.id===99) sampling=m.result??m.error;",
  "else if(m.id===100) roots=m.result??m.error;",
  "else if(m.method==='tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({capabilities,sampling,roots})}]}})+'\\n');",
  "});",
].join('');

describe('MCP sampling / roots', () => {
  test('normalizeSamplingParams 只接受文本消息', () => {
    const normalized = normalizeSamplingParams({
      systemPrompt: 'be brief',
      messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
      maxTokens: 99999,
      temperature: 5,
    });
    assert.equal(normalized.messages[0].role, 'system');
    assert.equal(normalized.messages[1].content, 'hello');
    assert.equal(normalized.maxTokens, 8192);
    assert.equal(normalized.temperature, 2);
    assert.throws(() => normalizeSamplingParams({
      messages: [{ role: 'user', content: { type: 'image', data: 'x' } }],
    }), /只支持文本/);
    assert.throws(() => normalizeSamplingParams({ messages: [] }), /缺少 user/);
  });

  test('stdio 连接响应 server 的 sampling/createMessage 与 roots/list', async (t) => {
    const conn = new StdioConnection('sampling', {
      type: 'stdio', command: process.execPath, args: ['-e', FIXTURE],
    });
    conn.samplingHandler = async (_params) => ({
      role: 'assistant',
      content: { type: 'text', text: 'sampled answer' },
      model: 'fixture-model',
    });
    conn.rootsProvider = () => [{ uri: 'file:///workspace', name: 'workspace' }];
    t.after(() => conn.close());
    await conn.initialize();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await conn.toolsCall('echo', {});
    const payload = JSON.parse(String(result.content?.[0]?.text)) as {
      capabilities: { sampling?: unknown; roots?: unknown };
      sampling: { content: { text: string }; model: string };
      roots: { roots: { uri: string }[] };
    };
    assert.ok(payload.capabilities.sampling);
    assert.ok(payload.capabilities.roots);
    assert.equal(payload.sampling.content.text, 'sampled answer');
    assert.equal(payload.sampling.model, 'fixture-model');
    assert.deepEqual(payload.roots.roots, [{ uri: 'file:///workspace', name: 'workspace' }]);
  });
});
