/** 静态插件审查：在现场插件进入 loader 前拦截明显的越权实现。 */

export interface PluginReviewIssue {
  code: 'native-process' | 'raw-filesystem' | 'dynamic-code' | 'secret-access' | 'network-egress' | 'missing-permissions';
  message: string;
}

export interface PluginReviewResult {
  ok: boolean;
  highRisk: boolean;
  issues: PluginReviewIssue[];
  capabilities: { kind: string; name: string }[];
}

const RULES: [PluginReviewIssue['code'], RegExp, string][] = [
  ['native-process', /(?:from|require\s*\()\s*['"]node:(?:child_process|worker_threads|cluster)['"]|\b(?:spawn|exec|fork)\s*\(/i, '禁止直接启动或控制宿主进程，请使用受审批的宿主工具'],
  ['raw-filesystem', /(?:from|require\s*\()\s*['"]node:fs['"]|\b(?:readFile|writeFile|rm|mkdir|readdir)Sync?\s*\(/i, '禁止直接访问宿主文件系统，请使用 ctx.storage 或沙箱工具'],
  ['dynamic-code', /\b(?:eval|Function|vm\.runIn(?:New|This)Context)\s*\(/i, '禁止动态执行未审查代码'],
  ['secret-access', /\bprocess\.(?:env|binding|dlopen)\b/i, '禁止直接读取进程环境或原生绑定'],
  ['network-egress', /\b(?:fetch|https?\.request|WebSocket)\s*\(/i, '禁止直接发起网络请求，请使用受策略控制的服务'],
];

/** 从常见 ctx.register 形状提取能力，供权限审查报告使用。 */
function capabilitiesOf(source: string): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = [];
  const re = /kind\s*:\s*['"]([a-z]+)['"][\s\S]{0,700}?name\s*:\s*['"]([A-Za-z0-9_.-]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const item = { kind: m[1], name: m[2] };
    if (!out.some((x) => x.kind === item.kind && x.name === item.name)) out.push(item);
  }
  return out;
}

export function reviewPluginSource(source: string, permissions?: { capabilities?: Record<string, string[]> }): PluginReviewResult {
  const issues: PluginReviewIssue[] = [];
  for (const [code, pattern, message] of RULES) if (pattern.test(source)) issues.push({ code, message });
  const capabilities = capabilitiesOf(source);
  if (permissions?.capabilities) {
    for (const cap of capabilities) {
      if (!permissions.capabilities[cap.kind]?.includes(cap.name)) {
        issues.push({ code: 'missing-permissions', message: `能力 ${cap.kind}:${cap.name} 未在 permissions.capabilities 白名单中声明` });
      }
    }
  }
  return { ok: issues.length === 0, highRisk: issues.some((i) => i.code !== 'missing-permissions'), issues, capabilities };
}
