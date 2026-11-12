import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import documentPlugin from '../index';
import JSZip from 'jszip';

type Tool = { name: string; handler: (args: Record<string, unknown>, ctx: any) => Promise<any> };

function loadTools(config: Record<string, unknown> = {}): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  (documentPlugin as any).onLoad({
    register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
    logger: { info() {} },
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
