import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import documentPlugin from '../index';
import JSZip from 'jszip';
import { Cache } from '../../../kernel/cache';
import type { DocumentContent } from '../../../kernel/material';
import { documentService } from '../service';

type Tool = { name: string; version?: string; handler: (args: Record<string, unknown>, ctx: any) => Promise<any> };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeContent(text: string, version = 'v1'): DocumentContent {
  return {
    format: 'docx',
    version,
    blocks: [{ id: 'b1', type: 'paragraph', text, anchor: { version, blockId: 'b1' } }],
    total: 1,
    warnings: [],
    editable: true,
  };
}

function loadTools(config: Record<string, unknown> = {}, kernelRoot = tmpdir()): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  (documentPlugin as any).onLoad({
    register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
    logger: { info() {} },
    kernel: { rootDir: kernelRoot },
    config: { get: (key: string, fallback: unknown) => key in config ? config[key] : fallback },
  });
  return tools;
}

function makePdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 18 Tf 20 100 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(header + body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(header + body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, 'utf8');
}

async function makeDocxBody(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeDocx(text: string): Promise<Buffer> {
  return makeDocxBody(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`);
}

describe('文档读取', () => {
  it('抽取 PDF 文本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      writeFileSync(join(root, 'sample.pdf'), makePdf('Hello PDF'));
      const tools = loadTools();
      const result = await tools.get('read_document')!.handler({ path: 'sample.pdf' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, true, result.error);
      assert.match(result.data.text, /Hello PDF/);
      assert.equal(result.data.truncated, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('拒绝非 PDF 文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      writeFileSync(join(root, 'note.txt'), 'plain text');
      const tools = loadTools();
      const result = await tools.get('read_document')!.handler({ path: 'note.txt' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, false);
      assert.match(String(result.error), /仅支持 PDF \/ DOCX/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('拒绝读取 data/ 下的文档', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data', 'secret.pdf'), makePdf('secret'));
      const tools = loadTools();
      const result = await tools.get('read_document')!.handler({ path: 'data/secret.pdf' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, false);
      assert.match(String(result.error), /拒绝读取/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('抽取 DOCX 文本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      writeFileSync(join(root, 'sample.docx'), await makeDocx('Hello DOCX'));
      const tools = loadTools();
      const result = await tools.get('read_document')!.handler({ path: 'sample.docx' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.format, 'docx');
      assert.match(result.data.text, /Hello DOCX/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('抽取 DOCX 表格为结构化行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
      const row = (cells: string) => `<w:tr>${cells}</w:tr>`;
      const table = `<w:tbl>${row(cell('指标') + cell('数值'))}${row(cell('准确率') + cell('98%'))}</w:tbl>`;
      writeFileSync(join(root, 'table.docx'), await makeDocxBody(`<w:p><w:r><w:t>实验数据</w:t></w:r></w:p>${table}`));
      const tools = loadTools();
      const result = await tools.get('read_document')!.handler({ path: 'table.docx' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.tableCount, 1);
      assert.deepEqual(result.data.tables[0].rows, [['指标', '数值'], ['准确率', '98%']]);
      assert.match(result.data.text, /实验数据/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ocr_image 调用管理员配置的外部 OCR 命令并返回文本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      const script = join(root, 'mock-ocr.mjs');
      writeFileSync(script, 'console.log(`OCR: ${process.argv[2]}`);\n');
      writeFileSync(join(root, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const tools = loadTools({
        'document.ocr': { command: process.execPath, args: [script, '{file}'], timeoutMs: 5_000 },
      });
      const result = await tools.get('ocr_image')!.handler({ path: 'scan.png' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, true, result.error);
      assert.match(result.data.text, /OCR: .*scan\.png/);
      assert.equal(result.data.truncated, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ocr_image 未配置时明确报错，不静默返回空文本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      writeFileSync(join(root, 'scan.png'), 'x');
      const tools = loadTools();
      const result = await tools.get('ocr_image')!.handler({ path: 'scan.png' }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, false);
      assert.match(result.error, /OCR 未配置/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('OCR 进程超时与主动取消均返回失败并结束子进程', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-ocr-cancel-'));
    try {
      const script = join(root, 'wait.mjs'); writeFileSync(script, 'setInterval(() => {}, 1000);'); writeFileSync(join(root, 'scan.png'), 'x');
      const tools = loadTools({ 'document.ocr': { command: process.execPath, args: [script, '{file}'], timeoutMs: 1000 } });
      const timedOut = await tools.get('ocr_image')!.handler({ path: 'scan.png' }, { sandboxRoot: root });
      assert.equal(timedOut.ok, false); assert.match(timedOut.error, /超时/);
      const controller = new AbortController(); const pending = tools.get('ocr_image')!.handler({ path: 'scan.png' }, { sandboxRoot: root, signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 100);
      const cancelled = await pending; clearTimeout(timer); assert.equal(cancelled.ok, false); assert.match(cancelled.error, /取消/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('OCR 保留失败时的部分输出，文件名不经 shell 解释', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-ocr-output-'));
    try {
      const script = join(root, 'ocr.mjs'); writeFileSync(script, 'console.log(process.argv[2]); process.exit(1);');
      const name = 'scan & whoami.png'; writeFileSync(join(root, name), 'x');
      const tools = loadTools({ 'document.ocr': { command: process.execPath, args: [script, '{file}'] } });
      const result = await tools.get('ocr_image')!.handler({ path: name }, { sandboxRoot: root });
      assert.equal(result.ok, false); assert.equal(result.data.partial, true); assert.equal(result.data.text, join(root, name));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ocr_pdf 先渲染页面再逐页 OCR，并清理临时目录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-'));
    try {
      const ocrScript = join(root, 'mock-ocr.mjs');
      const renderScript = join(root, 'mock-render.mjs');
      writeFileSync(ocrScript, 'console.log(`OCR:${process.argv[2]}`);\n');
      writeFileSync(renderScript, [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const out = process.argv[3];',
        'mkdirSync(out, { recursive: true });',
        "writeFileSync(join(out, 'page-1.png'), 'a');",
        "writeFileSync(join(out, 'page-2.png'), 'b');",
      ].join('\n'));
      writeFileSync(join(root, 'scan.pdf'), '%PDF-1.4\n');
      const tools = loadTools({
        'document.ocr': {
          command: process.execPath,
          args: [ocrScript, '{file}'],
          pdfCommand: process.execPath,
          pdfArgs: [renderScript, '{input}', '{outDir}'],
          timeoutMs: 5_000,
        },
      });
      const result = await tools.get('ocr_pdf')!.handler({ path: 'scan.pdf', maxPages: 2 }, { sandboxRoot: root, turn: 0, cache: {}, trace: {} });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.rendered, 2);
      assert.equal(result.data.pages.length, 2);
      assert.match(result.data.text, /OCR:.*page-1\.png/);
      assert.match(result.data.text, /OCR:.*page-2\.png/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('文档内容 L2 缓存', () => {
  it('同 key 并发读取只解析一次，后续命中不再解析', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-cache-'));
    const originalRead = documentService.read;
    const gate = deferred();
    const started = deferred();
    let reads = 0;
    let loaderSignal: AbortSignal | undefined;
    try {
      writeFileSync(join(root, 'shared.docx'), await makeDocx('shared'));
      const tools = loadTools({}, root);
      const cache = new Cache();
      documentService.read = async (_bytes, _format, _options, signal) => {
        reads++;
        loaderSignal = signal;
        started.resolve();
        await gate.promise;
        return makeContent('shared', 'doc-v1');
      };
      const context = () => ({ sandboxRoot: root, tenantId: 'tenant-a', turn: 0, cache, trace: {} });
      const handler = tools.get('read_document_content')!.handler;

      const first = handler({ path: 'shared.docx' }, context());
      const second = handler({ path: 'shared.docx' }, context());
      await started.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(reads, 1);

      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.ok, true, a.error);
      assert.equal(b.ok, true, b.error);
      assert.equal(a.data.blocks[0].text, 'shared');
      assert.equal(b.data.version, 'doc-v1');
      assert.equal(loaderSignal?.aborted, false);

      const cached = await handler({ path: 'shared.docx' }, context());
      assert.equal(cached.ok, true, cached.error);
      assert.equal(reads, 1);
    } finally {
      documentService.read = originalRead;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('解析失败不写入缓存，下一次调用会重试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-retry-'));
    const originalRead = documentService.read;
    let reads = 0;
    try {
      writeFileSync(join(root, 'retry.docx'), await makeDocx('retry'));
      const tools = loadTools({}, root);
      const cache = new Cache();
      documentService.read = async () => {
        reads++;
        if (reads === 1) throw new Error('parse failed');
        return makeContent('retry', `doc-v${reads}`);
      };
      const context = { sandboxRoot: root, tenantId: 'tenant-a', turn: 0, cache, trace: {} };
      const handler = tools.get('read_document_content')!.handler;

      const failed = await handler({ path: 'retry.docx' }, context);
      assert.equal(failed.ok, false);
      assert.match(String(failed.error), /parse failed/);

      const retried = await handler({ path: 'retry.docx' }, context);
      assert.equal(retried.ok, true, retried.error);
      assert.equal(retried.data.version, 'doc-v2');
      const cached = await handler({ path: 'retry.docx' }, context);
      assert.equal(cached.ok, true, cached.error);
      assert.equal(reads, 2);
    } finally {
      documentService.read = originalRead;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('单个读取取消不会取消同 key 的其他读取', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-cancel-'));
    const originalRead = documentService.read;
    const release = deferred();
    const started = deferred();
    const firstController = new AbortController();
    let loaderSignal: AbortSignal | undefined;
    try {
      writeFileSync(join(root, 'cancel.docx'), await makeDocx('cancel'));
      const tools = loadTools({}, root);
      class TrackingCache extends Cache {
        readonly secondEntered = deferred();
        private calls = 0;

        override async l2GetOrLoad<T>(
          key: string,
          load: (signal: AbortSignal) => Promise<T>,
          opts?: { ttlMs?: number; tenantId?: string; signal?: AbortSignal },
        ) {
          this.calls++;
          if (this.calls === 2) this.secondEntered.resolve();
          return super.l2GetOrLoad(key, load, opts);
        }
      }
      const cache = new TrackingCache();
      documentService.read = async (_bytes, _format, _options, signal) => {
        loaderSignal = signal;
        started.resolve();
        await release.promise;
        return makeContent('cancel', 'doc-v1');
      };
      const handler = tools.get('read_document_content')!.handler;
      const first = handler({ path: 'cancel.docx' }, {
        sandboxRoot: root, tenantId: 'tenant-a', turn: 0, cache, trace: {}, signal: firstController.signal,
      });
      const second = handler({ path: 'cancel.docx' }, {
        sandboxRoot: root, tenantId: 'tenant-a', turn: 0, cache, trace: {},
      });
      await started.promise;
      await cache.secondEntered.promise;

      firstController.abort();
      const cancelled = await first;
      assert.equal(cancelled.ok, false);
      assert.equal(loaderSignal?.aborted, false);
      release.resolve();
      const completed = await second;
      assert.equal(completed.ok, true, completed.error);
      assert.equal(completed.data.version, 'doc-v1');
      assert.equal(loaderSignal?.aborted, false);
    } finally {
      documentService.read = originalRead;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('key 隔离 tenant、workspace、工具版本、参数和文件 SHA-256 版本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-document-key-a-'));
    const otherRoot = mkdtempSync(join(tmpdir(), 'mh-document-key-b-'));
    const originalRead = documentService.read;
    let reads = 0;
    let lastParts: string[] = [];
    try {
      const bytes = await makeDocx('key');
      writeFileSync(join(root, 'key.docx'), bytes);
      writeFileSync(join(otherRoot, 'key.docx'), bytes);
      const tools = loadTools({}, root);
      const cache = new Cache();
      const originalMakeKey = cache.makeKey.bind(cache);
      cache.makeKey = (parts, scope) => {
        lastParts = parts;
        return originalMakeKey(parts, scope);
      };
      documentService.read = async () => makeContent('key', `doc-v${++reads}`);
      const handler = tools.get('read_document_content')!.handler;
      const read = (ctx: Record<string, unknown>, args: Record<string, unknown> = { path: 'key.docx' }) =>
        handler(args, { sandboxRoot: root, tenantId: 'tenant-a', turn: 0, cache, trace: {}, ...ctx });

      assert.equal(tools.get('read_document_content')!.version, '1.0.0');
      assert.equal((await read({})).ok, true);
      assert.ok(lastParts.includes('tool:1.0.0'));
      assert.ok(lastParts.some(part => part === 'tenant:tenant-a'));
      assert.ok(lastParts.some(part => part.startsWith('workspace:')));
      assert.ok(lastParts.some(part => part.startsWith('file:')));
      assert.equal((await read({})).ok, true);
      assert.equal(reads, 1);

      assert.equal((await read({ tenantId: 'tenant-b' })).ok, true);
      assert.equal(reads, 2);
      assert.equal((await read({}, { path: 'key.docx', limit: 1 })).ok, true);
      assert.equal(reads, 3);
      assert.equal((await read({ sandboxRoot: otherRoot })).ok, true);
      assert.equal(reads, 4);

      writeFileSync(join(root, 'key.docx'), await makeDocx('key changed'));
      assert.equal((await read({})).ok, true);
      assert.equal(reads, 5);
    } finally {
      documentService.read = originalRead;
      rmSync(root, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
