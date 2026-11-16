import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { documentService } from '../core/document/service';

const samples = resolve(process.argv[2] ?? '');
const executable = process.argv[3] ?? process.env.LIBREOFFICE_PATH;
if (!executable || !existsSync(join(samples, 'edited.docx'))) throw new Error('用法：tsx scripts/workbench-office.ts <samples目录> <LibreOffice可执行文件>');
const output = join(samples, 'office-preview'); mkdirSync(output, { recursive: true });
const profile = join(output, 'profile');
const results = [];
try {
  for (const [format, filename, expected] of [['docx', 'edited.docx', ['每周阅读 3 篇论文', '已完成']], ['xlsx', 'edited.xlsx', ['费用合计', '300']], ['pptx', 'edited.pptx', ['已阅读 3 篇论文', '下一步']]] as const) {
    const target = join(output, format); mkdirSync(target, { recursive: true }); const start = Date.now();
    const process = spawnSync(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', target, join(samples, filename)], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
    assert.equal(process.status, 0, `${process.error ?? ''}\n${process.stdout}\n${process.stderr}`);
    const pdf = join(target, filename.replace(/\.[^.]+$/, '.pdf')); assert.ok(existsSync(pdf), process.stdout + process.stderr);
    const content = await documentService.read(readFileSync(pdf), 'pdf', { limit: 200 }); const text = content.blocks.map(block => block.text).join('\n');
    for (const value of expected) assert.ok(text.includes(value), `${filename} 缺少 ${value}`);
    results.push({ format, filename, application: 'LibreOffice', passed: true, durationMs: Date.now() - start, pages: content.blocks.filter(block => block.type === 'page').length, pdf });
  }
} finally { rmSync(profile, { recursive: true, force: true }); }
const report = { kind: 'compatible-office-open-export', createdAt: new Date().toISOString(), passed: true, results, visualInspection: 'separate', modelRequests: 0 };
writeFileSync(join(samples, '..', 'office-validation.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
