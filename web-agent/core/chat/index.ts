import { callModel } from '../../kernel/model-call';
/**
 * core/chat/index.ts —— 对话引擎插件
 * 证明"连对话都是插件"：本插件通过能力注册表暴露 chat 服务，server 层只认服务接口。
 *
 * 提示词由运行环境与用户明确配置的人设组成。
 * 插件能力通过工具描述与发现接口暴露。
 */
import type { Plugin } from '../../kernel/types';
import { SERVICE_KEYS } from '../../kernel/types';
import { AgentRunner, defaultRunnerFactory, annotateToolDef, redactTraceValue } from './agent';
import { compactHistory } from './compact';
import { routeForCapability, routeForTask, type CapabilityNeed } from './routing';
import { getProviderHealth } from './provider-health';
import { MODE_PROMPTS, ROLE_READONLY_TOOLS, validateCheckpointHistory } from './policy';
import { createProvider, discoverProviders, setupEmbedding, type ProviderConfig } from './provider';
import { createResultTool } from './result-tool';
// 审批共享板：挂起清单要能经服务接口暴露（刷新页面后审批卡原位复原，不再"卡没了但服务端还在等"）
import { globalApprovalBoard, type PendingApproval } from './approvals';
import type { ProviderGateway } from '../../kernel/provider-gateway';

function makeBasePrompt(): string {
  return [
    '【Agent 运行时】',
    '你是 maharness 框架中的主代理，具备工具、文件、网络、记忆、技能、MCP、子代理等能力。身份、语气与偏好由已注入的人设层定义；未定义时保持简洁专业。',
    '优先使用原生 tool_call，直接推进任务；无需先复述计划或解释每个调用。判断依据以工具返回为准，不要编造结果；破坏性操作会由 harness 审批边界拦截。',
    '多步任务可自主选择是否建立计划；计划是协作工具，不是固定流程。发现更优路径时调整并继续执行。',
    '',
  ].join('\n');
}

