/**
 * kernel/rules.ts —— 用户规则加载与策略匹配（纯函数，零依赖，可单测）
 * 两类规则：
 *  1. 提示规则（prompt）：Markdown 文件，按「全局 → 项目」顺序拼进系统提示词，
 *     全局来自 data/rules/*.md，项目来自 AGENTS.md / CLAUDE.md / .claude/CLAUDE.md / .maharness/rules/*.md；
 *  2. 策略规则（policy）：JSON 声明式审批策略（allow / deny / require-approval），
 *     由执行器在工具调用前匹配，allow 放行本需审批的调用（留痕），deny 直接拦截。
 * 规则文件是事实源（可 git 版本化、可人工审阅），DB 不参与。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { matchesGlob } from './fssearch';
import type { RuleDescriptor, RuleResolution } from './types';

export const RUNTIME_RULE_TEXT = '运行时不变量：工具授权、审批、取消、预算与安全问题不可被规则文件覆盖。';

export function runtimeRuleDescriptor(): RuleDescriptor {
  return {
    id: 'runtime:invariants',
    label: '运行时不变量',
    source: 'runtime',
    scope: 'runtime',
    priority: 1000,
    trust: 'core',
    contentHash: createHash('sha256').update(RUNTIME_RULE_TEXT).digest('hex'),
    active: true,
  };
}

/** Map user-context layers to stable rule provenance without letting plugin guidance become user authority. */
export function personaRuleDescriptor(
  message: { context?: { id?: string; source?: string }; content?: string | null },
  index: number,
): RuleDescriptor {
  const source = message.context?.source ?? '';
  const kind = source.startsWith('user-persistent:') ? 'user' : source.startsWith('skill-guidance:') ? 'skill' : 'plugin';
  return {
    id: `persona:${message.context?.id ?? index}`,
    label: source || `persona-${index + 1}`,
    source: kind,
    scope: 'workspace',
    priority: kind === 'user' ? 75 : kind === 'skill' ? 60 : 55,
    trust: kind === 'user' ? 'user' : 'reference',
    contentHash: createHash('sha256')
      .update(message.content ?? '')
      .digest('hex'),
    active: true,
  };
}

export interface RuleSource {
  scope: 'global' | 'project';
  label: string;
  file: string;
  exists: boolean;
  chars: number;
  mtimeMs: number;
  priority: number;
  trust: 'user';
  contentHash: string;
}

export interface PromptRulesResult {
  /** 已按顺序拼装的规则正文（含来源标题）；无规则时为空串 */
  text: string;
  /** 按原始文件拆分后的上下文，避免全局与项目规则在模型侧失去来源边界。 */
  segments: { text: string; descriptor: RuleDescriptor }[];
  sources: RuleSource[];
  truncated: boolean;
  resolution: RuleResolution;
  /** 供 UI 展示的可编辑目标 */
  editable: { scope: 'global' | 'project'; defaultFile: string; candidates: string[] };
}

/** Deterministic source-aware resolution. Duplicate text is kept once; higher-priority sources win. */
export function resolveRuleDescriptors(input: RuleDescriptor[]): RuleResolution {
  const ordered = [...input].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const hashes = new Map<string, RuleDescriptor>();
  const applied: RuleDescriptor[] = [];
  const ignored: RuleDescriptor[] = [];
  const conflicts: RuleResolution['conflicts'] = [];
  for (const item of ordered) {
    if (!item.active) {
      ignored.push(item);
      continue;
    }
    const prior = hashes.get(item.contentHash);
    if (prior) {
      ignored.push(item);
      conflicts.push({ left: prior.id, right: item.id, reason: 'same_content_duplicate', winner: prior.id });
      continue;
    }
    hashes.set(item.contentHash, item);
    applied.push(item);
  }
  return { schemaVersion: 1, applied, ignored, conflicts };
}

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny' | 'require-approval';
  /** 工具名（精确，或 glob 如 read_*） */
  tool: string;
  /** 对参数 JSON 序列化后的正则（可选） */
  argPattern?: string;
  /** 对 args.path / args.file / args.command 里路径的 glob（可选） */
  pathPattern?: string;
  reason?: string;
  enabled?: boolean;
}

const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.agents/AGENTS.md'];
const PROJECT_RULES_DIR = '.maharness/rules';

