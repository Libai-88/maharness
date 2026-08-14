/**
 * core/skills/index.ts —— 技能系统插件（maharness 自我设计的知识底座）
 * 内置 skills 在 core/skills/builtin/<name>/SKILL.md（随产品分发）；
 * 用户安装的 skills 在 data/skills/<name>/SKILL.md（web 端从 market/ 安装）。
 * 能力：list_skills（查看可用技能）/ get_skill（读取技能全文，按需指导自我设计）。
 * 设计原则：skills 不自动注入提示词（避免膨胀），Agent 按需读取——需要时精准，不需要时零成本。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../../kernel/types';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const builtinDir = join(rootDir, 'core', 'skills', 'builtin');
const userDir = join(rootDir, 'data', 'skills');

export interface SkillInfo {
  name: string;
  description: string;
  source: 'builtin' | 'user';
}

/** 解析 SKILL.md 的 frontmatter description */
function parseSkillDescription(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return '';
  const desc = m[1].match(/description:\s*(.+)/);
  return desc ? desc[1].trim() : '';
}

function scanDir(dir: string, source: 'builtin' | 'user'): SkillInfo[] {
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

export default {
  id: 'skills',
  name: '技能系统',
  version: '0.1.0',
  onLoad(ctx) {
    const list = (): SkillInfo[] => [...scanDir(builtinDir, 'builtin'), ...scanDir(userDir, 'user')];

    const get = (name: string): { ok: boolean; content?: string; error?: string } => {
      const nameSafe = String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
      for (const dir of [builtinDir, userDir]) {
        const mdPath = join(dir, nameSafe, 'SKILL.md');
        if (existsSync(mdPath)) {
          return { ok: true, content: readFileSync(mdPath, 'utf-8') };
        }
      }
      return { ok: false, error: `技能不存在: ${name}（用 list_skills 查看）` };
    };

    // 服务暴露：server 层读取技能列表（管理 API）
    ctx.register({
      kind: 'service',
      service: { id: 'skills', instance: { list, get } },
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
          '5. 技能是知识包不是代码，读取后按其指导执行即可；不确定有什么技能时用 list_skills 查看。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_skills',
        description: '列出全部可用技能（内置 + 已安装）：名称、描述、来源。技能是指导 Agent 的指南包，需要时用 get_skill 读取全文。',
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
        description: '读取指定技能全文（SKILL.md，含 frontmatter 与正文）。技能指导 Agent 完成特定任务或自我设计，如 plugin-authoring / agent-self-design / thinking-chain / skill-authoring。',
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

    ctx.logger.info(`技能就绪: list_skills / get_skill（内置 ${list().filter((s) => s.source === 'builtin').length} 个指南）`);
  },
} satisfies Plugin;