export default {
  id: 'chat',
  name: '对话引擎',
  version: '0.1.0',
  async onLoad(ctx) {
    const providers = discoverProviders().map(createProvider);
    const embeddingService = setupEmbedding(ctx); // 配置了 EMBEDDING_* 则激活 L1 语义缓存
    if (embeddingService) {
      ctx.register({ kind: 'service', service: { id: 'embedding', instance: embeddingService } });
    }
    const runner = new AgentRunner(ctx.kernel, ctx.bus);

    // ---- 执行循环即插件：把默认循环注册为 service:runner ----
    // 内核不含循环，只提供原语；本插件提供【默认实现】。任何插件以更高优先级
    // 提供同一键即可整体替换循环（ReAct/Reflexion/两段式…），顶层对话/子代理/并行
    // 三条路径统一经 resolveRunner() 取循环——替换一次全局生效。
    // priority 0 = 与内核内置子系统同权；后到者不静默顶掉（同优先级先到者胜）。
    ctx.provide(SERVICE_KEYS.runner, defaultRunnerFactory, 0);

    const service: {
      providers: ReturnType<typeof createProvider>[];
      runner: AgentRunner;
      systemPrompt: string;
      userPersonas: { name: string; content: string }[];
      setProviders: (cfgs: ProviderConfig[]) => void;
      setPersonas: (list: { name: string; content: string }[]) => void;
      getSystemPrompt: () => string;
      getRuntimePrompt: () => string;
      getUserContext: () => import('../../kernel/types').LLMMessage[];
      refreshPrompt: () => void;
      /** 挂起审批清单（可按会话过滤）：前端刷新后据此恢复审批卡 */
      listApprovals: (sessionId?: string) => PendingApproval[];
      // 供 server 层使用的服务方法（避免直接 import core/chat 子模块）
      compactHistory: typeof compactHistory;
      annotateToolDef: typeof annotateToolDef;
      routeForTask: typeof routeForTask;
      MODE_PROMPTS: typeof MODE_PROMPTS;
      ROLE_READONLY_TOOLS: typeof ROLE_READONLY_TOOLS;
      validateCheckpointHistory: typeof validateCheckpointHistory;
    } = {
      providers,
      runner,
      systemPrompt: makeBasePrompt(),
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
        // 用户作用域的人设按 priority 降序排列。
        const parts = [makeBasePrompt()];
        for (const p of service.userPersonas) parts.push(`【${p.name}】\n${p.content}`);
        service.systemPrompt = parts.join('\n\n');
      },
      getSystemPrompt: () => service.systemPrompt,
      getRuntimePrompt: makeBasePrompt,
      getUserContext: () => [
        ...service.userPersonas.map((persona, index) => ({ id: `persona:${index}`, ...persona })),
        ...ctx.kernel.plugins.capabilities('persona').map(cap => cap.persona).filter(persona => persona.tier === 'user' && persona.id !== 'user-rules'),
      ].map(persona => ({ role: 'user', content: persona.content, context: { id: persona.id, source: `user-settings:${persona.name}`, scope: 'workspace', trust: 'user', retention: 'required' } })),
      /** 挂起审批清单（可按会话过滤）：前端首屏/刷新后据此恢复审批卡 */
      listApprovals: (sessionId?: string): PendingApproval[] =>
        globalApprovalBoard.listPending(sessionId).map((a) => ({ ...a, args: redactTraceValue(a.args) })),
      // 供 server 层使用的服务方法（避免直接 import core/chat 子模块）
      compactHistory,
      annotateToolDef,
      routeForTask,
      MODE_PROMPTS,
      ROLE_READONLY_TOOLS,
      validateCheckpointHistory,
    };

    // 反应性共效应（时空可组合性 v2）：声明「依赖什么」，运行时在变化时通知——
    // 取代手写监听 plugin.loaded/unloaded/reloaded + config.changed 的旧式做法：
    //  - onCapabilities('persona')：persona 能力集变化（插件加载/卸载/重载带人设）→ 自动重装；
    //  - watchConfig('agent.thinkInEnglish')：配置键变化（最小干预，只关注自己关心的键）→ 自动重装。
    // 两者均自动退订（可逆效应）：chat 卸载时订阅随作用域回收，无监听器泄漏。
    ctx.onCapabilities('persona', () => service.refreshPrompt());

    // ---- 角色注册表：内置主代理角色 + handoff_to 移交工具 ----
    // 角色=插件（万物皆插件）：任意插件可注册角色，角色注册表动态枚举进移交路径。
    // 移交语义（OpenAI Agents SDK handoff 的 maharness 版）：执行器识别 handoff 返回 →
    // 终止当前循环 → 会话记录新角色 → 后续对话由新角色提示词/工具集接管（热切换，无需重启）。
    const roleDefs = () => ctx.kernel.plugins.capabilities('role').map((c) => c.role);
    ctx.register({
      kind: 'role',
      role: {
        id: 'main',
        name: '主代理',
        description: '默认主代理：通用对话、文件操作、规划与执行。任务完成后交回主代理用 role=main。',
        systemPrompt: makeBasePrompt(),
        tools: 'all',
      },
    });
    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: [],
        name: 'handoff_to',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'none',
        output: '{handedOff, role, name}',
        outputSchema: {
          type: 'object', required: ['handedOff', 'role', 'name'],
          properties: { handedOff: { type: 'boolean' }, role: { type: 'string' }, name: { type: 'string' } },
        },
        description: '把当前任务移交给指定角色（专业化分工）：移交后本代理立即停止，后续对话由目标角色接管（其提示词与工具集热切换，无需重启）。' +
          '适用：任务类型超出本角色定位（如深度编码/审查/规划）；移交时说明任务目标、已完成与未完成的部分、对新角色的要求。' +
          '角色不存在时错误信息会列出当前全部可用角色。交回主代理：role=main。',
        parameters: {
          type: 'object',
          properties: {
            role: { type: 'string', description: '目标角色 id（可用角色见错误提示）' },
            objective: { type: 'string', description: '移交说明：任务目标、已完成部分、未完成部分、对新角色的要求（≤500 字）' },
          },
          required: ['role', 'objective'],
        },
        async handler(args: { role?: string; objective?: string }) {
          const role = String(args.role ?? '').trim();
          const objective = String(args.objective ?? '').trim();
          if (!role) return { ok: false, error: '缺少 role' };
          if (!objective) return { ok: false, error: '缺少 objective（说明任务目标与已完成/未完成部分）' };
          const defs = roleDefs();
          const def = defs.find((r) => r.id === role);
          if (!def) {
            return { ok: false, error: `角色不存在: ${role}。可用角色: ${defs.map((r) => `${r.id}(${r.name})`).join('、') || '无（仅主代理可用 main）'}` };
          }
          return {
            ok: true,
            data: { handedOff: true, role: def.id, name: def.name },
            handoff: { role: def.id, objective },
          };
        },
      },
    });

    ctx.register({
      kind: 'service',
      service: { id: 'chat', instance: service },
    });

    const providerGateway: ProviderGateway = {
      call: callModel,
      providers: () => service.providers,
      getProvider: (id) => service.providers.find((provider) => provider.id === id),
      models: (providerId) => service.providers
        .filter((provider) => !providerId || provider.id === providerId)
        .flatMap((provider) => (provider.models ?? []).map((model) => ({
          providerId: provider.id,
          providerLabel: provider.label,
          model,
        }))),
      routeTask: (taskText, routing) => routeForTask(taskText, routing, service.providers),
      routeCapability: (need, current) => routeForCapability(need as CapabilityNeed, service.providers, current),
      health: (providerId) => getProviderHealth(providerId),
      embedding: () => embeddingService ?? undefined,
    };
    ctx.register({ kind: 'service', service: { id: 'provider-gateway', instance: providerGateway } });

    ctx.register({ kind: 'tool', tool: createResultTool() });

    ctx.logger.info(
      providers.length
        ? `已加载 Provider: ${providers.map((p) => `${p.label}(${p.defaultModel})`).join(', ')}`
        : '未发现 LLM Provider——请在网页端「设置」中添加',
    );
  },
} satisfies Plugin;