function readIfExists(file: string): { text: string; mtimeMs: number } | null {
  try {
    if (!existsSync(file)) return null;
    const st = statSync(file);
    if (!st.isFile()) return null;
    return { text: readFileSync(file, 'utf-8'), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function mdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** 剥离 YAML frontmatter：规则文件常被当作技能/文档复用，头部元数据不该进提示词 */
function stripFrontMatter(md: string): string {
  const t = md.replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(t)) return t.trim();
  const after = t.slice(t.indexOf('\n') + 1);
  const end = /^---[ \t]*$/m.exec(after);
  if (!end || end.index === undefined) return t.trim();
  return after
    .slice(end.index + end[0].length)
    .replace(/^\r?\n/, '')
    .trim();
}

const renderRuleSegment = (scope: 'global' | 'project', label: string, text: string) =>
  `【${scope === 'project' ? '项目规则' : '全局规则'}·${label}】\n${text}`;

/**
 * 加载提示规则。maxChars 为总预算（超出按「项目优先于全局」反向裁剪）。
 * now 用于测试注入。
 */
export function loadPromptRules(opts: { dataDir: string; projectRoot: string; maxChars?: number }): PromptRulesResult {
  const maxChars = opts.maxChars ?? 12_000;
  const collected: { scope: 'global' | 'project'; label: string; file: string; text: string; source: RuleSource }[] = [];
  const sources: RuleSource[] = [];

  const pushFile = (scope: 'global' | 'project', file: string, label: string) => {
    const r = readIfExists(file);
    const abs = resolve(file);
    const text = r ? stripFrontMatter(r.text) : '';
    const source: RuleSource = {
      scope,
      label,
      file: abs,
      exists: !!r,
      chars: r ? r.text.length : 0,
      mtimeMs: r?.mtimeMs ?? 0,
      priority: scope === 'project' ? 80 : 70,
      trust: 'user',
      contentHash: createHash('sha256').update(text).digest('hex'),
    };
    sources.push(source);
    if (!r) return;
    if (text) collected.push({ scope, label, file: abs, text, source });
  };

  const globalDir = join(opts.dataDir, 'rules');
  for (const f of mdFilesIn(globalDir)) pushFile('global', f, `${f.split(/[\\/]/).pop()}`);
  const root = resolve(opts.projectRoot);
  for (const rel of PROJECT_CANDIDATES) pushFile('project', join(root, rel), rel);
  for (const f of mdFilesIn(join(root, PROJECT_RULES_DIR))) pushFile('project', f, `${PROJECT_RULES_DIR}/${f.split(/[\\/]/).pop()}`);

  let budget = maxChars;
  let truncated = false;
  // 项目规则更具体、更该保留：先项目后全局
  const ordered = [...collected.filter((c) => c.scope === 'project'), ...collected.filter((c) => c.scope === 'global')];
  const kept: typeof ordered = [];
  const consideredFiles = new Set<string>();
  const selectedHashes = new Map<string, string>();
  for (const c of ordered) {
    const winnerFile = selectedHashes.get(c.source.contentHash);
    if (winnerFile) {
      // Keep the source active so resolution can report the duplicate and its winner.
      if (consideredFiles.has(winnerFile)) consideredFiles.add(c.source.file);
      continue;
    }
    selectedHashes.set(c.source.contentHash, c.source.file);
    const separatorLength = kept.length ? 2 : 0;
    const renderedLength = renderRuleSegment(c.scope, c.label, c.text).length;
    if (separatorLength + renderedLength <= budget) {
      kept.push(c);
      consideredFiles.add(c.source.file);
      budget -= separatorLength + renderedLength;
      continue;
    }
    const marker = '\n…（该规则文件已按预算截断）';
    const available = budget - separatorLength - renderRuleSegment(c.scope, c.label, '').length - marker.length;
    if (available > 400) {
      const segment = { ...c, text: `${c.text.slice(0, available)}${marker}` };
      kept.push(segment);
      consideredFiles.add(c.source.file);
      truncated = true;
      budget -= separatorLength + renderRuleSegment(segment.scope, segment.label, segment.text).length;
    } else truncated = true;
  }
  const text = kept.map((c) => renderRuleSegment(c.scope, c.label, c.text)).join('\n\n');
  const descriptors = sources.map((source) => ({
    id: `rules:${source.scope}:${source.label}:${source.contentHash.slice(0, 8)}`,
    label: source.label,
    source: source.scope === 'project' ? ('project' as const) : ('user' as const),
    scope: 'workspace' as const,
    priority: source.priority,
    trust: source.trust,
    contentHash: source.contentHash,
    active: source.exists && consideredFiles.has(source.file),
  }));
  return {
    text,
    segments: kept.map((segment) => ({
      text: renderRuleSegment(segment.scope, segment.label, segment.text),
      descriptor: descriptors.find(
        (descriptor) => descriptor.id === `rules:${segment.scope}:${segment.label}:${segment.source.contentHash.slice(0, 8)}`,
      )!,
    })),
    sources,
    truncated,
    resolution: resolveRuleDescriptors(descriptors),
    editable: {
      scope: 'project',
      defaultFile: join(root, 'AGENTS.md'),
      candidates: PROJECT_CANDIDATES.map((rel) => join(root, rel)),
    },
  };
}

/** 规则集指纹（文件路径+mtime），供插件做惰性重载 */
export function rulesSignature(sources: RuleSource[]): string {
  return sources.map((s) => `${s.file}:${s.exists ? 1 : 0}:${s.mtimeMs}:${s.chars}`).join('|');
}

/** 加载策略规则 JSON（多文件合并，后加载者优先；解析失败的文件回报错误而不中断） */
export function loadPolicyRules(files: string[]): { rules: PolicyRule[]; errors: string[] } {
  const rules: PolicyRule[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const r = readIfExists(f);
    if (!r) continue;
    try {
      const parsed = JSON.parse(r.text) as { rules?: PolicyRule[] } | PolicyRule[];
      const list = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
      if (!Array.isArray(list)) {
        errors.push(`${f}: 期望数组或 {rules:[...]}`);
        continue;
      }
      list.forEach((item, i) => {
        if (!item || typeof item !== 'object') {
          errors.push(`${f}[${i}]: 非对象`);
          return;
        }
        if (!item.tool || !['allow', 'deny', 'require-approval'].includes(item.effect)) {
          errors.push(`${f}[${i}]: 缺 tool 或 effect 非法`);
          return;
        }
        rules.push({ ...item, id: item.id || `${f.split(/[\\/]/).pop()}#${i}` });
      });
    } catch (err) {
      errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rules, errors };
}

function argPathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const o = args as Record<string, unknown>;
  for (const k of ['path', 'file', 'filePath', 'skillPath', 'dir']) {
    if (typeof o[k] === 'string' && o[k]) return String(o[k]);
  }
  return null;
}

/** 匹配策略：后定义者（更具体的项目规则）优先 */
export function matchPolicy(rules: PolicyRule[], toolName: string, args: unknown): PolicyRule | null {
  return evaluatePolicy(rules, toolName, args).rule ?? null;
}

export type PolicyDecision = PolicyRule['effect'] | 'default';

export interface PolicyEvaluation {
  decision: PolicyDecision;
  matched: boolean;
  ruleId?: string;
  reason?: string;
  rule?: PolicyRule;
}

/** 纯函数策略判定：与运行时 agent.before_tool 使用同一套匹配规则。 */
export function evaluatePolicy(rules: PolicyRule[], toolName: string, args: unknown): PolicyEvaluation {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.enabled === false) continue;
    if (!matchesGlob(toolName.toLowerCase(), r.tool.toLowerCase())) continue;
    if (r.argPattern) {
      let re: RegExp;
      try {
        re = new RegExp(r.argPattern, 'i');
      } catch {
        continue;
      } // 坏正则的规则视为不匹配
      if (!re.test(JSON.stringify(args ?? {}))) continue;
    }
    if (r.pathPattern) {
      const p = argPathOf(args);
      if (!p || !matchesGlob(p.replace(/\\/g, '/'), r.pathPattern)) continue;
    }
    return { decision: r.effect, matched: true, ruleId: r.id, reason: r.reason, rule: r };
  }
  return { decision: 'default', matched: false };
}

