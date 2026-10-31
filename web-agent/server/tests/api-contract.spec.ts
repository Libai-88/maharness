import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { API_CONTRACT_V1, API_SCHEMA_HEADER, API_SCHEMA_VERSION, apiContractFor, setApiSchemaHeaders } from '../api-contract';
import { validateAgainstSchema } from '../../kernel/validate';

describe('API-01 v1 contract registry', () => {
  test('核心端点登记唯一且分类完整', () => {
    assert.ok(API_CONTRACT_V1.length >= 60);
    const keys = API_CONTRACT_V1.map((entry) => `${entry.method} ${entry.path}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const entry of API_CONTRACT_V1) {
      assert.equal(entry.path.startsWith('/api/'), true);
      assert.ok(entry.description.length > 0);
      assert.ok(entry.schema && typeof entry.schema.type !== 'undefined');
    }
  });

  test('成功响应 schema 可执行并支持参数路由归一化', () => {
    const health = apiContractFor('GET', '/api/health');
    assert.ok(health);
    assert.deepEqual(validateAgainstSchema({ ok: true, version: '1.0.0' }, health.schema), []);
    assert.ok(validateAgainstSchema({ version: '1.0.0' }, health.schema).length > 0);
    assert.equal(apiContractFor('GET', '/api/plugins/demo/config')?.path, '/api/plugins/:id/config');
  });

  test('覆盖所有显式核心路由的契约登记', async () => {
    const { readFile } = await import('node:fs/promises');
    const routeFiles = [
      '../routes/index.ts', '../routes/approvals.ts', '../routes/chat.ts', '../routes/commands.ts',
      '../routes/config.ts', '../routes/evolve.ts', '../routes/files.ts', '../routes/git.ts',
      '../routes/personas.ts', '../routes/plugins.ts', '../routes/providers.ts', '../routes/rules.ts',
      '../routes/sessions.ts', '../routes/skills.ts', '../routes/stats.ts', '../routes/trace.ts',
      '../routes/workspaces.ts',
    ];
    const source = (await Promise.all(routeFiles.map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
    const routes = [...source.matchAll(/app\.(get|post|patch|put|delete)\(['"](\/api\/[^'"`]+)['"]/gi)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`);
    const registered = new Set(API_CONTRACT_V1.map((entry) => `${entry.method} ${entry.path}`));
    const missing = routes.filter((route) => !registered.has(route));
    assert.deepEqual([...new Set(missing)], []);
  });

  test('响应版本头与登记版本一致', () => {
    const headers = new Map<string, string>();
    setApiSchemaHeaders({ setHeader: (name, value) => headers.set(name, value) });
    assert.equal(headers.get(API_SCHEMA_HEADER), String(API_SCHEMA_VERSION));
  });
});
