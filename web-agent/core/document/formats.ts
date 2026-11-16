import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { DocumentBlock, DocumentContent } from '../../kernel/material';

const MAX_BYTES = 20 * 1024 * 1024;
const XML_LIMIT = 20 * 1024 * 1024;
export const versionOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface Patch { blockId: string; expected: string; text: string }
export interface CreateSpec {
  format: 'docx' | 'xlsx' | 'csv' | 'pptx' | 'md'; title?: string;
  paragraphs?: { text: string; heading?: 1 | 2 | 3; bullet?: boolean }[];
  tables?: string[][][]; sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
  slides?: { title: string; text?: string; rows?: string[][] }[]; text?: string;
  blocks?: ({ text: string; heading?: 1 | 2 | 3; bullet?: boolean } | { rows: string[][] })[];
}
type XmlDoc = ReturnType<DOMParser['parseFromString']>;
type XmlElement = ReturnType<XmlDoc['createElement']>;
function elements(node: XmlDoc | XmlElement, local: string): XmlElement[] {
  return Array.from(node.getElementsByTagName('*')).filter(element => element.localName === local);
}
function xml(text: string): XmlDoc {
  if (text.length > XML_LIMIT || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持包含实体声明或超限的 XML');
  return new DOMParser({ onError: level => { if (level !== 'warning') throw new Error('文档 XML 损坏'); } }).parseFromString(text, 'application/xml');
}
function textOf(node: XmlElement, tag = 't') { return elements(node, tag).map(element => element.textContent ?? '').join(''); }
async function packageOf(bytes: Buffer): Promise<JSZip> {
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 20 MB 上限');
  // Inspect central directory sizes before JSZip can decompress attacker-controlled entries.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Office ZIP 损坏或文件已加密');
  const count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16); let total = 0;
  if (count > 4096 || count === 0) throw new Error('Office 文件条目数超限');
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Office ZIP 目录损坏');
    const size = bytes.readUInt32LE(cursor + 24); total += size;
    if (size > XML_LIMIT || total > 100 * 1024 * 1024 || bytes.readUInt16LE(cursor + 8) & 1) throw new Error('Office 解压体积超限或条目加密');
    cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  if (Object.keys(zip.files).some(name => /(^|\/)\.\.(\/|$)|^\//.test(name))) throw new Error('非法包成员路径');
  return zip;
}
async function part(zip: JSZip, path: string) { const entry = zip.file(path); if (!entry) throw new Error(`缺少文档部件：${path}`); return xml(await entry.async('string')); }
function protectedPackage(zip: JSZip) { return Object.keys(zip.files).some(name => /_xmlsignatures|vbaProject|encryption/i.test(name)); }
function paragraphs(doc: XmlDoc, format: string) {
  if (format === 'docx') return elements(doc, 'p');
  // Each ordinary text shape / table cell is an independently editable block.
  return elements(doc, 'txBody');
}
function block(id: string, type: DocumentBlock['type'], text: string, version: string, extra: Partial<DocumentBlock['anchor']> = {}): DocumentBlock {
  return { id, type, text, anchor: { version, blockId: id, ...extra } };
}
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) { row.push(value); value = ''; if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; } }
    else value += c;
    if (rows.length > 100_000) throw new Error('CSV 行数超限');
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
function toCsv(rows: (string | number | boolean | null)[][]) { return '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n'); }