export interface PolicyRuleChange {
  id: string;
  change: 'added' | 'removed' | 'changed';
  before?: PolicyRule;
  after?: PolicyRule;
  fields?: string[];
}

const POLICY_FIELDS: (keyof PolicyRule)[] = ['effect', 'tool', 'argPattern', 'pathPattern', 'reason', 'enabled'];

function indexedRuleKeys(rules: PolicyRule[]): Map<string, PolicyRule> {
  const out = new Map<string, PolicyRule>();
  rules.forEach((rule, index) => {
    const base = rule.id || `${rule.tool}#${index}`;
    let key = base;
    let suffix = 1;
    while (out.has(key)) key = `${base}#${suffix++}`;
    out.set(key, rule);
  });
  return out;
}

/** 比较两份策略规则：按 id（缺省按 tool#index）识别新增、删除与字段变化。 */
export function diffPolicyRules(before: PolicyRule[], after: PolicyRule[]): PolicyRuleChange[] {
  const oldRules = indexedRuleKeys(before);
  const newRules = indexedRuleKeys(after);
  const changes: PolicyRuleChange[] = [];
  for (const [id, oldRule] of oldRules) {
    const newRule = newRules.get(id);
    if (!newRule) {
      changes.push({ id, change: 'removed', before: oldRule });
      continue;
    }
    const fields = POLICY_FIELDS.filter((field) => JSON.stringify(oldRule[field]) !== JSON.stringify(newRule[field]));
    if (fields.length) changes.push({ id, change: 'changed', before: oldRule, after: newRule, fields });
  }
  for (const [id, newRule] of newRules) {
    if (!oldRules.has(id)) changes.push({ id, change: 'added', after: newRule });
  }
  return changes;
}

