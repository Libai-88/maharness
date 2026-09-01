/**
 * core/skills/index.ts —— 技能系统插件（maharness 自我设计的知识底座）
 * 内置 skills 在 core/skills/builtin/<name>/SKILL.md（随产品分发）；
 * 技能包（vendor，如学术智能体 ARS）在 vendor/<pack>/<name>/SKILL.md（随产品分发，多文件知识包）；
 * 用户安装的 skills 在 data/skills/<name>/SKILL.md（web 端从 market/ 安装）。
 * 能力：list_skills（查看可用技能）/ get_skill（读取技能全文）/ get_skill_file（读取技能包内
 * 任意资源文件——agents/references/templates 等多文件结构）。
 * 设计原则：skills 不自动注入提示词（避免膨胀），Agent 按需读取——需要时精准，不需要时零成本。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../../kernel/types';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const builtinDir = join(rootDir, 'core', 'skills', 'builtin');
const userDir = join(rootDir, 'data', 'skills');
const packDir = join(rootDir, 'vendor', 'academic-research-skills');

/** get_skill_file 单文件读取上限（字符）：技能资源多为指南文档，超限截断并显式告知 */
const FILE_CHAR_LIMIT = 200_000;

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'pack';
}

/** 解析 SKILL.md 的 frontmatter description */
function parseSkillDescription(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return '';
  const desc = m[1].match(/description:\s*(.+)/);
  return desc ? desc[1].trim() : '';
}

