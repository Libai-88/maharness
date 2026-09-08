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
import { matchesGlob } from './fssearch';

export interface RuleSource {
  scope: 'global' | 'project';
  label: string;
  file: string;
  exists: boolean;
  chars: number;
  mtimeMs: number;
}

export interface PromptRulesResult {
  /** 已按顺序拼装的规则正文（含来源标题）；无规则时为空串 */
  text: string;
  sources: RuleSource[];
  truncated: boolean;
  /** 供 UI 展示的可编辑目标 */
  editable: { scope: 'global' | 'project'; defaultFile: string; candidates: string[] };
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
  } catch { return null; }
}

function mdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name))
      .map(e => join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/** 剥离 YAML frontmatter：规则文件常被当作技能/文档复用，头部元数据不该进提示词 */
function stripFrontMatter(md: string): string {
  const t = md.replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(t)) return t.trim();
  const after = t.slice(t.indexOf('\n') + 1);
  const end = /^---[ \t]*$/m.exec(after);
  if (!end || end.index === undefined) return t.trim();
  return after.slice(end.index + end[0].length).replace(/^\r?\n/, '').trim();
}

/**
 * 加载提示规则。maxChars 为总预算（超出按「项目优先于全局」反向裁剪）。
 * now 用于测试注入。
 */
export function loadPromptRules(opts: {
  dataDir: string;
  projectRoot: string;
  maxChars?: number;
}): PromptRulesResult {
  const maxChars = opts.maxChars ?? 12_000;
  const collected: { scope: 'global' | 'project'; label: string; file: string; text: string; source: RuleSource }[] = [];
  const sources: RuleSource[] = [];

  const pushFile = (scope: 'global' | 'project', file: string, label: string) => {
    const r = readIfExists(file);
    const abs = resolve(file);
    const source: RuleSource = { scope, label, file: abs, exists: !!r, chars: r ? r.text.length : 0, mtimeMs: r?.mtimeMs ?? 0 };
    sources.push(source);
    if (!r) return;
    const text = stripFrontMatter(r.text);
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
  const ordered = [...collected.filter(c => c.scope === 'project'), ...collected.filter(c => c.scope === 'global')];
  const kept: typeof ordered = [];
  for (const c of ordered) {
    if (c.text.length <= budget) { kept.push(c); budget -= c.text.length; continue; }
    if (budget > 400) { kept.push({ ...c, text: `${c.text.slice(0, budget)}\n…（该规则文件已按预算截断）` }); truncated = true; budget = 0; }
    else truncated = true;
  }
  const text = kept
    .map(c => `【${c.scope === 'project' ? '项目规则' : '全局规则'}·${c.label}】\n${c.text}`)
    .join('\n\n');
  return {
    text,
    sources,
    truncated,
    editable: {
      scope: 'project',
      defaultFile: join(root, 'AGENTS.md'),
      candidates: PROJECT_CANDIDATES.map(rel => join(root, rel)),
    },
  };
}

/** 规则集指纹（文件路径+mtime），供插件做惰性重载 */
export function rulesSignature(sources: RuleSource[]): string {
  return sources.map(s => `${s.file}:${s.exists ? 1 : 0}:${s.mtimeMs}:${s.chars}`).join('|');
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
      const list = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
      if (!Array.isArray(list)) { errors.push(`${f}: 期望数组或 {rules:[...]}`); continue; }
      list.forEach((item, i) => {
        if (!item || typeof item !== 'object') { errors.push(`${f}[${i}]: 非对象`); return; }
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
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.enabled === false) continue;
    if (!matchesGlob(toolName.toLowerCase(), r.tool.toLowerCase())) continue;
    if (r.argPattern) {
      let re: RegExp;
      try { re = new RegExp(r.argPattern, 'i'); } catch { continue; }   // 坏正则的规则视为不匹配
      if (!re.test(JSON.stringify(args ?? {}))) continue;
    }
    if (r.pathPattern) {
      const p = argPathOf(args);
      if (!p || !matchesGlob(p.replace(/\\/g, '/'), r.pathPattern)) continue;
    }
    return r;
  }
  return null;
}
