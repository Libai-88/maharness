import { isAbsolute, relative, resolve } from 'node:path';

export function pluginFilePath(directory: string, name: string): string {
  const path = resolve(directory, name);
  const rel = relative(directory, path);
  if (!name || name.includes('\\') || name.includes(':') || isAbsolute(name) || !rel || rel.startsWith('..') || rel === 'plugin.json') throw new Error('PLUGIN_FILE_PATH');
  return path;
}

export function assertPluginId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('PLUGIN_ID_INVALID');
}
