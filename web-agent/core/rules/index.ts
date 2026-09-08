/**
 * core/rules/index.ts —— 用户规则系统（全局规则 + 项目规则 + 策略规则）
 * 提示规则：data/rules/*.md（全局）与 AGENTS.md / CLAUDE.md / .claude/CLAUDE.md /
 *          .maharness/rules/*.md（项目）→ 注册为「用户规则」persona 层（priority 40，
 *          排在插件自述之前）；persona 集变化会触发主提示词自动重装，故规则文件改完即生效。
 * 策略规则：data/rules.json 与 <workspace>/.maharness/rules.json → 在 agent.before_tool 上
 *          执行 allow / deny / require-approval（allow 跳过审批门并在 Trace 留痕）。
 * 重载：5s 轮询 mtime 指纹 + sandboxRoot 切换 + rules.* 配置变更。
 */
import { join } from 'node:path';
import type { Plugin } from '../../kernel/types';
import { loadPromptRules, loadPolicyRules, rulesSignature, matchPolicy } from '../../kernel/rules';
import type { PolicyRule, RuleSource } from '../../kernel/rules';

/** agent.before_tool 钩子负载中本插件用到的字段（与 core/chat/agent.ts 的 AgentHookCtx 对齐） */
interface BeforeToolCtx {
  tool?: { name: string; args: unknown };
  blocked?: boolean;
  blockReason?: string;
  policyApproved?: boolean;
}

const PREAMBLE = '用户规则（优先级高于插件自述，低于 harness 硬性安全边界；与规则冲突时说明无法执行的部分，不要静默忽略）：';
const POLL_MS = 5_000;

export default {
  id: 'rules',
  name: '用户规则',
  version: '0.1.0',
  onLoad(ctx) {
    const enabled = ctx.config.get<boolean>('rules.enabled', true);
    const policyEnabled = ctx.config.get<boolean>('rules.policyEnabled', true);
    const maxChars = Math.max(1000, ctx.config.get<number>('rules.maxChars', 12_000));
    const dataDir = ctx.paths.data;

    let promptText = '';
    let sources: RuleSource[] = [];
    let policy: PolicyRule[] = [];
    let errors: string[] = [];
    let sig = '';
    let unregisterPersona: (() => void) | null = null;

    function publish(): void {
      unregisterPersona?.();
      unregisterPersona = null;
      if (!enabled || !promptText) return;
      unregisterPersona = ctx.register({
        kind: 'persona',
        persona: {
          id: 'user-rules',
          name: '用户规则',
          description: '全局与项目自定义规则（AGENTS.md / CLAUDE.md / data/rules）',
          priority: 40,
          tier: 'user',
          content: `${PREAMBLE}\n\n${promptText}`,
        },
      });
    }

    function refresh(force = false): boolean {
      const projectRoot = ctx.config.get<string>('sandboxRoot', ctx.paths.root);
      const r = loadPromptRules({ dataDir, projectRoot, maxChars });
      const next = rulesSignature(r.sources);
      if (!force && next === sig) return false;
      const p = loadPolicyRules([join(dataDir, 'rules.json'), join(projectRoot, '.maharness', 'rules.json')]);
      sig = next;
      promptText = r.text;
      sources = r.sources;
      policy = p.rules;
      errors = p.errors;
      publish();
      ctx.logger.info(`规则已生效：${r.sources.filter(s => s.exists).length} 个来源 / ${r.text.length} 字符 / 策略 ${p.rules.length} 条${p.errors.length ? ` / ${p.errors.length} 个策略文件解析失败` : ''}`);
      return true;
    }
    refresh(true);

    const timer = setInterval(() => { try { refresh(); } catch { /* 轮询失败等下一轮 */ } }, POLL_MS);
    (timer as { unref?: () => void }).unref?.();
    ctx.watchConfig('sandboxRoot', () => refresh(true));
    ctx.watchConfig('rules.*', () => refresh(true));

    ctx.on('agent.before_tool', (e) => {
      const data = e.data as BeforeToolCtx | undefined;
      if (!policyEnabled || !data?.tool || policy.length === 0) return;
      const hit = matchPolicy(policy, data.tool.name, data.tool.args);
      if (!hit) return;
      if (hit.effect === 'deny') {
        data.blocked = true;
        data.blockReason = `已被用户策略规则拒绝（${hit.id}${hit.reason ? `：${hit.reason}` : ''}）`;
        return;
      }
      if (hit.effect === 'allow') data.policyApproved = true;
    });

    ctx.register({
      kind: 'service',
      service: {
        id: 'rules',
        instance: {
          /** 子代理/并行/评审继承主会话用户规则 */
          promptBlock: (): string => (enabled ? promptText : ''),
          sources: () => sources,
          policy: () => policy,
          errors: () => errors,
          reload: () => refresh(true),
          paths: () => ({
            globalDir: join(dataDir, 'rules'),
            globalPolicy: join(dataDir, 'rules.json'),
            projectRoot: ctx.config.get<string>('sandboxRoot', ctx.paths.root),
          }),
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_rules',
        risk: 'low',
        costHint: 'low',
        output: '{sources, promptChars, policy, errors}',
        description: '查看当前生效的用户规则来源（全局/项目文件）与策略规则。用户问「你遵守哪些规则/项目有什么约定」时调一次即可。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          refresh();
          return { ok: true, data: { sources: sources.filter(s => s.exists), promptChars: promptText.length, policy, errors } };
        },
      },
    });

    ctx.logger.info(`规则系统就绪：提示规则 ${promptText.length} 字符 / 策略规则 ${policy.length} 条（全局 ${join(dataDir, 'rules')}，项目 AGENTS.md·CLAUDE.md·.maharness/rules）`);
  },
} satisfies Plugin;