export async function readContent(bytes: Buffer, format: string, options: { offset?: number; limit?: number; pages?: number[]; blockId?: string } = {}): Promise<DocumentContent> {
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 20 MB 上限');
  const version = versionOf(bytes); const blocks: DocumentBlock[] = []; const warnings: string[] = []; let editable = false;
  if (['docx', 'xlsx', 'pptx'].includes(format)) {
    const zip = await packageOf(bytes); editable = !protectedPackage(zip);
    if (!editable) warnings.push('包含宏或数字签名，禁止编辑');
    if (format === 'docx') {
      const doc = await part(zip, 'word/document.xml');
      const { default: mammoth } = await import('mammoth');
      const semantic = await mammoth.extractRawText({ buffer: bytes });
      warnings.push(...semantic.messages.map(message => message.message).slice(0, 5));
      paragraphs(doc, format).forEach((node, index) => {
        const type = elements(node, 'pStyle').some(p => /heading|标题/i.test(p.getAttribute('w:val') ?? '')) ? 'heading' : elements(node, 'numPr').length ? 'listItem' : 'paragraph';
        const value = block(`word/document.xml#${index}`, type, textOf(node), version);
        blocks.push(value);
      });
      elements(doc, 'tbl').forEach((node, index) => { const value = block(`table:${index}`, 'table', '', version); value.rows = elements(node, 'tr').map(row => elements(row, 'tc').map(cell => textOf(cell))); blocks.push(value); });
      warnings.push('内容预览，不代表原始分页或完整版式');
    } else if (format === 'xlsx') {
      const { default: ExcelJS } = await import('exceljs'); const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
      let cells = 0;
      book.worksheets.forEach(sheet => sheet.eachRow(row => row.eachCell(cell => {
        if (++cells > 100_000) throw new Error('工作簿非空单元格超过 100000 个');
        const value = block(`${sheet.id}!${cell.address}`, 'cell', cell.text, version, { sheet: sheet.name, cell: cell.address });
        if (cell.formula) { value.formula = cell.formula; value.text = cell.result === undefined ? '' : String(cell.result); }
        blocks.push(value);
      })));
      warnings.push('内容预览；公式显示缓存值，修改后需由 Office 重算');
    } else {
      const presentation = await part(zip, 'ppt/presentation.xml'); const rels = await part(zip, 'ppt/_rels/presentation.xml.rels');
      const slides = elements(presentation, 'sldId').map(node => { const rel = elements(rels, 'Relationship').find(r => r.getAttribute('Id') === node.getAttribute('r:id')); const target = rel?.getAttribute('Target') ?? ''; if (!/^slides\/slide\d+\.xml$/.test(target)) throw new Error('不支持的幻灯片关系'); return `ppt/${target}`; });
      for (let i = 0; i < slides.length; i++) {
        const name = slides[i]!; const doc = await part(zip, name);
        paragraphs(doc, format).forEach((node, index) => blocks.push(block(`${name}#${index}`, 'paragraph', elements(node, 'p').map(p => textOf(p)).join('\n'), version, { slide: i + 1 })));
        elements(doc, 'tbl').forEach((node, index) => {
          const table = block(`${name}:table:${index}`, 'table', '', version, { slide: i + 1 });
          table.rows = elements(node, 'tr').map(row => elements(row, 'tc').map(cell => elements(cell, 'p').map(p => textOf(p)).join('\n')));
          blocks.push(table);
        });
        const relPath = name.replace('slides/', 'slides/_rels/') + '.rels';
        if (zip.file(relPath)) {
          const relationships = await part(zip, relPath);
          for (const image of elements(doc, 'blip')) {
            const relationship = elements(relationships, 'Relationship').find(r => r.getAttribute('Id') === image.getAttribute('r:embed'));
            const target = relationship?.getAttribute('Target') ?? '';
            if (!relationship || relationship.getAttribute('TargetMode') === 'External' || !/^\.\.\/media\/[\w.-]+\.(png|jpe?g)$/i.test(target)) continue;
            const data = await zip.file('ppt/' + target.slice(3))?.async('nodebuffer');
            if (!data || data.length > 1024 * 1024) continue;
            const item = block(`${name}:image:${blocks.length}`, 'image', '幻灯片图片', version, { slide: i + 1 }); item.image = `data:image/${/\.png$/i.test(target) ? 'png' : 'jpeg'};base64,${data.toString('base64')}`; blocks.push(item);
          }
        }
      }
      warnings.push('内容预览，不代表原始版式；组合对象不支持定点修改');
    }
  } else if (format === 'pdf') {
    const { PDFParse } = await import('pdf-parse'); const parser = new PDFParse({ data: bytes });
    try {
      const text = await parser.getText(options.pages?.length ? { partial: options.pages } : {});
      for (const page of text.pages) blocks.push(block(`page:${page.num}`, 'page', page.text, version, { page: page.num }));
      try { const tables = await parser.getTable(options.pages?.length ? { partial: options.pages } : {}); let index = 0; for (const page of tables.pages) for (const rows of page.tables) { if (index >= 20) break; const value = block(`page:${page.num}:table:${index++}`, 'table', '', version, { page: page.num }); value.rows = rows.slice(0, 200).map(row => row.slice(0, 50)); blocks.push(value); } } catch { warnings.push('本次未能检测 PDF 表格；可依据原页检查'); }
    }
    finally { await parser.destroy(); }
    warnings.push('扫描件需要配置 OCR 后识别；PDF 不支持直接编辑');
  } else if (format === 'csv') {
    editable = true; csvRows(bytes.toString('utf8').replace(/^\ufeff/, '')).forEach((row, index) => { const value = block(`row:${index + 1}`, 'table', row.join(', '), version); value.rows = [row]; blocks.push(value); });
  } else if (['md', 'txt', 'json', 'bib'].includes(format)) { blocks.push(block('text', 'paragraph', bytes.toString('utf8'), version)); }
  else throw new Error('不支持此格式，请使用 PDF、DOCX、XLSX、CSV、PPTX、Markdown 或文本');
  const targetOffset = options.blockId ? blocks.findIndex(item => item.id === options.blockId) : -1;
  if (options.blockId && targetOffset < 0) throw new Error('来源定位不存在，请重新读取');
  const offset = targetOffset >= 0 ? targetOffset : Math.max(0, Math.floor(options.offset ?? 0)); const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 60)));
  let chars = 0; const selected: DocumentBlock[] = [];
  for (const value of blocks.slice(offset, offset + limit)) {
    if (chars >= 40_000) break;
    const text = value.text.slice(0, 40_000 - chars); chars += text.length;
    let truncated = text.length < value.text.length;
    const rows: string[][] | undefined = value.rows ? [] : undefined;
    if (value.rows) for (const row of value.rows.slice(0, 200)) {
      if (chars >= 40_000) { truncated = true; break; }
      const cells: string[] = [];
      for (const cell of row.slice(0, 50)) {
        const bounded = cell.slice(0, Math.min(2000, 40_000 - chars));
        chars += bounded.length; cells.push(bounded); truncated ||= bounded.length < cell.length;
        if (chars >= 40_000) break;
      }
      truncated ||= cells.length < row.length; rows!.push(cells);
    }
    truncated ||= Boolean(value.rows && rows!.length < value.rows.length);
    if (truncated) warnings.push(`内容块 ${value.id} 超过预览上限，已截断；定点修改前须缩小目标`);
    selected.push({ ...value, text, ...(rows ? { rows } : {}) });
  }
  const next = offset + selected.length;
  return { format, version, blocks: selected, total: blocks.length, nextOffset: next < blocks.length ? next : undefined, warnings, editable };
}

