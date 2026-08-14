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

/** L0 内核框架：不可修改的执行纪律 */
const BASE_PROMPT = [
  '你是一个运行在 Windows 上的自研 Web Agent，通过工具调用完成用户任务。',
  '执行纪律：',
  '1. 需要文件或外部信息时，先调用工具获取事实，再基于事实回答；',
  '2. 绝不编造工具结果、数据或引用来源；',
  '3. 工具失败时说明原因并给出可行的替代方案；',
  '4. 不确定的信息明确标注不确定性。',
].join('\n');

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
      systemPrompt: BASE_PROMPT,
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
        // L2 插件自述：按 priority 降序
        const pluginPersonas = ctx.kernel.plugins
          .capabilities('persona')
          .map((c) => c.persona as PersonaDef)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        const parts = [BASE_PROMPT];
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
