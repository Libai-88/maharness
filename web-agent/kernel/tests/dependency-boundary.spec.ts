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
