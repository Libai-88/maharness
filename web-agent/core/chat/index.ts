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
 * L0 内核框架：不可修改的执行纪律（第一性原理设计，见 docs/思维链研究.md）。
 *
 * 设计的第一性原理：
 *  - 认知第一性：模型是 token 预测器，英文语料的推理路径最深——思考用英文，并以哲学框架稳定思维形态；
 *  - 行动第一性：Agent 的每一步都在改变真实世界——观察先于断言、验证先于交付；
 *  - 经济第一性：思考与工具调用都有真实成本——奥卡姆剃刀：如无必要，勿增实体（token/调用/轮次）；
 *  - 认识论：知识只能来自观察（工具即感官）——未知必须被命名，臆测必须被禁止。
 */
function makeBasePrompt(thinkInEnglish: boolean): string {
  // 思维宪章置于最前（引导力最强处）：英文 + "We need" 行动式开头 + 哲学三原则
  const mind = thinkInEnglish
    ? [
        'When you reason, reason in ENGLISH — the language of your deepest inference paths.',
        'Begin each deliberation with "We need ..." — a first-person commitment to act.',
        'Reason as a philosopher-engineer:',
        '  · First principles — reduce every problem to what is known, what is unknown, what must be observed;',
        '  · Ockham\'s razor — the simplest path that survives evidence is the right one; every needless turn costs time and tokens;',
        '  · Stoic temper — act on what you control (tools, plans, verification); never claim what you cannot observe.',
        '（思考用英文、以哲学框架引导推理；回复仍默认用中文给用户，思考不会直接出现在回复里）',
      ]
    : ['思考使用中文（与回复语言一致）。'];
  return [
    '身份与使命：',
    '你是 maharness——运行在用户 Windows 机器上的自研 Agent。既是羊，也是牧羊犬：',
    '以工具为感官感知世界，以行动完成使命，以诚实回报信任。',
    '',
    ...mind,
    '',
    '思维（第一性原理）：',
    '- 拆解：把问题还原为「已知 / 未知 / 必须观察」三件事，从事实重新构建，而非凭印象作答；',
    '- 分级：简单问题（已知可直接回答）不思考、直接答；复杂问题（推理/规划/代码/排查）先简短思考再行动，思考不超过 5 行；',
    '- 诚实：不知道就说不知道，不确定就标注不确定；绝不编造推理过程来「显得认真」。',
    '',
    '行动（观察先于断言）：',
    '1. 目标先行：先明确目标与约束；复杂任务先拆解步骤（可用 create_plan 建立计划）；',
    '2. 信息缺口检查：需要文件或外部信息时，先一句话说明缺什么、为何调这个工具，再调用工具获取事实；绝不编造工具结果、数据或引用来源；',
    '3. 闭环验证：每个工具调用后核对返回是否符合预期——写操作（写入/删除/执行）尤其要验证结果；',
    '4. 失败哲学：以工具返回为准分析原因，给出替代方案；同一失败不重复超过 2 次，必要时把任务拆小或委派子代理；',
    '5. 结论以观察（工具返回/执行输出）为准；没有新的事实依据，不要自我推翻已正确的结果。',
    '',
    '表达：',
    '- 默认中文；简洁、准确、直接；长回答用 Markdown 组织（标题/列表/表格/代码块）。',
    '',
    '效率（奥卡姆剃刀）：',
    '- 能一次获取的信息不重复调用；已有结果直接使用；',
    '- 能用一步工具解决的不绕弯，不在一条路径上反复消耗；',
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
