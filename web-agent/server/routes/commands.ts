/**
 * server/routes/commands.ts —— 斜杠命令（内置命令表 + 插件命令 + 命令分发）
 * BUILTIN_COMMANDS 是外壳层（server）关注的用户交互契约，留在本文件；
 * 对话模式/角色等策略见 core/chat/policy.ts。
 */
import type { Express } from 'express';
import { getChatService, type RouteDeps } from './shared';

/** 内置命令表：[/name, 参数说明, 说明] */
const BUILTIN_COMMANDS: [string, string, string][] = [
  ['help', '', '列出全部可用命令'],
  ['new', '', '新建会话'],
  ['clear', '', '清空当前会话的消息'],
  ['plan', '', '切换会话到计划模式'],
  ['goal', '', '切换会话到目标模式'],
  ['normal', '', '切换回普通模式'],
  ['model', '<名称>', '切换模型（如 /model deepseek-chat）'],
];

export function registerCommandRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  /** 当前全部命令（内置 + 插件），供前端命令面板渲染 */
  app.get('/api/commands/list', (_req, res) => {
    const pluginCmds = kernel.plugins.capabilities('command').map((c) => ({
      name: c.command.name,
      usage: '',
      description: c.command.description,
      source: 'plugin' as const,
    }));
    const builtin = BUILTIN_COMMANDS.map(([name, usage, description]) => ({ name, usage, description, source: 'builtin' as const }));
    res.json({ commands: [...builtin, ...pluginCmds] });
  });

  app.post('/api/commands', async (req, res) => {
    const input = String(req.body?.input ?? '').trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
    if (!input.startsWith('/')) return res.status(400).json({ error: '非斜杠命令' });
    const [name, ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ').trim();

    const fail = (error: string, status = 400) => res.status(status).json({ ok: false, error });

    switch (name) {
      case 'help': {
        const pluginCmds = kernel.plugins.capabilities('command').map((c) => [c.command.name, c.command.description]);
        const lines = [...BUILTIN_COMMANDS, ...pluginCmds]
          .map(([n, p, d]) => `/${n}${p ? ` ${p}` : ''} — ${d}`);
        return res.json({ ok: true, type: 'message', data: { text: `可用命令：\n${lines.join('\n')}` } });
      }
      case 'new':
        return res.json({ ok: true, type: 'action', data: { action: 'new_session' } });
      case 'clear': {
        if (!sessionId) return fail('缺少会话');
        if (!store.getSession(sessionId)) return fail('会话不存在', 404);
        store.clearSessionMessages(sessionId);
        return res.json({ ok: true, type: 'action', data: { action: 'clear' } });
      }
      case 'plan':
      case 'goal':
      case 'normal': {
        if (!sessionId) return fail('缺少会话');
        if (!store.getSession(sessionId)) return fail('会话不存在', 404);
        // normal = 回到主代理（handoff 角色清空）+ 普通模式；plan/goal 保留角色（角色与模式正交）
        const roleReset = name === 'normal' ? { role: '' } : {};
        store.updateSession(sessionId, { mode: name, planPending: name === 'plan' ? 1 : 0, ...roleReset });
        return res.json({ ok: true, type: 'action', data: { action: 'set_mode', mode: name, roleReset: name === 'normal' } });
      }
      case 'model': {
        if (!sessionId) return fail('缺少会话');
        if (!store.getSession(sessionId)) return fail('会话不存在', 404);
        const chat = getChatService(kernel);
        const p = chat?.providers.find((x) => x.defaultModel === arg || x.label === arg.toUpperCase() || x.id === arg);
        if (!p) return fail(`未找到模型: ${arg}（用 /help 查看，或查看右上角模型列表）`);
        store.updateSession(sessionId, { model: p.defaultModel });
        return res.json({ ok: true, type: 'action', data: { action: 'set_model', provider: p.id, model: p.defaultModel } });
      }
      default: {
        const cmd = kernel.plugins.capabilities('command').find((c) => c.command.name === name);
        if (!cmd) return fail(`未知命令: /${name}（输入 /help 查看全部命令）`, 404);
        try {
          const out = cmd.command.handler(rest);
          const text = out instanceof Promise ? String(await out) : String(out);
          return res.json({ ok: true, type: 'message', data: { text } });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }
    }
  });
}
