/**
 * Plugin scaffold and manifest validator.
 *
 * Usage:
 *   node scripts/plugin-scaffold.mjs create <plugin-id> [plugins-dir]
 *   node scripts/plugin-scaffold.mjs validate [plugin-dir...]
 *   (with no plugin-dir, every top-level plugin under plugins/ is validated)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_PLUGIN_API = '3.0.0';
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function compareVersion(a, b) {
  const av = a.split('.').map(Number);
  const bv = b.split('.').map(Number);
  return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
}

function manifestTemplate(id) {
  const toolName = `${id}_hello`;
  return {
    id,
    apiVersion: 3,
    name: id,
    version: '0.1.0',
    entry: 'index.ts',
    compatibility: { api: { min: HOST_PLUGIN_API, max: HOST_PLUGIN_API } },
    permissions: { capabilities: { tool: [toolName] } },
  };
}

function sourceTemplate(id) {
  const toolName = `${id}_hello`;
  return `import type { Plugin } from '../../kernel/plugin-sdk';

export default {
  id: '${id}',
  name: '${id}',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'tool',
      tool: {
        version: '3.0.0',
        permissions: [],
        name: '${toolName}',
        description: 'Return a health response for the ${id} plugin.',
        sideEffect: 'none',
        parameters: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          required: ['plugin', 'status'],
          properties: { plugin: { type: 'string' }, status: { type: 'string' } },
        },
        async handler() {
          return { ok: true, data: { plugin: '${id}', status: 'ok' } };
        },
      },
    });
  },
} satisfies Plugin;
`;
}

export function validatePlugin(pluginDir) {
  const errors = [];
  const root = resolve(pluginDir);
  const manifestPath = join(root, 'plugin.json');
  if (!existsSync(manifestPath)) return ['缺少 plugin.json'];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return ['plugin.json 不是有效 JSON'];
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest 必须是对象'];
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) errors.push('id 必须匹配 /^[a-z][a-z0-9-]{1,63}$/');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name 必须是非空字符串');
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) errors.push('version 必须是完整 semver');
  if (typeof manifest.entry !== 'string' || !manifest.entry || isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes('..')) {
    errors.push('entry 必须是插件目录内的相对路径');
  } else if (!existsSync(join(root, manifest.entry))) {
    errors.push(`入口文件不存在: ${manifest.entry}`);
  }
  const api = manifest.compatibility?.api;
  if (api !== undefined) {
    if (!api || typeof api !== 'object' || Array.isArray(api)) errors.push('compatibility.api 必须是对象');
    else {
      if (api.min !== undefined && (typeof api.min !== 'string' || !SEMVER_RE.test(api.min)))
        errors.push('compatibility.api.min 必须是完整 semver');
      if (api.max !== undefined && (typeof api.max !== 'string' || !SEMVER_RE.test(api.max)))
        errors.push('compatibility.api.max 必须是完整 semver');
      if (typeof api.min === 'string' && typeof api.max === 'string' && compareVersion(api.min, api.max) > 0)
        errors.push('compatibility.api.min 不能高于 max');
      if (typeof api.min === 'string' && compareVersion(HOST_PLUGIN_API, api.min) < 0) errors.push(`不兼容宿主插件 API ${HOST_PLUGIN_API}`);
      if (typeof api.max === 'string' && compareVersion(HOST_PLUGIN_API, api.max) > 0) errors.push(`不兼容宿主插件 API ${HOST_PLUGIN_API}`);
    }
  }
  if (manifest.apiVersion !== 3) errors.push('新插件需要 apiVersion: 3');
  const caps = manifest.permissions?.capabilities;
  if (manifest.permissions !== undefined && (!caps || typeof caps !== 'object' || Array.isArray(caps)))
    errors.push('permissions.capabilities 必须是对象');
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    for (const [kind, names] of Object.entries(caps)) {
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim()))
        errors.push(`permissions.capabilities.${kind} 必须是字符串数组`);
    }
  }
  return errors;
}

export function createPlugin(id, pluginsDir) {
  if (!ID_RE.test(id)) throw new Error('插件 id 必须匹配 /^[a-z][a-z0-9-]{1,63}$/');
  const root = resolve(pluginsDir, id);
  if (existsSync(root)) throw new Error(`目标目录已存在: ${root}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), `${JSON.stringify(manifestTemplate(id), null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'index.ts'), sourceTemplate(id), 'utf8');
  return root;
}

function usage() {
  console.error('用法：node scripts/plugin-scaffold.mjs create <plugin-id> [plugins-dir]');
  console.error('      node scripts/plugin-scaffold.mjs validate [plugin-dir...]');
}

const defaultPluginsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');

function defaultPluginDirs() {
  if (!existsSync(defaultPluginsDir)) return [];
  return readdirSync(defaultPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/@[0-9a-f]{10}$/.test(entry.name))
    .map((entry) => join(defaultPluginsDir, entry.name))
    .filter((dir) => existsSync(join(dir, 'plugin.json')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, ...values] = process.argv;
  try {
    if (command === 'create' && values[0]) {
      const root = createPlugin(values[0], values[1] ?? defaultPluginsDir);
      console.log(`已生成插件: ${root}`);
      console.log('下一步：npm run plugin:validate -- ' + root);
    } else if (command === 'validate') {
      const dirs = values.length ? values : defaultPluginDirs();
      if (!dirs.length) {
        console.error('✗ 没有可校验的插件目录');
        process.exitCode = 1;
      } else {
        let failed = false;
        for (const dir of dirs) {
          const errors = validatePlugin(dir);
          if (errors.length) {
            failed = true;
            console.error(errors.map((error) => `✗ ${dir}: ${error}`).join('\n'));
          } else console.log(`✓ 插件 manifest 有效: ${resolve(dir)}`);
        }
        if (failed) process.exitCode = 1;
      }
    } else {
      usage();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
