/** 静态插件审查：在现场插件进入 loader 前拦截明显的越权实现。 */
import { isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';
import { CAPABILITY_IDENTIFIERS } from './capability-identity';

export interface PluginReviewIssue {
  code: 'native-process' | 'raw-filesystem' | 'dynamic-code' | 'secret-access' | 'network-egress' | 'missing-permissions' | 'dependency-policy';
  message: string;
}

export interface PluginReviewResult {
  ok: boolean;
  highRisk: boolean;
  issues: PluginReviewIssue[];
  capabilities: { kind: string; name: string }[];
  capabilityInferenceComplete: boolean;
  dependencies: string[];
}

export interface PluginReviewOptions {
  /** 允许插件直接导入的 npm 包（包名或 @scope/name）；相对导入与安全 Node 内置模块不受此限制。 */
  allowedDependencies?: string[];
}

export interface PluginRuntimeDeclaration {
  filesystem?: 'none' | 'storage' | 'sandbox' | 'full';
  network?: 'none' | 'allowlist' | 'full';
  networkAllowlist?: string[];
  process?: boolean;
}

const RULES: [PluginReviewIssue['code'], RegExp, string][] = [
  ['native-process', /(?:from|require\s*\()\s*['"]node:(?:child_process|worker_threads|cluster)['"]|\b(?:spawn|exec|fork)\s*\(/i, '禁止直接启动或控制宿主进程，请使用受审批的宿主工具'],
  ['raw-filesystem', /(?:from|require\s*\()\s*['"]node:fs['"]|\b(?:readFile|writeFile|rm|mkdir|readdir)Sync?\s*\(/i, '禁止直接访问宿主文件系统，请使用 ctx.storage 或沙箱工具'],
  ['dynamic-code', /\b(?:eval|Function|vm\.runIn(?:New|This)Context)\s*\(/i, '禁止动态执行未审查代码'],
  ['secret-access', /\bprocess\.(?:env|binding|dlopen)\b/i, '禁止直接读取进程环境或原生绑定'],
  ['network-egress', /\b(?:fetch|https?\.request|WebSocket)\s*\(/i, '禁止直接发起网络请求，请使用受策略控制的服务'],
];

/** 允许直接导入的 Node 内置模块：纯计算/格式化，不提供进程、文件、网络或动态代码能力。 */
const SAFE_NODE_BUILTINS = new Set([
  'assert', 'buffer', 'crypto', 'events', 'path', 'querystring', 'stream', 'string_decoder',
  'timers', 'timers/promises', 'url', 'util',
]);

const IMPORT_SPECIFIER_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]|(?:^|[^\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    out.push(specifier);
  }
  return out;
}

/** 从常见 ctx.register 形状提取能力，供权限审查报告使用。 */
function capabilitiesOf(source: string): { capabilities: { kind: string; name: string }[]; complete: boolean } {
  const out: { kind: string; name: string }[] = [];
  let complete = true;
  const tree = ts.createSourceFile('plugin.ts', source, ts.ScriptTarget.Latest, true);
  const property = (node: ts.ObjectLiteralExpression, name: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)?.initializer;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'register') {
      const registration = node.arguments[0];
      if (!registration || !ts.isObjectLiteralExpression(registration)) { complete = false; ts.forEachChild(node, visit); return; }
      const kind = property(registration, 'kind');
      if (kind && ts.isStringLiteral(kind) && Object.hasOwn(CAPABILITY_IDENTIFIERS, kind.text)) {
        const key = kind.text as keyof typeof CAPABILITY_IDENTIFIERS;
        const def = key === 'listener' ? registration : property(registration, key);
        const value = def && ts.isObjectLiteralExpression(def) ? property(def, CAPABILITY_IDENTIFIERS[key]) : undefined;
        if (registration.properties.some(ts.isSpreadAssignment) || def && ts.isObjectLiteralExpression(def) && def.properties.some(ts.isSpreadAssignment)) complete = false;
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          if (!out.some(item => item.kind === key && item.name === value.text)) out.push({ kind: key, name: value.text });
        } else complete = false;
      } else complete = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { capabilities: out, complete };
}

export function reviewPluginSource(
  source: string,
  permissions?: { capabilities?: Record<string, string[]>; dependencies?: string[] },
  options: PluginReviewOptions = {},
): PluginReviewResult {
  const issues: PluginReviewIssue[] = [];
  for (const [code, pattern, message] of RULES) if (pattern.test(source)) issues.push({ code, message });
  const { capabilities, complete } = capabilitiesOf(source);
  const dependencies = importSpecifiers(source).filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'));
  const allowed = new Set((options.allowedDependencies ?? []).map((name) => name.trim()).filter(Boolean));
  for (const dependency of dependencies) {
    const builtin = dependency.replace(/^node:/, '');
    const isBuiltin = dependency.startsWith('node:') || SAFE_NODE_BUILTINS.has(builtin);
    if (isBuiltin) {
      if (SAFE_NODE_BUILTINS.has(builtin)) continue;
      issues.push({ code: 'dependency-policy', message: `禁止直接导入 Node 内置模块 ${dependency}（会绕过宿主权限边界）` });
      continue;
    }
    if ([...allowed].some((name) => dependency === name || dependency.startsWith(`${name}/`))) continue;
    issues.push({ code: 'dependency-policy', message: `插件依赖 ${dependency} 未在 plugins.allowedDependencies 白名单中` });
  }
  if (permissions?.capabilities) {
    for (const cap of capabilities) {
      if (!permissions.capabilities[cap.kind]?.includes(cap.name)) {
        issues.push({ code: 'missing-permissions', message: `能力 ${cap.kind}:${cap.name} 未在 permissions.capabilities 白名单中声明` });
      }
    }
  }
  return {
    ok: issues.length === 0,
    highRisk: issues.some((i) => i.code !== 'missing-permissions' && i.code !== 'dependency-policy'),
    issues, capabilities, capabilityInferenceComplete: complete, dependencies,
  };
}

/** 对直接写入 plugins/ 的源码执行同一套审查；非插件路径/非源码文件返回 null。 */
export function reviewPluginWrite(
  sandboxRoot: string,
  file: string,
  source: string,
  options: PluginReviewOptions = {},
): PluginReviewResult | null {
  const rel = relative(join(sandboxRoot, 'plugins'), file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file)) return null;
  return reviewPluginSource(source, undefined, options);
}

/** 对声明了 permissions.runtime 的插件执行运行时能力审查。
 *  静态可证明的越界在加载前拒绝；未声明的旧插件走 trusted 兼容路径。 */
export function reviewPluginRuntimeSource(
  source: string,
  runtime: PluginRuntimeDeclaration,
  options: PluginReviewOptions = {},
): PluginReviewResult {
  const base = reviewPluginSource(source, undefined, options);
  const issues = base.issues.filter((issue) => {
    if (issue.code === 'dependency-policy') {
      if (runtime.filesystem === 'full' && /\bnode:fs\b/.test(issue.message)) return false;
      if (runtime.process === true && /\bnode:(?:child_process|worker_threads|cluster)\b/.test(issue.message)) return false;
      if ((runtime.network === 'full' || runtime.network === 'allowlist')
        && /\bnode:(?:http|https|net|tls|dns|dgram)\b/.test(issue.message)) return false;
      return true;
    }
    if (issue.code === 'raw-filesystem') return runtime.filesystem !== 'full';
    if (issue.code === 'network-egress') return runtime.network !== 'full' && runtime.network !== 'allowlist';
    if (issue.code === 'native-process') return runtime.process !== true;
    return true;
  });
  return {
    ...base,
    ok: issues.length === 0,
    issues,
    highRisk: issues.some((issue) => issue.code !== 'missing-permissions' && issue.code !== 'dependency-policy'),
  };
}
