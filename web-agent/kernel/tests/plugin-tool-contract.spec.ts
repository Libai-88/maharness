import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createResultTool } from '../../core/chat/result-tool';

const root = join(process.cwd(), 'core');

function toolBlocks(source: string): { name: string; block: string }[] {
  const out: { name: string; block: string }[] = [];
  const re = /kind:\s*'tool'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const tail = source.slice(match.index, match.index + 1500);
    const name = /name:\s*'([^']+)'/.exec(tail)?.[1];
    if (!name) continue;
    const start = source.indexOf('{', source.indexOf('tool:', match.index));
    if (start < 0) continue;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    out.push({ name, block: source.slice(start, end + 1) });
  }
  return out;
}

describe('内置工具副作用契约', () => {
  it('所有 core 工具声明 sideEffect（生成模板除外）', () => {
    const missing: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('@')) continue;
      const file = join(root, entry.name, 'index.ts');
      if (!existsSync(file)) continue;
      for (const tool of toolBlocks(readFileSync(file, 'utf8'))) {
        if (tool.name.includes('${')) continue;
        if (!/\bsideEffect\s*:/.test(tool.block)) missing.push(`${entry.name}/${tool.name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('外部内容通道声明 contentTrust=untrusted', () => {
    const required = [
      'web_search', 'web_fetch', 'web_crawl', 'read_document', 'ocr_image', 'ocr_pdf',
      'browser_snapshot', 'browser_network', 'recall_facts',
      'list_memory_blocks', 'blackboard_get',
    ];
    const blocks = new Map<string, string>();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('@')) continue;
      const file = join(root, entry.name, 'index.ts');
      if (!existsSync(file)) continue;
      for (const tool of toolBlocks(readFileSync(file, 'utf8'))) blocks.set(tool.name, tool.block);
    }
    const missing = required.filter((name) => !new RegExp(`name:\\s*'${name}'`).test(blocks.get(name) ?? '')
      || !/contentTrust:\s*'untrusted'/.test(blocks.get(name) ?? ''));
    assert.deepEqual(missing, []);
    assert.equal(createResultTool().contentTrust, 'untrusted');
    assert.equal(createResultTool().sideEffect, 'read');
  });

  it('长耗时工具声明独立 timeoutMs', () => {
    const required = [
      'read_document', 'ocr_image', 'ocr_pdf', 'web_fetch', 'web_crawl',
      'browser_open', 'browser_download', 'browser_screenshot',
      'repo_map', 'project_diagnostics', 'lsp_definition', 'lsp_hover', 'lsp_diagnostics',
      'mcp_resource_read', 'mcp_prompt_get', 'mcp_reconnect', 'mcp_oauth_complete',
      'mcp_registry_search', 'mcp_registry_install', 'run_subagent', 'run_review', 'run_parallel',
      'analyze_image',
    ];
    const blocks = new Map<string, string>();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('@')) continue;
      const file = join(root, entry.name, 'index.ts');
      if (!existsSync(file)) continue;
      for (const tool of toolBlocks(readFileSync(file, 'utf8'))) blocks.set(tool.name, tool.block);
    }
    const missing = required.filter((name) => !/timeoutMs\s*:/.test(blocks.get(name) ?? ''));
    assert.deepEqual(missing, []);
  });

  it('所有 core 工具声明 outputSchema（生成模板除外）', () => {
    const missing: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('@')) continue;
      const file = join(root, entry.name, 'index.ts');
      if (!existsSync(file)) continue;
      for (const tool of toolBlocks(readFileSync(file, 'utf8'))) {
        if (tool.name.includes('${')) continue;
        if (!/\boutputSchema\s*:/.test(tool.block)) missing.push(`${entry.name}/${tool.name}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
