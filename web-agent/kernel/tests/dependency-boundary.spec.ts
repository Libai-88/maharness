import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('kernel imports mechanisms and contracts without depending on feature plugins or UI', () => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  for (const file of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const tree = ts.createSourceFile(file, readFileSync(join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && /^(?:\.\.\/)+(?:core|server|ui)\//.test(node.text)) assert.fail(`${file} crosses kernel boundary: ${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
});

test('core and plugin source files use the plugin SDK instead of deep kernel imports', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const snapshot = /@[0-9a-f]{10}$/;

  const inspectFile = (file: string): void => {
    if (file.endsWith('.spec.ts')) return;
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && /^(?:\.\.\/)+kernel\/(?!plugin-sdk(?:\/|$))/.test(node.text)) {
        assert.fail(`${file} bypasses plugin-sdk: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (snapshot.test(entry.name) || entry.name === 'node_modules' || entry.name === 'tests') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        inspectFile(full);
      }
    }
  };
  walk(join(root, 'core'));
  walk(join(root, 'plugins'));
});