function scanDir(dir: string, source: SkillInfo['source']): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mdPath = join(dir, e.name, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const content = readFileSync(mdPath, 'utf-8');
    out.push({ name: e.name, description: parseSkillDescription(content) || '(无描述)', source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能根目录查找顺序：builtin → user → pack（同名时前者优先） */
function skillRoots(name: string): { root: string; packRoot?: string }[] {
  const nameSafe = String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!nameSafe) return [];
  const out: { root: string; packRoot?: string }[] = [];
  for (const dir of [builtinDir, userDir]) {
    if (existsSync(join(dir, nameSafe, 'SKILL.md'))) out.push({ root: join(dir, nameSafe) });
  }
  if (existsSync(join(packDir, nameSafe, 'SKILL.md'))) out.push({ root: join(packDir, nameSafe), packRoot: packDir });
  return out.slice(0, 1);
}

/** 把相对路径安全解析到 baseRoot 内；越界（绝对路径 / .. 穿越 / 盘符）返回 null */
function safeResolve(baseRoot: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const resolved = resolve(baseRoot, rel);
  const normRoot = resolve(baseRoot);
  if (resolved !== normRoot && !resolved.startsWith(normRoot + sep)) return null;
  return resolved;
}

export default {
  id: 'skills',
  name: '技能系统',
  version: '0.2.0',
  onLoad(ctx) {
    const list = (): SkillInfo[] => [...scanDir(builtinDir, 'builtin'), ...scanDir(packDir, 'pack'), ...scanDir(userDir, 'user')];

    const get = (name: string): { ok: boolean; content?: string; error?: string } => {
      const [entry] = skillRoots(name);
      if (entry) {
        const mdPath = join(entry.root, 'SKILL.md');
        if (existsSync(mdPath)) return { ok: true, content: readFileSync(mdPath, 'utf-8') };
      }
      return { ok: false, error: `技能不存在: ${name}（用 list_skills 查看）` };
    };

    // 服务暴露：server 层读取技能列表（管理 API）
    ctx.register({
      kind: 'service',
      service: { id: 'skills', instance: { list, get, packDir } },
    });

    // L2 人设：引导 Agent 何时使用技能系统
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'skills-rules',
        name: '技能系统使用规则',
        description: '引导 LLM 在需要时按需读取技能指南',
        priority: 15,
        content: [
          '技能系统使用规则（maharness 自我设计知识库）：',
          '1. 用户要求你写新插件/新工具时，先 get_skill("plugin-authoring") 读取契约速查，避免凭记忆写错；',
          '2. 用户要求你改造自己的行为/工作方式时，先 get_skill("agent-self-design") 了解改造途径；',
          '3. 需要给用户提供提示词/思维链建议时，先 get_skill("thinking-chain")；',
          '4. 用户要求你沉淀经验/写技能时，先 get_skill("skill-authoring")；',
          '5. 任务需要多工具协作编排时，先 get_skill("capability-composition") 查看组合范式；',
          '6. 技能是知识包不是代码，读取后按其指导执行即可；不确定有什么技能时用 list_skills 查看。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_skills',
        risk: 'low',
        costHint: 'low',
        description: '列出全部可用技能（内置 + 技能包 + 已安装）：名称、描述、来源。技能是指导 Agent 的指南包，需要时用 get_skill 读取全文。',
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
        description: '读取指定技能全文（SKILL.md，含 frontmatter 与正文）。技能指导 Agent 完成特定任务或自我设计。学术技能包（source=pack）：deep-research / academic-paper / academic-paper-reviewer / academic-pipeline；内置指南：plugin-authoring / agent-self-design / thinking-chain / skill-authoring / capability-composition。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名称（list_skills 可查）' } },
          required: ['name'],
        },
        async handler(args: { name?: string }) {
          const r = get(String(args.name ?? ''));
          return r.ok ? { ok: true, data: { name: args.name, content: r.content } } : { ok: false, error: r.error };
        },
      },
    });

    // 多文件技能包的资源读取：技能正文会引用 agents/*.md（子代理定义）、references/、
    // templates/、shared/、scripts/ 等相对路径——统一经此工具读取（沙箱无关、路径防穿越）。
    // 解析顺序：技能根相对 → 技能包根相对（仅 pack 来源技能；ARS 的 shared/ scripts/ docs/
    // .claude/ 引用均相对包根）。
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'get_skill_file',
        risk: 'low',
        costHint: 'low',
        description: '读取技能内任意资源文件的文本内容（仅限技能目录/技能包根内，路径防穿越）。多文件技能（如学术技能包）的 SKILL.md 会引用 agents/<name>_agent.md（子代理定义）、references/（规范）、templates/（模板）、shared/（跨技能协议）、scripts/（校验脚本）等，用本工具按路径读取。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '技能名称（list_skills 可查）' },
            path: { type: 'string', description: '技能内相对路径，如 agents/draft_writer_agent.md；shared/references/x.md 这类跨技能路径相对技能包根，自动解析' },
          },
          required: ['skill', 'path'],
        },
        async handler(args: { skill?: string; path?: string }) {
          const roots = skillRoots(String(args.skill ?? ''));
          if (roots.length === 0) return { ok: false, error: `技能不存在: ${args.skill}（用 list_skills 查看）` };
          const { root, packRoot } = roots[0];
          const rel = String(args.path ?? '');
          const candidates = [safeResolve(root, rel)];
          if (packRoot) candidates.push(safeResolve(packRoot, rel));
          for (const p of candidates) {
            if (!p || !existsSync(p) || !statSync(p).isFile()) continue;
            let content = readFileSync(p, 'utf-8');
            let truncated = false;
            if (content.length > FILE_CHAR_LIMIT) {
              content = content.slice(0, FILE_CHAR_LIMIT);
              truncated = true;
            }
            return { ok: true, data: { skill: args.skill, path: rel, truncated, content } };
          }
          return { ok: false, error: `文件不存在: ${rel}（技能内路径相对技能根；shared/ scripts/ docs/ .claude/ 相对技能包根，已自动尝试两者）` };
        },
      },
    });

    ctx.logger.info(`技能就绪: list_skills / get_skill / get_skill_file（内置 ${list().filter((s) => s.source === 'builtin').length} 个指南，技能包 ${list().filter((s) => s.source === 'pack').length} 个）`);
  },
} satisfies Plugin;
