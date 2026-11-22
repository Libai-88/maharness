/**
 * kernel/plugin-manifest.ts —— 插件清单的校验面（从 plugin-loader 拆出的纯逻辑）
 *
 * 这里只放“读一份 manifest，判断它是否合法”的规则：版本兼容、权限形状、
 * capabilityIndex 引用、limits、process 执行模式、runtime 权限。
 * 不含任何运行时状态（加载器、实例表、热重载），便于被 loader、self-extend
 * 与脚本复用，也便于单测直接打靶。
 */
import { capabilityName } from './capability-identity';
import type { Capability, CapabilityDescriptor, PluginManifest } from './types';

const CAPABILITY_KINDS = new Set<Capability['kind']>([
  'tool',
  'listener',
  'command',
  'provider',
  'service',
  'persona',
  'context',
  'role',
  'api',
]);

/** 插件清单兼容的宿主 API 版本；v2 清单通过适配层继续运行。 */
export const PLUGIN_API_VERSION = '3.0.0';
export const LEGACY_PLUGIN_API_VERSION = '2.0.0';

function semver(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function validateManifestCompatibility(manifest: PluginManifest): void {
  if (manifest.apiVersion !== 2 && manifest.apiVersion !== 3) {
    throw new Error(`插件 ${manifest.id} 必须使用 apiVersion: 2 或 3`);
  }
  const range = manifest.compatibility?.api;
  if (range === undefined) return;
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new Error(`插件 ${manifest.id} compatibility.api 必须是对象`);
  }
  const min = range.min === undefined ? undefined : semver(range.min);
  const max = range.max === undefined ? undefined : semver(range.max);
  if ((range.min !== undefined && !min) || (range.max !== undefined && !max)) {
    throw new Error(`插件 ${manifest.id} compatibility.api.min/max 必须是完整 semver（例如 1.0.0）`);
  }
  if (min && max && compareVersion(min, max) > 0) {
    throw new Error(`插件 ${manifest.id} compatibility.api.min 不能高于 max`);
  }
  const host = semver(manifest.apiVersion === 2 ? LEGACY_PLUGIN_API_VERSION : PLUGIN_API_VERSION)!;
  if ((min && compareVersion(host, min) < 0) || (max && compareVersion(host, max) > 0)) {
    throw new Error(`插件 ${manifest.id} 不兼容宿主插件 API ${PLUGIN_API_VERSION}`);
  }
}

function validateCapabilityIndex(manifest: PluginManifest): void {
  if (manifest.apiVersion === 2) {
    if (manifest.capabilityIndex !== undefined) throw new Error(`插件 ${manifest.id} 的 capabilityIndex 需要 apiVersion: 3`);
    return;
  }
  if (manifest.capabilityIndex === undefined) return;
  if (!Array.isArray(manifest.capabilityIndex)) throw new Error(`插件 ${manifest.id} capabilityIndex 必须是数组`);
  const ids = new Set<string>();
  const tools = new Set(manifest.permissions.capabilities.tool ?? []);
  for (const item of manifest.capabilityIndex as CapabilityDescriptor[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      typeof item.description !== 'string' ||
      !item.description.trim() ||
      !Array.isArray(item.tools) ||
      !item.tools.length ||
      item.tools.some((tool) => typeof tool !== 'string' || !tool.trim())
    ) {
      throw new Error(`插件 ${manifest.id} 的 capabilityIndex 项必须包含 id、name、description 和 tools`);
    }
    if (ids.has(item.id)) throw new Error(`插件 ${manifest.id} capabilityIndex.id 重复: ${item.id}`);
    ids.add(item.id);
    for (const tool of item.tools) {
      if (!tools.has(tool) && !tools.has('*')) {
        throw new Error(`插件 ${manifest.id} capabilityIndex ${item.id} 引用了未授权工具 ${tool}`);
      }
    }
  }
}

function validatePermissions(manifest: PluginManifest): void {
  if (manifest.permissions === undefined) throw new Error(`插件 ${manifest.id} 必须声明 permissions.capabilities`);
  const caps = manifest.permissions?.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new Error(`插件 ${manifest.id} permissions.capabilities 必须是对象`);
  for (const [kind, names] of Object.entries(caps)) {
    if (!CAPABILITY_KINDS.has(kind as Capability['kind'])) throw new Error(`插件 ${manifest.id} 声明了未知 capability 类型: ${kind}`);
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`插件 ${manifest.id} permissions.capabilities.${kind} 必须是字符串数组`);
    }
  }
}

function validateManifestLimits(manifest: PluginManifest): void {
  const limits = manifest.limits;
  if (!limits) return;
  for (const [key, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`插件 ${manifest.id} limits.${key} 必须是非负整数`);
    }
  }
}

