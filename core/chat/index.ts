/**
 * core/chat/index.ts —— 对话引擎插件
 * 证明"连对话都是插件"：本插件通过能力注册表暴露 chat 服务，server 层只认服务接口。
 * Provider 支持热更新：网页端增删改后调用 setProviders，新对话立即生效（无需重启）。
 */
import type { Plugin } from '../../kernel/types';
import { AgentRunner } from './agent';
import { createProvider, discoverProviders, setupEmbedding, type ProviderConfig } from './provider';

export default {
  id: 'chat',
  name: '对话引擎',
  version: '0.1.0',
  async onLoad(ctx) {
    const providers = discoverProviders().map(createProvider);
    setupEmbedding(ctx); // 配置了 EMBEDDING_* 则激活 L1 语义缓存
    const runner = new AgentRunner(ctx.kernel);
    const service: {
      providers: ReturnType<typeof createProvider>[];
      runner: AgentRunner;
      setProviders: (cfgs: ProviderConfig[]) => void;
    } = {
      providers,
      runner,
      setProviders(cfgs: ProviderConfig[]) {
        service.providers = cfgs.map(createProvider);
        ctx.logger.info(
          service.providers.length
            ? `Provider 已热更新: ${service.providers.map((p) => `${p.label}(${p.defaultModel})`).join(', ')}`
            : 'Provider 已清空（请在网页端设置中添加）',
        );
      },
    };
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
