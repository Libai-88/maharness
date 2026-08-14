/**
 * core/chat/index.ts —— 对话引擎插件
 * 证明"连对话都是插件"：本插件通过能力注册表暴露 chat 服务，server 层只认服务接口。
 */
import type { Plugin } from '../../kernel/types';
import { AgentRunner } from './agent';
import { createProvider, discoverProviders, setupEmbedding } from './provider';

export default {
  id: 'chat',
  name: '对话引擎',
  version: '0.1.0',
  async onLoad(ctx) {
    const providers = discoverProviders().map(createProvider);
    setupEmbedding(ctx); // 配置了 EMBEDDING_* 则激活 L1 语义缓存
    const runner = new AgentRunner(ctx.kernel);
    ctx.register({
      kind: 'service',
      service: { id: 'chat', instance: { providers, runner } },
    });
    ctx.logger.info(
      providers.length
        ? `已加载 Provider: ${providers.map((p) => `${p.label}(${p.defaultModel})`).join(', ')}`
        : '未发现 LLM Provider——请在 .env 配置至少一组 <NAME>_BASE_URL/_API_KEY/_MODEL',
    );
  },
} satisfies Plugin;
