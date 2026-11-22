import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createContent, readContent, patchContent, versionOf } from '../formats';
import { documentService } from '../service';
import plugin from '../index';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function unchanged(before: Buffer, after: Buffer, changed: string[]) {
  const a = await JSZip.loadAsync(before),
    b = await JSZip.loadAsync(after);
  assert.deepEqual(Object.keys(a.files).sort(), Object.keys(b.files).sort());
  for (const name of Object.keys(a.files).filter((name) => !changed.includes(name)))
    assert.deepEqual(await a.files[name]!.async('nodebuffer'), await b.files[name]!.async('nodebuffer'), name);
}
test('Word creation and exact paragraph / table patches preserve unrelated package members', async () => {
  const bytes = await createContent({
    format: 'docx',
    title: '会议纪要',
    paragraphs: [{ text: '预算为 100 元。' }, { text: '下一段不变', bullet: true }],
    tables: [
      [
        ['事项', '负责人'],
        ['复核', '甲'],
      ],
    ],
  });
  const read = await readContent(bytes, 'docx');
  const paragraph = read.blocks.find((block) => block.text === '预算为 100 元。')!;
  const cell = read.blocks.find((block) => block.text === '甲')!;
  const result = await patchContent(bytes, 'docx', read.version, [
    { blockId: paragraph.id, expected: paragraph.text, text: '预算为 120 元。' },
    { blockId: cell.id, expected: '甲', text: '乙' },
  ]);
  const next = await readContent(result, 'docx');
  assert.ok(next.blocks.some((block) => block.text === '预算为 120 元。'));
  assert.ok(next.blocks.some((block) => block.text === '下一段不变'));
  assert.ok(next.blocks.some((block) => block.rows?.[1]?.[1] === '乙'));
  await unchanged(bytes, result, ['word/document.xml']);
});
test('Spreadsheet patches preserve other members and mark formulas for Office recalculation', async () => {
  const bytes = await createContent({
    format: 'xlsx',
    sheets: [
      {
        name: '预算',
        rows: [
          ['项目', '金额'],
          ['A', 100],
          ['B', 200],
        ],
      },
    ],
  });
  const read = await readContent(bytes, 'xlsx');
  const cell = read.blocks.find((block) => block.anchor.cell === 'B2')!;
  const result = await patchContent(bytes, 'xlsx', read.version, [{ blockId: cell.id, expected: '100', text: '150' }]);
  const after = await readContent(result, 'xlsx');
  assert.equal(after.blocks.find((block) => block.id === cell.id)?.text, '150');
  await unchanged(bytes, result, ['xl/worksheets/sheet1.xml', 'xl/workbook.xml']);
  assert.match(await (await JSZip.loadAsync(result)).file('xl/workbook.xml')!.async('string'), /fullCalcOnLoad="1"/);
});
test('Spreadsheet booleans and dates round trip while formula and merged targets fail explicitly', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('data');
  sheet.getCell('A1').value = true;
  sheet.getCell('B1').value = { formula: '1+1', result: 2 };
  sheet.mergeCells('C1:D1');
  sheet.getCell('C1').value = 'merged';
  sheet.getCell('E1').value = new Date('2026-01-01T00:00:00Z');
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const content = await readContent(bytes, 'xlsx');
  const result = await patchContent(bytes, 'xlsx', content.version, [{ blockId: '1!A1', expected: 'true', text: 'false' }]);
  assert.equal((await readContent(result, 'xlsx')).blocks.find((b) => b.id === '1!A1')?.text, 'false');
  for (const [blockId, message] of [
    ['1!B1', /普通单元格/],
    ['1!C1', /合并/],
  ] as const) {
    const target = content.blocks.find((b) => b.id === blockId)!;
    await assert.rejects(patchContent(bytes, 'xlsx', content.version, [{ blockId, expected: target.text, text: 'new' }]), message);
  }
  const date = content.blocks.find((b) => b.id === '1!E1')!;
  const updated = await patchContent(bytes, 'xlsx', content.version, [{ blockId: date.id, expected: date.text, text: '2026-02-02' }]);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(updated as never);
  assert.equal((reloaded.getWorksheet(1)!.getCell('E1').value as Date).toISOString(), '2026-02-02T00:00:00.000Z');
  await assert.rejects(
    patchContent(bytes, 'xlsx', content.version, [{ blockId: date.id, expected: date.text, text: '2026-02-30' }]),
    /日期/,
  );
});
test('Presentation creation, slide order and targeted text modification round trip', async () => {
  const bytes = await createContent({
    format: 'pptx',
    slides: [
      { title: '进度汇报', text: '已完成 3 项' },
      { title: '下一步', text: '继续验证' },
    ],
  });
  const read = await readContent(bytes, 'pptx');
  const target = read.blocks.find((block) => block.text === '已完成 3 项')!;
  assert.equal(target.anchor.slide, 1);
  const result = await patchContent(bytes, 'pptx', read.version, [{ blockId: target.id, expected: target.text, text: '已完成 4 项' }]);
  assert.ok((await readContent(result, 'pptx')).blocks.some((block) => block.text === '已完成 4 项'));
  await unchanged(bytes, result, ['ppt/slides/slide1.xml']);
});
test('CSV handles quotes, commas, multiline cells and exact cell editing', async () => {
  const bytes = await createContent({
    format: 'csv',
    sheets: [
      {
        name: 'data',
        rows: [
          ['列一', '列二'],
          ['a,b', '有"引号\n换行'],
        ],
      },
    ],
  });
  const result = await patchContent(bytes, 'csv', versionOf(bytes), [{ blockId: 'row:2:1', expected: 'a,b', text: 'c,d' }]);
  assert.deepEqual((await readContent(result, 'csv')).blocks[1]?.rows, [['c,d', '有"引号\n换行']]);
});
test('Version conflicts, wrong text and duplicate targets fail without mutation', async () => {
  const bytes = await createContent({ format: 'docx', paragraphs: [{ text: 'original' }] });
  const original = Buffer.from(bytes);
  const read = await readContent(bytes, 'docx');
  const patch = { blockId: read.blocks[0]!.id, expected: 'original', text: 'new' };
  await assert.rejects(patchContent(bytes, 'docx', '0'.repeat(64), [patch]), /VERSION_CONFLICT/);
  await assert.rejects(patchContent(bytes, 'docx', read.version, [{ ...patch, expected: 'wrong' }]), /不匹配/);
  await assert.rejects(patchContent(bytes, 'docx', read.version, [patch, patch]), /只能修改一次/);
  assert.deepEqual(bytes, original);
});
test('Fields, tracked insertions and signed packages are rejected for editing', async () => {
  const source = await createContent({ format: 'docx', paragraphs: [{ text: 'ordinary' }] });
  for (const kind of ['field', 'revision', 'signature']) {
    const zip = await JSZip.loadAsync(source);
    let text = await zip.file('word/document.xml')!.async('string');
    if (kind === 'field') text = text.replace('<w:t', '<w:fldChar w:fldCharType="begin"/><w:t');
    if (kind === 'revision') text = text.replace('<w:r>', '<w:ins><w:r>').replace('</w:r>', '</w:r></w:ins>');
    if (kind === 'signature') zip.file('_xmlsignatures/sig1.xml', '<Signature/>');
    zip.file('word/document.xml', text);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const read = await readContent(bytes, 'docx');
    await assert.rejects(
      patchContent(bytes, 'docx', read.version, [{ blockId: read.blocks[0]!.id, expected: 'ordinary', text: 'changed' }]),
      /域|修订|签名/,
    );
  }
});
test('Malformed, entity-containing and oversized Office inputs are bounded', async () => {
  await assert.rejects(readContent(Buffer.from('broken'), 'docx'), /损坏|加密/);
  await assert.rejects(readContent(Buffer.alloc(20 * 1024 * 1024 + 1), 'pdf'), /20 MB/);
  const bytes = await createContent({ format: 'docx', paragraphs: [{ text: 'safe' }] });
  const zip = await JSZip.loadAsync(bytes);
  zip.file('word/document.xml', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>');
  await assert.rejects(readContent(await zip.generateAsync({ type: 'nodebuffer' }), 'docx'), /实体/);
});
test('Pagination and source block focus locate content beyond the first page of blocks', async () => {
  const bytes = await createContent({ format: 'docx', paragraphs: Array.from({ length: 90 }, (_, index) => ({ text: `段落 ${index}` })) });
  const read = await readContent(bytes, 'docx', { limit: 10 });
  assert.equal(read.nextOffset, 10);
  const focused = await readContent(bytes, 'docx', { blockId: 'word/document.xml#80' });
  assert.equal(focused.blocks[0]?.text, '段落 80');
});
test('Worker creates documents and respects an already-cancelled operation', async () => {
  const bytes = await documentService.create({ format: 'docx', paragraphs: [{ text: 'worker' }] });
  assert.equal((await documentService.read(bytes, 'docx')).blocks[0]?.text, 'worker');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(documentService.create({ format: 'md', text: 'x' }, controller.signal));
});
test('In-flight and queued document work is cancellable without occupying subsequent slots', async () => {
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const jobs = controllers.map((controller) =>
    documentService.create({ format: 'docx', paragraphs: [{ text: 'cancel' }] }, controller.signal),
  );
  controllers.forEach((controller) => {
    controller.abort();
  });
  const results = await Promise.allSettled(jobs);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal((await documentService.create({ format: 'md', text: 'next' })).toString(), 'next');
});
test('Table previews bound cell content and report truncation', async () => {
  const bytes = await createContent({ format: 'csv', sheets: [{ name: 'data', rows: [['x'.repeat(100_000)]] }] });
  const content = await readContent(bytes, 'csv');
  assert.ok(JSON.stringify(content.blocks).length < 45_000);
  assert.ok(content.warnings.some((value) => /截断/.test(value)));
});
test('Document tool publishes a separate artifact and leaves source bytes intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-office-write-'));
  const tools = new Map<string, any>();
  try {
    plugin.onLoad({
      register: (value: any) => {
        if (value.kind === 'tool') tools.set(value.tool.name, value.tool);
      },
      kernel: { rootDir: root },
      logger: { info() {} },
      config: { get: (_: string, fallback: unknown) => fallback },
    } as never);
    const source = await createContent({ format: 'docx', paragraphs: [{ text: 'source' }] });
    writeFileSync(join(root, 'source.docx'), source);
    const read = await readContent(source, 'docx');
    const result = await tools
      .get('patch_document')
      .handler(
        { path: 'source.docx', version: read.version, patches: [{ blockId: read.blocks[0]!.id, expected: 'source', text: 'result' }] },
        { sandboxRoot: root, runId: 'run1', quota: { assertWritable() {}, invalidate() {} } },
      );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.evidence[0].artifact, true);
    assert.deepEqual(readFileSync(join(root, 'source.docx')), source);
    assert.equal((await readContent(readFileSync(join(root, result.data.path)), 'docx')).blocks[0]?.text, 'result');
    assert.equal(
      readdirSync(join(root, 'outputs', 'run1')).some((name) => name.endsWith('.tmp')),
      false,
    );
    const sources = [{ path: 'source.docx', version: read.version }];
    const created = await tools
      .get('create_document')
      .handler({ spec: { format: 'md', text: 'notes' }, sources }, { sandboxRoot: root, runId: 'run2' });
    assert.equal(created.ok, true, created.error);
    assert.deepEqual(created.evidence[0].value.sources, sources);
    const stale = await tools
      .get('create_document')
      .handler(
        { spec: { format: 'md', text: 'notes' }, sources: [{ path: 'source.docx', version: '0'.repeat(64) }] },
        { sandboxRoot: root, runId: 'run3' },
      );
    assert.equal(stale.ok, false);
    assert.match(stale.error, /VERSION_CONFLICT/);
    assert.equal(existsSync(join(root, 'outputs', 'run3')), false);
    const controller = new AbortController();
    const cancelled = await tools.get('create_document').handler(
      { spec: { format: 'md', text: 'cancelled' } },
      {
        sandboxRoot: root,
        runId: 'run4',
        signal: controller.signal,
        quota: {
          assertWritable() {
            controller.abort();
          },
        },
      },
    );
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.evidence, undefined);
    assert.deepEqual(readdirSync(join(root, 'outputs', 'run4')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
