/**
 * core/chat/index.ts —— 对话引擎插件
 * 证明"连对话都是插件"：本插件通过能力注册表暴露 chat 服务，server 层只认服务接口。
 *
 * 三层系统提示词（指引 LLM 智商发挥的关键设计）：
 *  L0 内核框架  ：固定执行纪律（本文件 BASE_PROMPT）
 *  L1 用户人设  ：DB 存储，网页设置面板管理（setPersonas 注入），可多套启停排序
 *  L2 插件自述  ：任意插件注册 persona 能力，自动叠加；插件卸载规则自动消失
 * 组装结果热更新：人设变更 / 插件加载卸载 / 重载，立即影响新对话，无需重启。
 */
import type { PersonaDef, Plugin } from '../../kernel/types';
import { AgentRunner } from './agent';
import { createProvider, discoverProviders, setupEmbedding, type ProviderConfig } from './provider';

/**
 * L0 内核框架：不可修改的执行纪律（含思维链引导——基于 docs/思维链研究.md 的结论）。
 * 思维语言可配：agent.thinkInEnglish=true（默认）时思考用英文并以 "We need" 开头——
 * 英文推理路径更成熟稳定（模型训练语料英文主导），固定开头触发行动导向的结构化思考。
 */
function makeBasePrompt(thinkInEnglish: boolean): string {
  // 英文思考指令置于最前（社区验证的触发位）：对部分推理模型的原生 reasoning 亦有引导作用
  const thinkingLang = thinkInEnglish
    ? [
        'When you think, think in ENGLISH. Start your reasoning with "We need ..." and keep it concise, concrete, action-oriented.',
        '（思考用英文能提升推理稳定性与质量；回复仍默认用中文给用户，思考不会直接出现在回复里）',
      ]
    : ['思考使用中文（与回复语言一致）。'];
  return [
    '你是一个运行在 Windows 上的自研 Web Agent（maharness），通过工具调用完成用户任务。',
    '',
    ...thinkingLang,
    '',
    '思考策略（按任务分级控制思考投入，思考有成本）：',
    '- 简单任务（问候、常识问答、格式整理、已有信息直接可答）：直接回答，不展开思考；',
    '- 复杂任务（多步计算、逻辑推理、规划、代码编写、问题排查）：先简短思考再行动，思考不超过 5 行；',
    '- 思考放内部（前端已单独展示，仅推理模型可见），最终回复只给结论与关键依据，不重复思考过程；',
    '- 不要为了「显得认真」而编造思考过程——没有把握就直接说没有把握。',
    '',
    '工作方式（思考-行动-观察循环）：',
    '1. 收到任务先明确目标与约束；复杂任务先拆解步骤（可用 create_plan 建立计划）；',
    '2. 信息缺口检查：需要文件或外部信息时，先一句话说明缺什么信息、为什么调这个工具，再调用工具获取事实；绝不编造工具结果、数据或引用来源；',
    '3. 每个工具调用后核对返回是否符合预期——写操作（写入/删除/执行）尤其要验证结果；',
    '4. 工具失败时以工具返回为准分析原因并给出可行的替代方案；同一失败不要重复超过 2 次，必要时把任务拆小或委派子代理；',
    '5. 结论以工具返回与代码执行输出为准；不要无依据地自我纠错——对的结果不要改，除非有新的事实依据；',
    '6. 回答简洁、准确、直接，默认使用中文；长回答用 Markdown 组织（标题/列表/表格/代码块）；',
    '7. 不确定的信息明确标注不确定性，不臆测工具未返回的内容。',
    '',
    '效率与成本：',
    '- 能一次获取的信息不重复调用；已有结果直接使用；',
    '- 思考有成本：能用一步工具解决的不绕弯，避免在一条路径上反复消耗 token；',
    '- 文件路径相对沙箱根目录；不确定路径先 list_dir 再操作；',
    '- 不读取 .env、密钥等敏感文件，除非用户明确要求。',
    '',
    '安全：',
    '- 破坏性操作（删除/覆盖/高危命令）会触发审批，等待用户批准；不诱导用户批准、不尝试绕过；',
    '- 遇到能力边界时明确说明不能做什么，并给出替代方案。',
  ].join('\n');
}

export default {
  id: 'chat',
  name: '对话引擎',
  version: '0.1.0',
  async onLoad(ctx) {
    const providers = discoverProviders().map(createProvider);
    setupEmbedding(ctx); // 配置了 EMBEDDING_* 则激活 L1 语义缓存
    const runner = new AgentRunner(ctx.kernel, ctx.bus);

    const service: {
      providers: ReturnType<typeof createProvider>[];
      runner: AgentRunner;
      systemPrompt: string;
      userPersonas: { name: string; content: string }[];
      setProviders: (cfgs: ProviderConfig[]) => void;
      setPersonas: (list: { name: string; content: string }[]) => void;
      getSystemPrompt: () => string;
      refreshPrompt: () => void;
      approveApproval: (approvalId: string, approved: boolean) => boolean;
    } = {
      providers,
      runner,
      systemPrompt: makeBasePrompt(ctx.config.get<boolean>('agent.thinkInEnglish', true)),
      userPersonas: [],
      setProviders(cfgs: ProviderConfig[]) {
        service.providers = cfgs.map(createProvider);
        ctx.logger.info(
          service.providers.length
            ? `Provider 已热更新: ${service.providers.map((p) => `${p.label}(${p.defaultModel})`).join(', ')}`
            : 'Provider 已清空（请在网页端设置中添加）',
        );
      },
      setPersonas(list) {
        service.userPersonas = list;
        service.refreshPrompt();
        ctx.logger.info(`人设已热更新: ${list.map((p) => p.name).join(', ') || '无'}`);
      },
      refreshPrompt() {
        // L2 插件自述：按 priority 降序；L0 思维语言按配置（agent.thinkInEnglish 热切换）
        const thinkInEnglish = ctx.config.get<boolean>('agent.thinkInEnglish', true);
        const pluginPersonas = ctx.kernel.plugins
          .capabilities('persona')
          .map((c) => c.persona as PersonaDef)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        const parts = [makeBasePrompt(thinkInEnglish)];
        for (const p of service.userPersonas) parts.push(`【${p.name}】\n${p.content}`);
        for (const p of pluginPersonas) parts.push(`【插件规则·${p.name}】\n${p.content}`);
        service.systemPrompt = parts.join('\n\n');
      },
      getSystemPrompt: () => service.systemPrompt,
      approveApproval: (approvalId: string, approved: boolean) => runner.approveApproval(approvalId, approved),
    };

    // 插件加载/卸载/重载 → 自动重装系统提示词（L2 层随插件增减）
    const refresh = () => service.refreshPrompt();
    ctx.bus.on('plugin.loaded', refresh);
    ctx.bus.on('plugin.unloaded', refresh);
    ctx.bus.on('plugin.reloaded', refresh);
    // 配置变更（如 agent.thinkInEnglish 切换思考语言）→ 热重装系统提示词
    ctx.bus.on('config.changed', refresh);

    ctx.register({
      kind: 'service',
      service: { id: 'chat', instance: service },
    });
    ctx.logger.info(
      providers.length
        ? `已加载 Provider: ${providers.map((p) => `${p.label}(${p.defaultModel})`).join(', ')}`
        : '未发现 LLM Provider——请在网页端「设置」中添加',
    );
  },
} satisfies Plugin;