export async function createContent(spec: CreateSpec): Promise<Buffer> {
  let bytes: Buffer;
  if (spec.format === 'md') bytes = Buffer.from(spec.text ?? spec.paragraphs?.map(p => p.text).join('\n\n') ?? '');
  else if (spec.format === 'csv') bytes = Buffer.from(toCsv(spec.sheets?.[0]?.rows ?? spec.tables?.[0] ?? []));
  else if (spec.format === 'docx') {
    const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = await import('docx');
    const headings = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
    const content = (spec.blocks ?? spec.paragraphs ?? []).map(p => 'rows' in p
      ? new Table({ rows: p.rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(text => new TableCell({ children: [new Paragraph(text)] })) })) })
      : new Paragraph({ children: [new TextRun(p.text)], heading: p.heading ? headings[p.heading] : undefined, bullet: p.bullet ? { level: 0 } : undefined }));
    const tables = (spec.tables ?? []).map(rows => new Table({ rows: rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(text => new TableCell({ children: [new Paragraph(text)] })) })) }));
    bytes = await Packer.toBuffer(new Document({ sections: [{ children: [...(spec.title ? [new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE })] : []), ...content, ...tables] }] }));
  } else if (spec.format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs'); const book = new ExcelJS.Workbook();
    for (const sheet of spec.sheets ?? [{ name: 'Sheet1', rows: spec.tables?.[0] ?? [] }]) { const page = book.addWorksheet(sheet.name); page.addRows(sheet.rows); page.views = [{ state: 'frozen', ySplit: 1 }]; page.getRow(1).font = { bold: true }; }
    bytes = Buffer.from(await book.xlsx.writeBuffer());
  } else if (spec.format === 'pptx') {
    const { default: PptxGenJS } = await import('pptxgenjs'); const ppt = new PptxGenJS(); ppt.layout = 'LAYOUT_WIDE'; ppt.title = spec.title ?? ''; ppt.subject = 'maharness'; ppt.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei' };
    for (const data of spec.slides ?? []) { const slide = ppt.addSlide(); slide.addText(data.title, { x: 0.6, y: 0.4, w: 12, h: 0.8, fontSize: 28, bold: true, color: '222222' }); if (data.text) slide.addText(data.text, { x: 0.6, y: 1.5, w: 12, h: data.rows ? 2.2 : 5.1, fontSize: 20, breakLine: false, fit: 'shrink', color: '333333' }); if (data.rows) slide.addTable(data.rows.map(row => row.map(text => ({ text }))), { x: 0.6, y: data.text ? 3.9 : 1.5, w: 12, fontSize: 14, border: { color: 'DDDDDD', pt: 0.5 } }); }
    if (!spec.slides?.length) throw new Error('至少需要一张幻灯片');
    bytes = await ppt.write({ outputType: 'nodebuffer' }) as Buffer;
  } else throw new Error('不支持的生成格式');
  if (bytes.length > MAX_BYTES) throw new Error('生成文件超过 20 MB');
  await readContent(bytes, spec.format, { limit: 1 });
  return bytes;
}