function validateManifestExecution(manifest: PluginManifest): void {
  const execution = manifest.execution;
  if (execution === undefined) return;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error(`插件 ${manifest.id} execution 必须是对象`);
  }
  if (execution.mode !== 'process') {
    throw new Error(`插件 ${manifest.id} execution.mode 仅支持 process`);
  }
  if (execution.memoryMb !== undefined && (!Number.isInteger(execution.memoryMb) || execution.memoryMb < 32 || execution.memoryMb > 2048)) {
    throw new Error(`插件 ${manifest.id} execution.memoryMb 必须是 32..2048 的整数`);
  }
  if (
    execution.timeoutMs !== undefined &&
    (!Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1_000 || execution.timeoutMs > 300_000)
  ) {
    throw new Error(`插件 ${manifest.id} execution.timeoutMs 必须是 1000..300000 的整数`);
  }
  const caps = manifest.permissions?.capabilities;
  if (!caps?.tool?.length) {
    throw new Error(`插件 ${manifest.id} 使用 process 执行时必须声明 permissions.capabilities.tool`);
  }
  for (const kind of Object.keys(caps)) {
    if (kind !== 'tool' && Array.isArray((caps as Record<string, unknown>)[kind])) {
      throw new Error(`插件 ${manifest.id} 的 process 执行仅支持 tool 能力，不能声明 ${kind}`);
    }
  }
  if (manifest.nav || manifest.api || manifest.provides?.length) {
    throw new Error(`插件 ${manifest.id} 的 process 执行不支持 nav/api/provides`);
  }
}

export function validatePluginManifest(manifest: PluginManifest): void {
  validateManifestCompatibility(manifest);
  validatePermissions(manifest);
  validateCapabilityIndex(manifest);
  validateManifestLimits(manifest);
  validateManifestExecution(manifest);
  validateRuntimePermissions(manifest);
}

/** Compatibility metadata added to v3 tool discovery without changing execution permissions. */
export function capabilityDiscoveryOf(manifest: PluginManifest, toolName: string): CapabilityDescriptor[] {
  return (manifest.capabilityIndex ?? []).filter((item) => item.tools.includes(toolName));
}

export function validateRuntimePermissions(manifest: PluginManifest): void {
  const runtime = manifest.permissions?.runtime;
  if (runtime === undefined) return;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error(`插件 ${manifest.id} permissions.runtime 必须是对象`);
  }
  if (runtime.filesystem !== undefined && !['none', 'storage', 'sandbox', 'full'].includes(runtime.filesystem)) {
    throw new Error(`插件 ${manifest.id} permissions.runtime.filesystem 不受支持`);
  }
  if (runtime.filesystem !== undefined && runtime.filesystem !== 'full' && manifest.execution?.mode !== 'process') {
    throw new Error(`插件 ${manifest.id} 的 filesystem=${runtime.filesystem} 需要 execution.mode=process 才能执行路径策略`);
  }
  if (runtime.network !== undefined && !['none', 'allowlist', 'full'].includes(runtime.network)) {
    throw new Error(`插件 ${manifest.id} permissions.runtime.network 不受支持`);
  }
  if (runtime.networkAllowlist !== undefined) {
    if (!Array.isArray(runtime.networkAllowlist) || runtime.networkAllowlist.some((host) => typeof host !== 'string' || !host.trim())) {
      throw new Error(`插件 ${manifest.id} permissions.runtime.networkAllowlist 必须是非空字符串数组`);
    }
    if (runtime.network !== 'allowlist') {
      throw new Error(`插件 ${manifest.id} networkAllowlist 仅在 runtime.network=allowlist 时有效`);
    }
  }
  if (runtime.network === 'allowlist') {
    if (manifest.execution?.mode !== 'process') {
      throw new Error(`插件 ${manifest.id} 的 network=allowlist 需要 execution.mode=process 才能执行出口策略`);
    }
    if (!runtime.networkAllowlist?.length) {
      throw new Error(`插件 ${manifest.id} 的 network=allowlist 必须提供 networkAllowlist`);
    }
  }
  if (runtime.process !== undefined && typeof runtime.process !== 'boolean') {
    throw new Error(`插件 ${manifest.id} permissions.runtime.process 必须是布尔值`);
  }
}

export function assertCapabilityPermission(manifest: PluginManifest, cap: Capability): void {
  if (cap.kind === 'tool') {
    const tool = cap.tool;
    if (
      !semver(tool.version) ||
      !tool.description ||
      !tool.parameters ||
      !tool.outputSchema ||
      !['none', 'read', 'write', 'external', 'irreversible'].includes(tool.sideEffect ?? '') ||
      !Array.isArray(tool.permissions) ||
      tool.permissions.some((p) => !['workspace.read', 'workspace.write', 'network', 'process', 'delegate', 'admin'].includes(p))
    )
      throw new Error(`工具 ${tool.name} 缺少有效的 v2 版本、schema、副作用或权限声明`);
  }
  if (manifest.permissions === undefined) return;
  const name = capabilityName(cap);
  const allowed = manifest.permissions.capabilities[cap.kind];
  if (!allowed?.includes(name) && !allowed?.includes('*')) {
    throw new Error(`插件 ${manifest.id} 未获准注册 capability ${cap.kind}:${name}`);
  }
}
