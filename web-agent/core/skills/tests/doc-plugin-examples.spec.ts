import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 文档示例防漂移：README 与内置 plugin-authoring 技能里的插件示例代码
 * 必须走公共 SDK（`kernel/plugin-sdk`），否则照文档写出的插件会被
 * `kernel/tests/dependency-boundary.spec.ts` 判失败。
 */
const files = {
  readme: new URL('../../../README.md', import.meta.url),
  skill: new URL('../builtin/plugin-authoring/SKILL.md', import.meta.url),
};

/** 抽取 Markdown 里 ```ts / ```tsx 代码块 */
function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```(?:ts|tsx)\r?\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1]);
  return blocks;
}

/** 相对 kernel 深层导入（允许 plugin-sdk，拒绝其它 kernel/*） */
function deepKernelImports(code: string): string[] {
  const hits: string[] = [];
  const pattern = /from\s+['"]((?:\.\.\/)+kernel\/([^'"]+))['"]/g;
  for (const match of code.matchAll(pattern)) {
    const target = match[2];
    if (!target.startsWith('plugin-sdk')) hits.push(match[1]);
  }
  return hits;
}

for (const [name, url] of Object.entries(files)) {
  test(`${name} 的插件示例只导入 kernel/plugin-sdk`, () => {
    const markdown = readFileSync(url, 'utf8');
    const offenders = codeBlocks(markdown).flatMap(deepKernelImports);
    assert.deepEqual(offenders, [], `${name} 存在深层 kernel 导入：${offenders.join(', ')}`);
  });
}

test('脚手架模板使用公共 SDK 入口', () => {
  const scaffold = readFileSync(new URL('../../../scripts/plugin-scaffold.mjs', import.meta.url), 'utf8');
  assert.match(scaffold, /kernel\/plugin-sdk/);
  assert.doesNotMatch(scaffold, /kernel\/(types|plugin-loader)\b/);
});
