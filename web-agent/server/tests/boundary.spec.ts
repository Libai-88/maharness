import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'test-results' || entry.name === 'tests') return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const ALLOWED_ADAPTERS = [
  'host/adapters/chat.ts',
  'host/adapters/document.ts',
  'host/adapters/goal-plan.ts',
  'host/adapters/items.ts',
  'host/adapters/skills.ts',
];

test('server reaches core only through explicit host adapters', () => {
  const allowed = new Set(ALLOWED_ADAPTERS);
  for (const file of files(serverRoot)) {
    const rel = relative(serverRoot, file).replaceAll('\\', '/');
    if (allowed.has(rel)) continue;
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && /^(?:\.\.\/)+core\//.test(node.text)) {
        assert.fail(`${rel} imports core directly: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
});

test('host adapters are the only server files allowed to import core internals', () => {
  const adapters = files(join(serverRoot, 'host', 'adapters'));
  assert.deepEqual(adapters.map(file => relative(serverRoot, file).replaceAll('\\', '/')).sort(), [...ALLOWED_ADAPTERS].sort());
});