/**
 * core/skills/index.ts —— 技能系统插件（兼容开源 skills 生态 + 按需路由 + 用量台账）
 * 发现源与优先级（同名时高者胜出，胜出记录 shadowed 供 UI 提示）：
 *   project  <工作区>/.maharness/skills、.claude/skills、.agents/skills
 *   user     data/skills（web 端安装 / 自进化采纳）
 *   pack     vendor/<包>/{skills/}?<技能名>/SKILL.md（开源技能包，如 ARS、emilkowalski/skills）
 *   builtin  core/skills/builtin（随产品分发）
 * 注入策略（关键）：正文永不注入；每轮只注入「技能索引」（name + 截断描述），
 *   且默认按当前任务相关性取 top-K（skills.enabled=routing），受 indexMaxTokens 预算约束；
 *   全文仍由 get_skill 懒加载，读取量记入 data/skill-usage.json 台账。
 * frontmatter 走 kernel/frontmatter 真解析（name/description/license/allowed-tools/metadata）。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../../kernel/types';
import { parseFrontMatter, fmString, fmList, fmMap } from '../../kernel/frontmatter';
import { contentWords, bigramSet, dice } from '../../kernel/cache';
import { estimateTokens } from '../../kernel/tokens';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const builtinDir = join(rootDir, 'core', 'skills', 'builtin');
const userDir = join(rootDir, 'data', 'skills');
const vendorDir = join(rootDir, 'vendor');

/** get_skill_file 单文件读取上限（字符） */
const FILE_CHAR_LIMIT = 200_000;
/** 索引扫描缓存有效期（毫秒）：避免每轮都重扫目录 */
const SCAN_TTL = 5_000;
/** 项目级技能目录候选（兼容 Claude Code / Codex 生态） */
const PROJECT_DIRS = ['.maharness/skills', '.claude/skills', '.agents/skills'];

export type SkillSource = 'builtin' | 'pack' | 'user' | 'project';
const PRECEDENCE: SkillSource[] = ['project', 'user', 'pack', 'builtin'];

let flushNow: (() => void) | null = null;
let stopTimer: (() => void) | null = null;

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  /** 同名技能被更高优先级覆盖时列出 */
  shadowed?: SkillSource[];
  license?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
  /** 正文字符数（索引预算与台账用） */
  bodyChars?: number;
}

interface SkillEntry extends SkillInfo {
  dir: string;
  packRoot?: string;
}

/** 技能包根扫描：支持 vendor/<pack>/<skill>/ 与 vendor/<pack>/skills/<skill>/ 两种上游布局；
 *  vendor/<pack>/SKILL.md（整包即一个技能）→ 以 pack 自身为技能目录、其父目录为资源根。 */
