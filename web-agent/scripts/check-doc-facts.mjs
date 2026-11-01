/**
 * scripts/check-doc-facts.mjs —— 契约文档事实校验（DX-02）
 * 核对 api-contract-v1.md 引用的契约字段与 server/api-contract.ts 的 schema
 * 登记一致。漂移时抛错，使 CI 阻断合并。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = readFileSync(join(root, 'plan', 'api-contract-v1.md'), 'utf8');
const contract = readFileSync(join(root, 'web-agent', 'server', 'api-contract.ts'), 'utf8');

const required = ['bind', 'deployMode', 'tls', 'mutationAuthRequired', 'mutationTokenHeader', 'approvalTokenRequired'];
const missing = required.filter((field) => !doc.includes(field));
if (missing.length) {
  throw new Error(`api-contract-v1.md 未引用契约字段: ${missing.join(', ')}`);
}
for (const field of required) {
  if (!contract.includes(`'${field}'`)) {
    throw new Error(`api-contract.ts 的 GET /api/security schema 未登记字段: ${field}`);
  }
}
console.log(`Doc fact check passed: ${required.length} contract fields verified in api-contract-v1.md.`);
