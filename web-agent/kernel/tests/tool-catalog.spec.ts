import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolConflicts, type ToolCatalogEntry } from '../plugin-loader';
import { toolDomain } from '../tool-domain';
import type { ToolDef } from '../types';

function tool(name: string): ToolDef {
  return {version: '2.0.0', permissions: [], sideEffect: 'external', outputSchema: {},  name, description: name, parameters: { type: 'object', properties: {} }, async handler() { return { ok: true }; } };
}

describe('tool catalog conflict resolution', () => {
  it('工具能力域映射稳定', () => {
    assert.equal(toolDomain('read_file'), 'Files');
    assert.equal(toolDomain('web_fetch'), 'Research');
    assert.equal(toolDomain('mcp_demo_search'), 'MCP');
    assert.equal(toolDomain('todo_add'), 'Tasks');
    assert.equal(toolDomain('run_parallel'), 'Agents');
    assert.equal(toolDomain('unknown_tool'), 'General');
  });

  it('同名工具保留内置、遮蔽 MCP', () => {
    const entries: ToolCatalogEntry[] = [
      { pluginId: 'core-search', tool: tool('search') },
      { pluginId: 'mcp', tool: tool('search') },
    ];
    const resolved = resolveToolConflicts(entries);
    assert.equal(resolved[0].shadowedBy, undefined);
    assert.equal(resolved[1].shadowedBy, 'core-search');
  });

  it('同为内置时按插件 id 稳定保留首个', () => {
    const entries: ToolCatalogEntry[] = [
      { pluginId: 'a-plugin', tool: tool('shared') },
      { pluginId: 'b-plugin', tool: tool('shared') },
    ];
    const resolved = resolveToolConflicts(entries);
    assert.equal(resolved[0].shadowedBy, undefined);
    assert.equal(resolved[1].shadowedBy, 'a-plugin');
  });

  it('不同名工具互不影响', () => {
    const resolved = resolveToolConflicts([
      { pluginId: 'a', tool: tool('one') },
      { pluginId: 'b', tool: tool('two') },
    ]);
    assert.equal(resolved.every((entry) => !entry.shadowedBy), true);
  });
});
