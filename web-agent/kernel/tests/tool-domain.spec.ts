import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankToolsForTask, toolDomain } from '../tool-domain';

const tools = [
  { name: 'read_file' },
  { name: 'web_search' },
  { name: 'browser_open' },
  { name: 'create_plan' },
  { name: 'remember_fact' },
];

describe('工具能力域与任务相关排序', () => {
  it('能力域映射稳定', () => {
    assert.equal(toolDomain('web_search'), 'Research');
    assert.equal(toolDomain('browser_open'), 'Browser');
    assert.equal(toolDomain('read_file'), 'Files');
    assert.equal(toolDomain('mcp_github_search'), 'MCP');
  });

  it('按任务把相关域排到前面，但不删除任何工具', () => {
    const research = rankToolsForTask(tools, '帮我搜索网页资料');
    assert.equal(research[0]?.name, 'web_search');
    assert.equal(research.length, tools.length);
    assert.deepEqual(new Set(research.map((tool) => tool.name)), new Set(tools.map((tool) => tool.name)));

    const files = rankToolsForTask(tools, '读取文件并编辑路径');
    assert.equal(files[0]?.name, 'read_file');
  });

  it('无任务文本时保持原顺序', () => {
    assert.deepEqual(rankToolsForTask(tools, '').map((tool) => tool.name), tools.map((tool) => tool.name));
  });
});
