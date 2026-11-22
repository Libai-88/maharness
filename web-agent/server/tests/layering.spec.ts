import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 白名单只收"取一个错误类型判定函数"这类无编排的引用，且必须写明原因。 */
const SERVICE_IMPORT_WHITELIST: Record<string, string[]> = {
  // 路由需要把组织服务的错误码映射成 HTTP 状态；只引 isOrganizationError，不触发任何编排
  'organization.ts': ['../services/organization/service'],
};

function importsOf(file: string): string[] {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && /^\.\.?\//.test(node.text)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

test('路由层不直接调用业务服务：编排必须经过 usecases（ADR 0010）', () => {
  const directory = join(ROOT, 'routes');
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.ts'))) {
    const allowed = SERVICE_IMPORT_WHITELIST[name] ?? [];
    for (const specifier of importsOf(join(directory, name))) {
      if (!/^\.\.\/services\//.test(specifier)) continue;
      assert.ok(allowed.includes(specifier), `routes/${name} 绕过 usecases 直接依赖 ${specifier}`);
    }
  }
});

test('用例层不碰 HTTP 对象，也不直接 import 能力插件（只能经 kernel 服务接口）', () => {
  const directory = join(ROOT, 'usecases');
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.ts'))) {
    const specifiers = importsOf(join(directory, name));
    assert.ok(!specifiers.includes('express'), `usecases/${name} 不应依赖 express`);
    for (const specifier of specifiers) {
      assert.ok(!/^\.\.\/\.\.\/core\//.test(specifier), `usecases/${name} 直接依赖能力插件：${specifier}`);
    }
  }
});

test('传输工具集中在 http/，路由不再是共享函数的定义处', () => {
  const shared = readFileSync(join(ROOT, 'routes', 'shared.ts'), 'utf8');
  assert.match(shared, /export \* from '\.\.\/http\/scope'/, 'shared.ts 应只做汇总出口');
  assert.doesNotMatch(shared, /export function sse\(/, 'sse 应位于 http/sse.ts');
  assert.doesNotMatch(shared, /export async function assertPublicHttpUrl\(/, 'SSRF 边界应位于 http/security.ts');
});