function packRoots(): { packRoot: string; skillParent: string; selfAsSkill?: string }[] {
  if (!existsSync(vendorDir)) return [];
  const out: { packRoot: string; skillParent: string; selfAsSkill?: string }[] = [];
  let entries;
  try { entries = readdirSync(vendorDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const packRoot = join(vendorDir, e.name);
    if (existsSync(join(packRoot, 'SKILL.md'))) { out.push({ packRoot: dirname(packRoot), skillParent: packRoot, selfAsSkill: e.name }); continue; }
    const nested = join(packRoot, 'skills');
    out.push({ packRoot, skillParent: existsSync(nested) ? nested : packRoot });
  }
  return out;
}

function readEntry(dir: string, name: string, source: SkillSource, packRoot?: string): SkillEntry | null {
  const mdPath = join(dir, 'SKILL.md');
  if (!existsSync(mdPath)) return null;
  let md: string;
  try { md = readFileSync(mdPath, 'utf-8'); } catch { return null; }
  const fm = parseFrontMatter(md);
  const meta = fmMap(fm.data, 'metadata');
  const allowed = fmList(fm.data, 'allowed-tools').length ? fmList(fm.data, 'allowed-tools') : fmList(fm.data, 'allowed_tools');
  return {
    name: fmString(fm.data, 'name') || name,
    description: fmString(fm.data, 'description') || '(无描述)',
    source, packRoot, dir,
    license: fmString(fm.data, 'license') || undefined,
    allowedTools: allowed.length ? allowed : undefined,
    metadata: Object.keys(meta).length ? meta : undefined,
    bodyChars: fm.body.length,
  };
}

function publicInfo(e: SkillEntry, shadows: SkillSource[]): SkillInfo {
  const info: SkillInfo = { name: e.name, description: e.description, source: e.source };
  if (shadows.length) info.shadowed = shadows;
  if (e.license) info.license = e.license;
  if (e.allowedTools?.length) info.allowedTools = e.allowedTools;
  if (e.metadata) info.metadata = e.metadata;
  if (e.bodyChars) info.bodyChars = e.bodyChars;
  return info;
}

export default {
  id: 'skills',
  name: '技能系统',
  version: '0.3.0',
  onLoad(ctx) {
    const mode = ctx.config.get<string>('skills.enabled', 'routing');
    const topK = Math.max(1, ctx.config.get<number>('skills.topK', 8));
    const indexMaxTokens = Math.max(100, ctx.config.get<number>('skills.indexMaxTokens', 900));
    const descMaxChars = Math.max(40, ctx.config.get<number>('skills.descMaxChars', 160));
    const usageFile = join(ctx.paths.data, 'skill-usage.json');

    let scanCache: { at: number; entries: SkillEntry[]; index: Map<string, { entry: SkillEntry; shadows: SkillSource[] }> } | null = null;

    function scan(): { entries: SkillEntry[]; index: Map<string, { entry: SkillEntry; shadows: SkillSource[] }> } {
      if (scanCache && Date.now() - scanCache.at < SCAN_TTL) return scanCache;
      const projectRoot = ctx.config.get<string>('sandboxRoot', rootDir);
      const parents: { dir: string; source: SkillSource; packRoot?: string; selfName?: string }[] = [];
      for (const rel of PROJECT_DIRS) parents.push({ dir: join(resolve(projectRoot), rel), source: 'project' });
      parents.push({ dir: userDir, source: 'user' });
      for (const { packRoot, skillParent, selfAsSkill } of packRoots()) {
        parents.push({ dir: skillParent, source: 'pack', packRoot, selfName: selfAsSkill });
      }
      parents.push({ dir: builtinDir, source: 'builtin' });

      const index = new Map<string, { entry: SkillEntry; shadows: SkillSource[] }>();
      const entries: SkillEntry[] = [];
      const addEntry = (entry: SkillEntry) => {
        entries.push(entry);
        const cur = index.get(entry.name);
        if (!cur) index.set(entry.name, { entry, shadows: [] });
        else cur.shadows.push(entry.source);
      };
      for (const p of parents) {
        if (!existsSync(p.dir)) continue;
        if (p.selfName) {
          const entry = readEntry(p.dir, p.selfName, 'pack', p.packRoot);
          if (entry) addEntry(entry);
          continue;
        }
        let names: string[] = [];
        try { names = readdirSync(p.dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
        catch { continue; }
        for (const n of names) {
          const entry = readEntry(join(p.dir, n), n, p.source, p.packRoot);
          if (entry) addEntry(entry);
        }
      }
      scanCache = { at: Date.now(), entries, index };
      return scanCache;
    }

    const list = (): SkillInfo[] => {
      const { index } = scan();
      return [...index.values()]
        .map(v => publicInfo(v.entry, v.shadows))
        .sort((a, b) => PRECEDENCE.indexOf(a.source) - PRECEDENCE.indexOf(b.source) || a.name.localeCompare(b.name));
    };

    const entryOf = (name: string): SkillEntry | undefined => {
      const safe = String(name ?? '').replace(/[^\w.\u4e00-\u9fa5-]/g, '');
      return scan().index.get(safe)?.entry;
    };

    const get = (name: string): { ok: boolean; content?: string; error?: string } => {
      const e = entryOf(name);
      if (!e) return { ok: false, error: `技能不存在: ${name}（用 list_skills 查看可用技能）` };
      try { return { ok: true, content: readFileSync(join(e.dir, 'SKILL.md'), 'utf-8') }; }
      catch (err) { return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }; }
    };

    // ---- 用量台账：索引出现次数 + 正文读取次数与 token ----
    interface UsageRow { indexShown: number; reads: number; bodyTokens: number; lastReadAt?: number }
    let usage: Record<string, UsageRow> = {};
    try { usage = JSON.parse(readFileSync(usageFile, 'utf-8')) as Record<string, UsageRow>; } catch { usage = {}; }
    let usageDirty = false;
    const usageRow = (name: string): UsageRow => (usage[name] ??= { indexShown: 0, reads: 0, bodyTokens: 0 });
    const flushUsage = () => {
      if (!usageDirty) return;
      usageDirty = false;
      try { mkdirSync(ctx.paths.data, { recursive: true }); writeFileSync(usageFile, JSON.stringify(usage, null, 2), 'utf-8'); } catch { /* 台账写盘失败不影响对话 */ }
    };
    const usageTimer = setInterval(flushUsage, 15_000);
    (usageTimer as { unref?: () => void }).unref?.();

    // ---- 相关性路由 ----
    function scoreSkills(query: string): { name: string; score: number }[] {
      const { index } = scan();
      const qNorm = query.replace(/\s+/g, ' ').trim().toLowerCase();
      const qWords = new Set(contentWords(qNorm));
      const qBi = bigramSet(contentWords(qNorm));
      return [...index.values()].map(({ entry }) => {
        const hay = `${entry.name} ${entry.description}`.toLowerCase();
        let score = dice(qBi, bigramSet(contentWords(hay)));
        for (const w of qWords) if (w.length > 1 && hay.includes(w)) score += 0.15;
        if (qNorm && hay.includes(qNorm)) score += 0.5;
        return { name: entry.name, score };
      }).sort((a, b) => b.score - a.score);
    }

    function buildIndex(userText: string): string | null {
      if (mode === 'off') return null;
      const { index } = scan();
      if (!index.size) return null;
      const ranked = mode === 'all'
        ? [...index.keys()].map(name => ({ name, score: 1 }))
        : scoreSkills(userText).filter(s => s.score > 0);
      const picked = ranked.slice(0, topK);
      let out = '';
      const shown: string[] = [];
      const head = '【可用技能】需要方法论或领域规范时，先 get_skill("名称") 读全文；技能包附属文件用 get_skill_file。\n';
      for (const p of picked) {
        const e = index.get(p.name)?.entry;
        if (!e) continue;
        const desc = e.description.length > descMaxChars ? `${e.description.slice(0, descMaxChars)}…` : e.description;
        const line = `- ${e.name}：${desc}`;
        if (estimateTokens(head + out + line) > indexMaxTokens) break;
        out += (out ? '\n' : '') + line;
        shown.push(e.name);
      }
      if (!out) return null;
      const hidden = index.size - shown.length;
      for (const n of shown) { usageRow(n).indexShown++; usageDirty = true; }
      return head + out + (hidden > 0 ? `\n（另有 ${hidden} 个技能与当前任务相关性低未列出，需要时用 list_skills 查看）` : '');
    }

    ctx.register({
      kind: 'context',
      context: {
        id: 'skills-index',
        description: '按需注入的技能索引（相关性 top-K，仅名称与描述，正文零成本）',
        weight: 20,
        contentFn({ history }) {
          let lastUser = '';
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'user') { lastUser = String(history[i].content ?? ''); break; }
          }
          if (!lastUser) return null;
          return buildIndex(lastUser);
        },
      },
    });

    ctx.register({
      kind: 'service',
      service: {
        id: 'skills',
        instance: {
          list, get, entryOf, packDir: vendorDir,
          /** 供 UI/管理端按来源+名称读原文（project/user/pack/builtin 由服务定位目录） */
          readBySource(source: SkillSource, name: string): string | null {
            const e = entryOf(name);
            if (!e || e.source !== source) return null;
            try { return readFileSync(join(e.dir, 'SKILL.md'), 'utf-8'); } catch { return null; }
          },
          usage: () => usage,
          invalidateCache: () => { scanCache = null; },
        },
      },
    });

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'skills-rules',
        name: '技能系统使用规则',
        description: '引导 LLM 按需读取技能指南',
        priority: 15,
        content: [
          '技能系统使用规则：',
          '1. 上方【可用技能】是按当前任务挑出的最相关技能；命中就 get_skill 读全文再动手，不要凭印象执行；',
          '2. 不确定还有什么技能时用 list_skills 查全量（含被更高优先级同名技能覆盖的情况）；',
          '3. 多文件技能包用 get_skill_file（agents/ references/ templates/ shared/ scripts/），大文档先带 grep 参数定位章节；',
          '4. 技能是知识包不是代码，读取后按其指导执行；技能声明的 allowed-tools 若存在，只用其中列出的工具；',
          '5. 用户要求沉淀经验/写技能时，先 get_skill("skill-authoring") 再写 data/skills/<name>/SKILL.md。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_skills',
        risk: 'low',
        costHint: 'low',
        output: '{count, skills: [{name, description, source, shadowed?, allowedTools?, bodyChars?}]}',
        description: '列出全部可用技能（项目级 / 已安装 / 技能包 / 内置）：名称、描述、来源。同名技能按 project>user>pack>builtin 生效，被覆盖者标 shadowed。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          const skills = list();
          return { ok: true, data: { count: skills.length, skills } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'get_skill',
        risk: 'low',
        costHint: 'low',
        output: '{name, source, content}；content 为 SKILL.md 全文',
        description: '读取指定技能全文（SKILL.md，含 frontmatter 与正文）。任务与某技能相关时先读它再执行；正文较长时优先看其中的流程与清单。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名称（list_skills 可查）' } },
          required: ['name'],
        },
        async handler(args: { name?: string }) {
          const r = get(String(args.name ?? ''));
          if (!r.ok) return { ok: false, error: r.error };
          const e = entryOf(String(args.name ?? ''));
          const row = usageRow(String(args.name));
          row.reads++; row.bodyTokens += estimateTokens(r.content ?? ''); row.lastReadAt = Date.now();
          usageDirty = true;
          return { ok: true, data: { name: e?.name ?? args.name, source: e?.source, allowedTools: e?.allowedTools, content: r.content } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'get_skill_file',
        risk: 'low',
        costHint: 'low',
        limits: `仅限技能目录/技能包根内；单文件 ${FILE_CHAR_LIMIT} 字符上限`,
        description: '读取技能内资源文件的文本内容（仅限技能目录/技能包根内，路径防穿越）。多文件技能包的 SKILL.md 会引用 agents/<name>_agent.md（子代理定义）、references/（规范）、templates/（模板）、shared/（跨技能协议）、scripts/（校验脚本）。大文档先用 grep 参数定位章节再读，避免整文塞满上下文。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '技能名称（list_skills 可查）' },
            path: { type: 'string', description: '技能内相对路径；shared/ scripts/ docs/ .claude/ 这类跨技能路径相对技能包根，自动解析' },
            grep: { type: 'string', description: '可选：只在文件内搜索匹配行（大小写不敏感），返回匹配行+行号+各 2 行上下文' },
          },
          required: ['skill', 'path'],
        },
        async handler(args: { skill?: string; path?: string; grep?: string }) {
          const entry = entryOf(String(args.skill ?? ''));
          if (!entry) return { ok: false, error: `技能不存在: ${args.skill}（用 list_skills 查看）` };
          const rel = String(args.path ?? '');
          const candidates = [safeResolve(entry.dir, rel)];
          if (entry.packRoot) candidates.push(safeResolve(entry.packRoot, rel));
          for (const p of candidates) {
            if (!p || !existsSync(p) || !statSync(p).isFile()) continue;
            let content = readFileSync(p, 'utf-8');
            const pattern = String(args.grep ?? '').trim();
            if (pattern) {
              const lines = content.split('\n');
              const lower = pattern.toLowerCase();
              const hits: number[] = [];
              lines.forEach((ln, i) => { if (ln.toLowerCase().includes(lower)) hits.push(i); });
              if (hits.length === 0) {
                return { ok: true, data: { skill: args.skill, path: rel, grep: pattern, matches: 0, content: `（无匹配行: ${pattern}）` } };
              }
              const around = new Set<number>();
              for (const h of hits.slice(0, 80)) for (let d = -2; d <= 2; d++) if (lines[h + d] !== undefined) around.add(h + d);
              const outLines: string[] = [];
              let prev = -2;
              for (const i of [...around].sort((a, b) => a - b)) {
                if (i !== prev + 1) outLines.push('…');
                outLines.push(`${i + 1}: ${lines[i]}`);
                prev = i;
              }
              const total = outLines.join('\n');
              return {
                ok: true,
                data: {
                  skill: args.skill, path: rel, grep: pattern, matches: hits.length,
                  truncated: total.length > FILE_CHAR_LIMIT,
                  content: total.length > FILE_CHAR_LIMIT ? total.slice(0, FILE_CHAR_LIMIT) : total,
                },
              };
            }
            const truncated = content.length > FILE_CHAR_LIMIT;
            if (truncated) content = content.slice(0, FILE_CHAR_LIMIT);
            return { ok: true, data: { skill: args.skill, path: rel, truncated, content } };
          }
          const listAvail = (base: string): string[] => {
            const resolved = safeResolve(base, rel);
            if (!resolved) return [];
            const dir = dirname(resolved);
            const normBase = resolve(base);
            if (!dir.startsWith(normBase) || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
            try { return readdirSync(dir, { withFileTypes: true }).map(e => e.name).slice(0, 40); } catch { return []; }
          };
          const avail = [...new Set([...listAvail(entry.dir), ...(entry.packRoot ? listAvail(entry.packRoot) : [])])];
          return {
            ok: false,
            error: `文件不存在: ${rel}（技能内路径相对技能根；shared/ scripts/ docs/ .claude/ 相对技能包根，已自动尝试两者）${avail.length ? `。可用文件: ${avail.join('、')}` : ''}`,
          };
        },
      },
    });

    flushNow = flushUsage;
    stopTimer = () => { clearInterval(usageTimer); };
    const all = list();
    ctx.logger.info(`技能就绪: ${all.length} 个（内置 ${all.filter(s => s.source === 'builtin').length} / 包 ${all.filter(s => s.source === 'pack').length} / 已装 ${all.filter(s => s.source === 'user').length} / 项目 ${all.filter(s => s.source === 'project').length}），索引模式=${mode}`);
  },
  onStop() {
    flushNow?.();
    stopTimer?.();
    flushNow = null;
    stopTimer = null;
  },
} satisfies Plugin;

/** 把相对路径安全解析到 baseRoot 内；越界（绝对路径 / .. 穿越 / 盘符）返回 null */
function safeResolve(baseRoot: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const resolved = resolve(baseRoot, rel);
  const normRoot = resolve(baseRoot);
  if (resolved !== normRoot && !resolved.startsWith(normRoot + sep)) return null;
  return resolved;
}