function replaceText(node: XmlElement, expected: string, replacement: string, format: string) {
  if (['fldChar', 'fldSimple', 'instrText', 'ins', 'del', 'fld', 'br', 'tab', 'sdt', 'drawing', 'object'].some(tag => elements(node, tag).length)) throw new Error('目标含域、修订或复杂对象，无法安全修改');
  for (let parent = node.parentNode; parent?.nodeType === 1; parent = parent.parentNode) if (['ins', 'del', 'sdt', 'grpSp'].includes((parent as XmlElement).localName ?? '')) throw new Error('目标处于修订、内容控件或组合对象中');
  const nodes = elements(node, 't'); const current = format === 'pptx' ? elements(node, 'p').map(p => textOf(p)).join('\n') : textOf(node);
  if (current !== expected) throw new Error('目标原文不匹配，请重新读取');
  if (!nodes.length || format === 'pptx' && elements(node, 'p').length !== 1) throw new Error('仅支持含普通单段文本的目标');
  let start = 0; while (start < current.length && start < replacement.length && current[start] === replacement[start]) start++;
  let end = current.length, nextEnd = replacement.length; while (end > start && nextEnd > start && current[end - 1] === replacement[nextEnd - 1]) { end--; nextEnd--; }
  let position = 0; let inserted = false;
  for (const text of nodes) { const value = text.textContent ?? ''; const from = position; const to = position + value.length; position = to; if (to < start || from > end) continue; const prefix = value.slice(0, Math.max(0, start - from)); const suffix = value.slice(Math.max(0, end - from)); text.textContent = prefix + (!inserted ? replacement.slice(start, nextEnd) : '') + suffix; text.setAttribute('xml:space', 'preserve'); inserted = true; }
}
export async function patchContent(bytes: Buffer, format: string, version: string, patches: Patch[]): Promise<Buffer> {
  if (version !== versionOf(bytes)) throw new Error('FILE_VERSION_CONFLICT：文件版本已变化，请重新读取');
  if (!Array.isArray(patches) || !patches.length || patches.length > 200 || patches.some(p => !p || typeof p.blockId !== 'string' || typeof p.expected !== 'string' || typeof p.text !== 'string')) throw new Error('需要 1–200 个有效修改项');
  if (new Set(patches.map(p => p.blockId)).size !== patches.length) throw new Error('同一目标只能修改一次');
  if (format === 'csv') { const rows = csvRows(bytes.toString('utf8').replace(/^\ufeff/, '')); for (const patch of patches) { const match = /^row:(\d+):(\d+)$/.exec(patch.blockId); if (!match) throw new Error('CSV 定位格式为 row:行号:列号（从 1 开始）'); const row = rows[Number(match[1]) - 1]; const col = Number(match[2]) - 1; if (!row || row[col] !== patch.expected) throw new Error('目标原值不匹配'); row[col] = patch.text; } return Buffer.from(toCsv(rows)); }
  if (!['docx', 'xlsx', 'pptx'].includes(format)) throw new Error('此格式不支持定点修改');
  const zip = await packageOf(bytes); if (protectedPackage(zip)) throw new Error('宏或数字签名文件禁止编辑');
  let spreadsheet: import('exceljs').Workbook | undefined;
  if (format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs'); spreadsheet = new ExcelJS.Workbook();
    await spreadsheet.xlsx.load(bytes as never);
  }
  const changed = new Map<string, XmlDoc>(); const get = async (name: string) => { if (!changed.has(name)) changed.set(name, await part(zip, name)); return changed.get(name)!; };
  for (const patch of patches) {
    if (format === 'xlsx') {
      const match = /^(\d+)!([A-Z]{1,3}[1-9]\d{0,6})$/.exec(patch.blockId); if (!match) throw new Error('无效单元格定位');
      const book = await part(zip, 'xl/workbook.xml'); const sheet = elements(book, 'sheet').find(node => node.getAttribute('sheetId') === match[1]);
      const rels = await part(zip, 'xl/_rels/workbook.xml.rels'); const rel = elements(rels, 'Relationship').find(node => node.getAttribute('Id') === sheet?.getAttribute('r:id'));
      const target = (rel?.getAttribute('Target') ?? '').replace(/^\/?xl\//, ''); if (!/^worksheets\/sheet\d+\.xml$/.test(target)) throw new Error('不支持的工作表关系');
      const doc = await get(`xl/${target}`); const cell = elements(doc, 'c').find(node => node.getAttribute('r') === match[2]); if (!cell || elements(cell, 'f').length) throw new Error('仅支持修改现有普通单元格');
      if (elements(doc, 'mergeCell').some(node => { const range = node.getAttribute('ref')?.split(':'); if (!range?.[1]) return false; const address = (value: string) => { const m = /^([A-Z]+)(\d+)$/.exec(value)!; return [m[1]!.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), Number(m[2])]; }; const p = address(match[2]!), a = address(range[0]!), b = address(range[1]); return p[0]! >= a[0]! && p[0]! <= b[0]! && p[1]! >= a[1]! && p[1]! <= b[1]!; })) throw new Error('合并单元格不支持定点修改');
      const original = spreadsheet!.getWorksheet(Number(match[1]))?.getCell(match[2]!);
      if (!original || typeof original.value === 'object' && original.value !== null && !(original.value instanceof Date)) throw new Error('富文本和链接单元格不支持定点修改，请创建结果表格');
      const current = original.text;
      if (current !== patch.expected) throw new Error('目标原值不匹配，请重新读取');
      let dateSerial: number | undefined;
      if (original.value instanceof Date) {
        const date = new Date(patch.text);
        if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(patch.text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== patch.text.slice(0, 10) || date.getUTCFullYear() < (spreadsheet!.properties.date1904 ? 1904 : 1900)) throw new Error('日期新值必须是有效的 YYYY-MM-DD 或 UTC ISO 时间');
        dateSerial = date.getTime() / 86_400_000 + 25569 - (spreadsheet!.properties.date1904 ? 1462 : date.getTime() < Date.UTC(1900, 2, 1) ? 1 : 0);
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      const ns = cell.namespaceURI!; const numeric = typeof original.value === 'number' && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(patch.text);
      if (dateSerial !== undefined) { cell.removeAttribute('t'); const value = doc.createElementNS(ns, 'v'); value.textContent = String(dateSerial); cell.appendChild(value); }
      else if (typeof original.value === 'boolean' && /^(true|false)$/i.test(patch.text)) { cell.setAttribute('t', 'b'); const value = doc.createElementNS(ns, 'v'); value.textContent = patch.text.toLowerCase() === 'true' ? '1' : '0'; cell.appendChild(value); }
      else if (numeric) { cell.removeAttribute('t'); const value = doc.createElementNS(ns, 'v'); value.textContent = patch.text; cell.appendChild(value); }
      else { cell.setAttribute('t', 'inlineStr'); const is = doc.createElementNS(ns, 'is'); const text = doc.createElementNS(ns, 't'); text.setAttribute('xml:space', 'preserve'); text.textContent = patch.text; is.appendChild(text); cell.appendChild(is); }
      const workbook = await get('xl/workbook.xml'); let calc = elements(workbook, 'calcPr')[0]; if (!calc) { calc = workbook.createElementNS(workbook.documentElement!.namespaceURI, 'calcPr'); workbook.documentElement!.appendChild(calc); } calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1');
    } else {
      const match = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml)#(\d+)$/.exec(patch.blockId); if (!match || format === 'docx' !== match[1]!.startsWith('word/')) throw new Error('无效内容定位');
      const doc = await get(match[1]!); const node = paragraphs(doc, format)[Number(match[2])]; if (!node) throw new Error('目标不存在'); replaceText(node, patch.expected, patch.text, format);
    }
  }
  for (const [name, doc] of changed) zip.file(name, new XMLSerializer().serializeToString(doc), { createFolders: false });
  const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await readContent(result, format, { limit: 1 }); return result;
}
export async function documentJob(job: Record<string, unknown>) {
  const bytes = job.bytes ? Buffer.from(job.bytes as Uint8Array) : Buffer.alloc(0);
  if (job.action === 'create') return createContent(job.spec as CreateSpec);
  if (job.action === 'patch') return patchContent(bytes, String(job.format), String(job.version), job.patches as Patch[]);
  return readContent(bytes, String(job.format), job as { offset?: number; limit?: number; pages?: number[] });
}
