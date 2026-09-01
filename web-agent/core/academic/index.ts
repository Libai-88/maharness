/**
 * core/academic/index.ts —— 学术智能体接线插件（maharness × ARS 融合层）
 *
 * maharness 的适配面：学术技能包 ARS（Academic Research Skills，vendor/academic-research-skills）
 * 是成熟的 Claude Code 技能套件（deep-research / academic-paper / academic-paper-reviewer /
 * academic-pipeline），内容零改动。本插件不复制其方法论，只做三件事把 maharness 对接到它的工作流：
 *  1. 路由：persona 声明触发词 → 技能映射（对应 ARS SKILL.md 的 Trigger Keywords 设计）；
 *  2. 资源契约：技能的多文件资源（agents/ references/ templates/ shared/ scripts/）经
 *     skills 插件的 get_skill / get_skill_file 读取；
 *  3. 编排映射：ARS 的 agent 团队 → maharness 的 run_subagent / run_parallel / run_review，
 *     阶段确认检查点 → 对话轮次（human-in-the-loop 由用户确认，不由 harness 代答）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../../kernel/types';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const packDir = join(rootDir, 'vendor', 'academic-research-skills');

export default {
  id: 'academic',
  name: '学术智能体（ARS 融合）',
  version: '0.1.0',
  onLoad(ctx) {
    if (!existsSync(join(packDir, 'deep-research', 'SKILL.md'))) {
      ctx.logger.warn('ARS 技能包缺失（vendor/academic-research-skills），学术 persona 降级为仅路由声明');
    }

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'ars-routing',
        name: '学术技能路由（ARS）',
        description: '把科研类请求路由到 ARS 技能包，并约定多文件资源读取与子代理编排方式',
        priority: 25,
        content: [
          `学术智能体工作流（ARS 技能包，位于 ${packDir}）：`,
          '一、路由（触发词 → 技能，命中即 get_skill 读取全文后再行动，不要凭记忆执行）：',
          '- 研究/文献综述/系统性回顾/PRISMA/事实核查/三段式文献比较/苏格拉底式引导研究 → get_skill("deep-research")；',
          '- 写论文/大纲/摘要/修改/审稿意见处理/引用检查/格式转换/LaTeX/AI 使用披露 → get_skill("academic-paper")；',
          '- 审稿/同行评审/模拟评审/复审/审稿人校准 → get_skill("academic-paper-reviewer")；',
          '- 端到端科研全流程（研究→写作→完整性核查→评审→修改→定稿）→ get_skill("academic-pipeline")；',
          '- 拿不准是哪个技能时先 list_skills 再判断；非科研请求照常处理，不要强行套技能。',
          '二、多文件资源契约：技能正文引用的相对路径用 get_skill_file(skill, path) 读取——',
          'agents/<name>_agent.md 是子代理的角色定义；references/ templates/ 相对技能根；',
          'shared/ scripts/ docs/ .claude/ 相对技能包根（工具会自动按两个根依次解析）。',
          '三、编排映射（ARS 的 agent 团队 → 本机工具）：',
          '- 技能要求"派发 agent X"→ 先 get_skill_file(skill, "agents/x_agent.md") 拿到角色定义，',
          '  再按其职责与输出契约构造 objective 调 run_subagent（长任务传 maxTurns 放大轮数）；',
          '- 多个互不依赖的检索/抽取子任务 → run_parallel；快速对抗式自查 → run_review，',
          '  但正式评审流程必须按技能定义的多席位评审团执行（run_review 只做补充自查）。',
          '四、人机协作纪律（ARS 核心设计，不可省略）：',
          '- 阶段推进前必须停下等待用户确认，不得替用户做阶段决策；',
          '- 完整性核查（如 pipeline Stage 2.5/4.5）按技能定义执行；其中的确定性校验脚本位于',
          `  ${join(packDir, 'scripts')}，用 powershell_execute 运行（如 python vendor/academic-research-skills/scripts/verify_passport.py，`,
          '  需本机 Python）；Python 不可用时如实声明降级并把脚本结论标记为未执行，不得假装已核查；',
          '- 引用纪律：每条引用都必须可溯源（DOI/arXiv/期刊页），未经检索核实的引用不得写入产出；',
          '- 不虚构实验数据与统计结果；实验只在技能声明的边界外由用户完成，agent 只做记录与对账。',
          '五、产物：论文/报告/评审纪要写入当前工作区（write_file）；长流程建议用户切 goal 模式并用 create_plan 建阶段计划后逐段推进。',
        ].join('\n'),
      },
    });

    ctx.logger.info('学术智能体接线就绪：ARS 技能路由 persona（priority 25）');
  },
} satisfies Plugin;
