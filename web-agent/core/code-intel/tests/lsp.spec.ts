import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspClient, pickLspServer } from '../lsp';

const MOCK_LSP = `
let buf = Buffer.alloc(0);
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const at = buf.indexOf('\\r\\n\\r\\n');
    if (at < 0) return;
    const head = buf.slice(0, at).toString('ascii');
    const m = /Content-Length:\\s*(\\d+)/i.exec(head);
    if (!m) { buf = buf.slice(at + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < at + 4 + len) return;
    const msg = JSON.parse(buf.slice(at + 4, at + 4 + len).toString('utf8'));
    buf = buf.slice(at + 4 + len);
    if (msg.method === 'initialize') send({ jsonrpc:'2.0', id:msg.id, result:{ capabilities:{} } });
    else if (msg.method === 'textDocument/definition') send({ jsonrpc:'2.0', id:msg.id, result:[{ uri: msg.params.textDocument.uri, range:{ start:{line:0,character:0}, end:{line:0,character:1} } }] });
    else if (msg.method === 'textDocument/hover') send({ jsonrpc:'2.0', id:msg.id, result:{ contents:{ kind:'markdown', value:'**mock type**' } } });
    else if (msg.method === 'textDocument/didOpen') send({ jsonrpc:'2.0', method:'textDocument/publishDiagnostics', params:{ uri: msg.params.textDocument.uri, diagnostics:[{ severity:1, message:'mock error', range:{ start:{line:0,character:0}, end:{line:0,character:1} } }] } });
    else if (msg.method === 'shutdown') send({ jsonrpc:'2.0', id:msg.id, result:null });
    else if (msg.method === 'exit') process.exit(0);
  }
});
`;

describe('LSP 客户端', () => {
  test('initialize / definition / hover / diagnostics 完整往返', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mh-lsp-'));
    const file = join(root, 'a.ts');
    const script = join(root, 'mock-lsp.mjs');
    writeFileSync(file, 'const x = 1;\n');
    writeFileSync(script, MOCK_LSP);
    const client = new LspClient('mock', {
      command: process.execPath,
      args: [script],
      extensions: ['.ts'],
    }, root);
    t.after(async () => {
      try { await client.stop(); } catch { /* 已退出 */ }
      rmSync(root, { recursive: true, force: true });
    });

    const defs = await client.definition(file, 0, 0);
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.range.start.line, 0);
    assert.equal(await client.hover(file, 0, 0), '**mock type**');
    const diagnostics = await client.diagnostics(file);
    assert.equal(diagnostics[0]?.severity, 1);
    assert.equal(diagnostics[0]?.message, 'mock error');
  });

  test('按扩展名选择 server，且未知扩展不误选', () => {
    const configs = {
      ts: { command: 'x', extensions: ['.ts', '.tsx'] },
      py: { command: 'y', extensions: ['.py'] },
    };
    assert.equal(pickLspServer(configs, '/a/b.ts')?.name, 'ts');
    assert.equal(pickLspServer(configs, '/a/b.py')?.name, 'py');
    assert.equal(pickLspServer(configs, '/a/b.rs'), undefined);
  });
});
