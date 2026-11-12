import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codeIntel, { extractSymbols, extractSymbolsForFile } from '../index';

type Tool = { name: string; handler: (args: Record<string, unknown>, ctx: any) => Promise<any> };

function loadTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  (codeIntel as any).onLoad({
    register(value: any) { if (value.kind === 'tool') tools.set(value.tool.name, value.tool); },
    logger: { info() {} },
  });
  return tools;
}

describe('代码智能', () => {
  it('提取 TS/Python 顶层符号', () => {
    const symbols = extractSymbols([
      'export function alpha() {}',
      'export class Beta {}',
      'export const gamma = 1;',
      'def delta(): pass',
      'class Epsilon: pass',
    ].join('\n'));
    assert.deepEqual(symbols.map((s) => s.name).sort(), ['Beta', 'Epsilon', 'alpha', 'delta', 'gamma']);
  });

  it('repo_map 与 find_symbol 在沙箱内工作', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-code-intel-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export function targetAlpha() {}\nexport class TargetBeta {}\n');
      writeFileSync(join(root, 'src', 'b.py'), 'def target_python():\n    pass\n');
      const tools = loadTools();
      const ctx = { sandboxRoot: root, turn: 0, cache: {}, trace: {} };
      const map = await tools.get('repo_map')!.handler({ path: '.' }, ctx);
      assert.equal(map.ok, true);
      assert.match(map.data.text, /targetAlpha/);
      assert.match(map.data.text, /target_python/);
      const found = await tools.get('find_symbol')!.handler({ name: 'target' }, ctx);
      assert.equal(found.ok, true);
      assert.ok(found.data.matches.length >= 3);
      assert.ok(found.data.matches.every((m: any) => !String(m.file).includes('node_modules')));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('TS 文件使用编译器 AST 提取，覆盖箭头常量、接口与默认类', async () => {
    const source = [
      'export const arrow = () => 1;',
      'export interface Shape { x: number }',
      'export default class Widget {}',
      'type Alias = string;',
    ].join('\n');
    const symbols = await extractSymbolsForFile(source, 'demo.ts');
    const names = symbols.map((s) => s.name).sort();
    assert.deepEqual(names, ['Alias', 'Shape', 'Widget', 'arrow']);
  });

  it('Tree-sitter 覆盖 Python / Go / Rust / C# 顶层符号', async () => {
    const cases: [string, string[]][] = [
      ['def alpha():\n    pass\nclass Beta:\n    pass\n', ['alpha', 'Beta']],
      ['package x\nfunc Gamma() {}\ntype Delta struct{}\n', ['Gamma', 'Delta']],
      ['pub fn epsilon() {}\nstruct Zeta;\n', ['epsilon', 'Zeta']],
      ['class Eta {}\n', ['Eta']],
    ];
    const exts = ['.py', '.go', '.rs', '.cs'];
    for (let i = 0; i < cases.length; i++) {
      const [source, expected] = cases[i]!;
      const symbols = await extractSymbolsForFile(source, `sample${exts[i]}`);
      assert.deepEqual(symbols.map((symbol) => symbol.name).sort(), [...expected].sort(), `ext=${exts[i]}`);
    }
  });

  it('project_diagnostics 返回项目内 TypeScript 类型错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-code-intel-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }));
      writeFileSync(join(root, 'src', 'bad.ts'), 'export const count: string = 1;\n');
      const tools = loadTools();
      const result = await tools.get('project_diagnostics')!.handler(
        { path: '.', maxDiagnostics: 20 },
        { sandboxRoot: root, turn: 0, cache: {}, trace: {} },
      );
      assert.equal(result.ok, true, result.error);
      assert.ok(result.data.counts.error >= 1);
      assert.ok(result.data.diagnostics.some((item: any) => item.file === 'src/bad.ts' && item.line === 1));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