export interface PolicyValidationIssue {
  level: 'error' | 'warning';
  code: 'missing-tool' | 'invalid-effect' | 'invalid-regex' | 'duplicate-id' | 'blanket-allow';
  ruleId?: string;
  message: string;
}

/** 纯通配工具名（`*`、`**`、`?*`……）：不含任何具体字符 → 覆盖所有工具 */
export function isWildcardTool(tool: string): boolean {
  return /^[*?]+$/.test(String(tool ?? '').trim());
}

/** 一条策略规则是否等于「整体关掉审批」 */
export function isBlanketAllow(rule: PolicyRule): boolean {
  return !!rule && rule.effect === 'allow' && isWildcardTool(rule.tool);
}

/** 写入/预览前校验候选策略；error 拒绝保存，warning 只提示。 */
export function validatePolicyRules(rules: PolicyRule[]): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    const id = rule.id || `${rule.tool}#${index}`;
    if (!rule || typeof rule.tool !== 'string' || !rule.tool.trim()) {
      issues.push({ level: 'error', code: 'missing-tool', ruleId: id, message: '每条规则必须有 tool' });
      return;
    }
    if (!['allow', 'deny', 'require-approval'].includes(rule.effect)) {
      issues.push({ level: 'error', code: 'invalid-effect', ruleId: id, message: `effect 非法: ${String(rule.effect)}` });
    }
    if (rule.argPattern) {
      try {
        new RegExp(rule.argPattern, 'i');
      } catch {
        issues.push({ level: 'error', code: 'invalid-regex', ruleId: id, message: `argPattern 不是合法正则: ${rule.argPattern}` });
      }
    }
    if (rule.id) {
      if (ids.has(rule.id)) issues.push({ level: 'warning', code: 'duplicate-id', ruleId: rule.id, message: `规则 id 重复: ${rule.id}` });
      ids.add(rule.id);
    }
    if (isBlanketAllow(rule)) {
      issues.push({
        level: 'warning',
        code: 'blanket-allow',
        ruleId: id,
        message: `通配 allow（tool=${rule.tool}）会整体放行审批门，需显式确认`,
      });
    }
  });
  return issues;
}

export interface PolicyProbe {
  tool: string;
  args?: unknown;
}

export interface PolicyDryRunResult {
  current: PolicyEvaluation[];
  candidate: PolicyEvaluation[];
  changed: boolean;
  probes: { tool: string; args?: unknown; current: PolicyEvaluation; candidate: PolicyEvaluation; changed: boolean }[];
  diff: PolicyRuleChange[];
  issues: PolicyValidationIssue[];
}

/** 只读演练：同一组探针分别跑当前策略与候选策略，不执行工具、不落盘。 */
export function dryRunPolicy(currentRules: PolicyRule[], candidateRules: PolicyRule[], probes: PolicyProbe[]): PolicyDryRunResult {
  const current = probes.map((probe) => evaluatePolicy(currentRules, probe.tool, probe.args ?? {}));
  const candidate = probes.map((probe) => evaluatePolicy(candidateRules, probe.tool, probe.args ?? {}));
  const diff = diffPolicyRules(currentRules, candidateRules);
  return {
    current,
    candidate,
    changed:
      diff.length > 0 ||
      current.some((item, index) => item.decision !== candidate[index].decision || item.ruleId !== candidate[index].ruleId),
    probes: probes.map((probe, index) => ({
      tool: probe.tool,
      args: probe.args,
      current: current[index],
      candidate: candidate[index],
      changed: current[index].decision !== candidate[index].decision || current[index].ruleId !== candidate[index].ruleId,
    })),
    diff,
    issues: validatePolicyRules(candidateRules),
  };
}
