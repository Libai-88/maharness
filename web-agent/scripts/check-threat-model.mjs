import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagePath = join(root, 'web-agent', 'package.json');
const modelPath = join(root, 'plan', 'threat-model-v1.md');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const model = readFileSync(modelPath, 'utf8');
const securityCommand = packageJson.scripts?.['test:security'];

if (typeof securityCommand !== 'string') {
  throw new Error('package.json must define test:security');
}

const securityFiles = [...securityCommand.matchAll(/(?:^|\s)([\w./-]+\.spec\.ts)(?=\s|$)/g)]
  .map((match) => match[1].replaceAll('\\', '/'));
if (!securityFiles.length) throw new Error('test:security contains no spec files');

const referencedFiles = new Set(
  [...model.matchAll(/`((?:web-agent\/)?[\w./-]+(?:\.ts|\.spec\.ts|\.mjs))`/g)]
    .map((match) => match[1].replaceAll('\\', '/')),
);
const resolvesToFile = (file) => existsSync(join(root, file)) || existsSync(join(root, 'web-agent', file));
const missingFiles = [...referencedFiles].filter((file) => !resolvesToFile(file));
const unmappedSecurityFiles = securityFiles.filter((file) => !referencedFiles.has(file) && !referencedFiles.has(`web-agent/${file}`));

if (missingFiles.length || unmappedSecurityFiles.length) {
  const details = [
    ...missingFiles.map((file) => `威胁模型引用的文件不存在: ${file}`),
    ...unmappedSecurityFiles.map((file) => `test:security 文件未映射到威胁模型: web-agent/${file}`),
  ];
  throw new Error(details.join('\n'));
}

console.log(`Threat model mapping valid: ${referencedFiles.size} referenced files, ${securityFiles.length} security specs.`);
