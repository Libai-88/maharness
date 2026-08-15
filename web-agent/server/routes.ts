/**
 * server/routes.ts —— REST + SSE API
 * 与插件解耦：对话服务通过能力注册表获取（kind=service, id=chat），不认识插件内部实现。
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express, Response } from 'express';
import type { Kernel } from '../kernel';
import type { LLMMessage, ProviderDef } from '../kernel/types';
import type { AgentRunner } from '../core/chat/agent';
import type { ProviderConfig } from '../core/chat/provider';
import { resolveInSandbox, readTextSmart } from '../core/tools-fs/index';
import { statSync, readdirSync, existsSync, writeFileSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { truncateHistory, estimateTokens } from './context';
import type { Store } from './db';

interface ChatService {
  providers: ProviderDef[];
  runner: AgentRunner;
  setProviders: (cfgs: ProviderConfig[]) => void;
  setPersonas: (list: { name: string; content: string }[]) => void;
  getSystemPrompt: () => string;
  approveApproval: (approvalId: string, approved: boolean) => boolean;
}

/** 用 DB 中的启用 Provider 刷新对话服务（热生效，无需重启） */
export function refreshChatProviders(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listProviders().filter((r) => r.enabled);
  chat.setProviders(rows.map((r) => ({
    id: r.id, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model,
    inputPrice: r.priceIn ?? undefined, outputPrice: r.priceOut ?? undefined,
  })));
}

/** 用 DB 中的启用人设刷新对话服务（L1 层，热生效） */
export function refreshChatPersonas(kernel: Kernel, store: Store): void {
  const chat = getChatService(kernel);
  if (!chat) return;
  const rows = store.listPersonas().filter((r) => r.enabled);
  chat.setPersonas(rows.map((r) => ({ name: r.name, content: r.content })));
}

function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function getChatService(kernel: Kernel): ChatService | undefined {
  const cap = kernel.plugins.capabilities('service').find((c) => c.service.id === 'chat');
  return cap?.service.instance as ChatService | undefined;
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerRoutes(app: Express, kernel: Kernel, store: Store): void {
  app.use(express.json({ limit: '5mb' }));

  // ---------- Provider 管理（网页端；DB 为唯一来源） ----------
  app.get('/api/providers', (_req, res) => {
    res.json(store.listProviders().map((r) => ({
      id: r.id, label: r.label, baseUrl: r.baseUrl, model: r.model,
      priceIn: r.priceIn, priceOut: r.priceOut, enabled: !!r.enabled,
      apiKeyMasked: maskKey(r.apiKey), hasKey: !!r.apiKey,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })));
  });

  app.post('/api/providers', (req, res) => {
    const { label, baseUrl, apiKey, model, priceIn, priceOut } = req.body ?? {};
    if (!label?.trim() || !baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
      return res.status(400).json({ error: '名称 / 地址 / Key / 模型 均为必填' });
    }
    const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'provider'}-${Math.random().toString(36).slice(2, 6)}`;
    store.upsertProvider({
      id, label: label.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(),
      priceIn: priceIn === '' || priceIn == null ? undefined : Number(priceIn),
      priceOut: priceOut === '' || priceOut == null ? undefined : Number(priceOut),
    });
    refreshChatProviders(kernel, store);
    const row = store.getProvider(id)!;
    res.json({ id: row.id, label: row.label, baseUrl: row.baseUrl, model: row.model, enabled: !!row.enabled, apiKeyMasked: maskKey(row.apiKey) });
  });

  app.patch('/api/providers/:id', (req, res) => {
    const existing = store.getProvider(req.params.id);
    if (!existing) return res.status(404).json({ error: '供应商不存在' });
    const { label, baseUrl, apiKey, model, priceIn, priceOut, enabled } = req.body ?? {};
    store.upsertProvider({
      id: existing.id,
      label: label?.trim() || existing.label,
      baseUrl: baseUrl?.trim() || existing.baseUrl,
      // Key 留空/不传 = 保持不变
      apiKey: apiKey?.trim() || existing.apiKey,
      model: model?.trim() || existing.model,
      priceIn: priceIn === undefined ? (existing.priceIn ?? undefined) : priceIn === '' ? undefined : Number(priceIn),
      priceOut: priceOut === undefined ? (existing.priceOut ?? undefined) : priceOut === '' ? undefined : Number(priceOut),
      enabled: enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    });
    refreshChatProviders(kernel, store);
    const row = store.getProvider(existing.id)!;
    res.json({ id: row.id, label: row.label, baseUrl: row.baseUrl, model: row.model, enabled: !!row.enabled, apiKeyMasked: maskKey(row.apiKey) });
  });

  app.delete('/api/providers/:id', (req, res) => {
    if (!store.getProvider(req.params.id)) return res.status(404).json({ error: '供应商不存在' });
    store.deleteProvider(req.params.id);
    refreshChatProviders(kernel, store);
    res.json({ ok: true });
  });

  /** 连接测试：直连 OpenAI 兼容接口发最小请求验证 key/地址/模型可用（编辑时可不传 key，用已保存的） */
  app.post('/api/providers/test', async (req, res) => {
    const { baseUrl, apiKey, model, providerId } = req.body ?? {};
    let useKey = apiKey;
    if (!useKey && providerId) {
      const row = store.getProvider(String(providerId));
      useKey = row?.apiKey;
    }
    if (!baseUrl?.trim() || !useKey?.trim() || !model?.trim()) {
      return res.status(400).json({ error: '地址 / Key / 模型 均为必填' });
    }
    try {
      const r = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${useKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return res.status(400).json({ ok: false, error: `HTTP ${r.status}: ${text.slice(0, 300)}` });
      }
      res.json({ ok: true, message: '连接成功' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 人设管理（L1 用户人设） ----------
  /** 预览三层组装后的完整系统提示词（调试/审计） */
  app.get('/api/personas/preview', (_req, res) => {
    const chat = getChatService(kernel);
    res.json({ systemPrompt: chat?.getSystemPrompt() ?? '(chat 服务未加载)' });
  });

  app.get('/api/personas', (_req, res) => {
    res.json(store.listPersonas());
  });

  app.post('/api/personas', (req, res) => {
    const { name, content, sortOrder } = req.body ?? {};
    if (!name?.trim() || !content?.trim()) {
      return res.status(400).json({ error: '名称与内容均为必填' });
    }
    const id = `persona-${Math.random().toString(36).slice(2, 8)}`;
    store.upsertPersona({ id, name: name.trim(), content: content.trim(), sortOrder: sortOrder === undefined ? store.listPersonas().length : Number(sortOrder) });
    refreshChatPersonas(kernel, store);
    res.json(store.getPersona(id));
  });

  app.patch('/api/personas/:id', (req, res) => {
    const existing = store.getPersona(req.params.id);
    if (!existing) return res.status(404).json({ error: '人设不存在' });
    const { name, content, enabled, sortOrder } = req.body ?? {};
    store.upsertPersona({
      id: existing.id,
      name: name?.trim() || existing.name,
      content: content?.trim() || existing.content,
      enabled: enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
      sortOrder: sortOrder === undefined ? existing.sortOrder : Number(sortOrder),
    });
    refreshChatPersonas(kernel, store);
    res.json(store.getPersona(existing.id));
  });

  app.delete('/api/personas/:id', (req, res) => {
    if (!store.getPersona(req.params.id)) return res.status(404).json({ error: '人设不存在' });
    store.deletePersona(req.params.id);
    refreshChatPersonas(kernel, store);
    res.json({ ok: true });
  });

  // ---------- Skills（内置 + 市场安装管理） ----------
  interface SkillService { list: () => { name: string; description: string; source: string }[]; get: (n: string) => { ok: boolean; content?: string; error?: string } }
  const getSkillsService = (): SkillService | undefined => {
    const cap = kernel.plugins.capabilities('service').find((c) => c.service.id === 'skills');
    return cap?.service.instance as SkillService | undefined;
  };
  const marketDir = join(kernel.rootDir, 'market');
  const userSkillsDir = join(kernel.rootDir, 'data', 'skills');

  /** 读取市场 skill 的 description（frontmatter） */
  function marketSkillDesc(dir: string): string {
    try {
      const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
      const m = md.match(/^---\n([\s\S]*?)\n---/);
      const desc = m?.[1].match(/description:\s*(.+)/);
      return desc ? desc[1].trim() : '(无描述)';
    } catch { return '(无描述)'; }
  }

  app.get('/api/skills', (_req, res) => {
    const installed = getSkillsService()?.list() ?? [];
    const market: { name: string; description: string }[] = [];
    if (existsSync(marketDir)) {
      for (const e of readdirSync(marketDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const skillDir = join(marketDir, e.name);
        if (!existsSync(join(skillDir, 'SKILL.md'))) continue;
        if (installed.some((s) => s.name === e.name)) continue; // 已安装不重复显示
        market.push({ name: e.name, description: marketSkillDesc(skillDir) });
      }
    }
    res.json({ installed, market });
  });

  app.post('/api/skills/install', async (req, res) => {
    const name = String(req.body?.name ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) return res.status(400).json({ error: '缺少技能名' });
    const src = join(marketDir, name);
    if (!existsSync(join(src, 'SKILL.md'))) return res.status(404).json({ error: `市场中不存在技能: ${name}` });
    const dest = join(userSkillsDir, name);
    if (existsSync(dest)) return res.status(400).json({ error: `技能已安装: ${name}` });
    mkdirSync(userSkillsDir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    try {
      await kernel.plugins.reload('skills'); // 热加载新技能
    } catch (err) {
      rmSync(dest, { recursive: true, force: true }); // 重载失败则回滚安装
      return res.status(500).json({ error: `技能安装失败（重载插件出错）: ${err instanceof Error ? err.message : String(err)}` });
    }
    res.json({ ok: true, name });
  });

  app.post('/api/skills/:name/uninstall', async (req, res) => {
    const name = String(req.params.name).replace(/[^a-zA-Z0-9_-]/g, '');
    const dest = join(userSkillsDir, name);
    if (!existsSync(dest)) return res.status(404).json({ error: `技能未安装: ${name}` });
    rmSync(dest, { recursive: true, force: true });
    await kernel.plugins.reload('skills');
    res.json({ ok: true, name });
  });

  app.get('/api/skills/:source/:name/read', (req, res) => {
    const { source, name } = req.params;
    const dir = source === 'builtin' ? join(kernel.rootDir, 'core', 'skills', 'builtin') : userSkillsDir;
    const mdPath = join(dir, String(name).replace(/[^a-zA-Z0-9_-]/g, ''), 'SKILL.md');
    if (!existsSync(mdPath)) return res.status(404).json({ error: '技能不存在' });
    res.json({ name, content: readFileSync(mdPath, 'utf-8') });
  });

  // ---------- 模型 ----------
  app.get('/api/models', (_req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json([]);
    res.json(chat.providers.map((p) => ({ id: p.id, label: p.label, model: p.defaultModel })));
  });

  // ---------- 斜杠命令 ----------
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

  // ---------- Capabilities Registry（能力发现） ----------
  /** 动态能力注册表：LLM 能力/风险/成本/审批/限制一目了然（人类与前端可查） */
  app.get('/api/capabilities', (_req, res) => {
    const tools = kernel.plugins.capabilities('tool').map((c) => ({
      name: c.tool.name,
      risk: c.tool.risk ?? 'low',
      costHint: c.tool.costHint ?? 'low',
      approval: c.tool.approval ?? false,
      limits: c.tool.limits ?? null,
      description: c.tool.description,
    }));
    const contexts = kernel.plugins.capabilities('context').map((c) => ({
      id: c.context.id,
      weight: c.context.weight ?? 0,
      description: c.context.description,
    }));
    const personas = kernel.plugins.capabilities('persona').map((c) => ({
      id: c.persona.id, name: c.persona.name, priority: c.persona.priority ?? 0,
    }));
    res.json({
      tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
      contexts,
      personas,
      byRisk: {
        high: tools.filter((t) => t.risk === 'high').map((t) => t.name),
        medium: tools.filter((t) => t.risk === 'medium').map((t) => t.name),
      },
    });
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
        store.updateSession(sessionId, { mode: name, planPending: name === 'plan' ? 1 : 0 });
        return res.json({ ok: true, type: 'action', data: { action: 'set_mode', mode: name } });
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

  // ---------- 会话 ----------
  app.get('/api/sessions', (_req, res) => res.json(store.listSessions()));

  app.post('/api/sessions', (req, res) => {
    const model = String(req.body?.model ?? '');
    res.json(store.createSession(model));
  });

  app.get('/api/sessions/:id/messages', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    res.json(store.listMessages(session.id));
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const { title, model, mode, archived, pinned } = req.body ?? {};
    if (mode !== undefined && !['normal', 'plan', 'goal'].includes(String(mode))) {
      return res.status(400).json({ error: 'mode 仅支持 normal / plan / goal' });
    }
    for (const [k, v] of [['archived', archived], ['pinned', pinned]] as const) {
      if (v !== undefined && v !== 0 && v !== 1 && v !== false && v !== true) {
        return res.status(400).json({ error: `${k} 仅支持 0/1` });
      }
    }
    store.updateSession(session.id, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof mode === 'string' ? { mode, planPending: mode === 'plan' ? 1 : 0 } : {}),
      ...(archived !== undefined ? { archived: archived ? 1 : 0 } : {}),
      ...(pinned !== undefined ? { pinned: pinned ? 1 : 0 } : {}),
    });
    res.json(store.getSession(session.id));
  });

  app.delete('/api/sessions/:id', (req, res) => {
    if (!store.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    store.deleteSession(req.params.id);
    res.json({ ok: true });
  });

  // 批量删除会话（事务原子；前端批量管理用）
  app.post('/api/sessions/batch-delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string').slice(0, 500)
      : [];
    if (ids.length === 0) return res.status(400).json({ error: '缺少 ids' });
    const removed = store.deleteSessions(ids);
    res.json({ ok: true, removed });
  });

  // ---------- 对话（SSE 流式） ----------
  app.post('/api/sessions/:id/chat', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const { message, model, provider: providerId, systemPrompt: systemPromptParam } = req.body ?? {};
    if (!message?.trim()) return res.status(400).json({ error: '消息不能为空' });
    // 编码防御：拒绝含替换符/孤立代理项的消息（防外部工具写入乱码）
    if (/\uFFFD/.test(message) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/.test(message)) {
      return res.status(400).json({ error: '消息包含无法识别的编码字符，请检查输入编码（应为 UTF-8）' });
    }

    const chat = getChatService(kernel);
    if (!chat) return res.status(500).json({ error: '对话服务未加载' });
    const provider = chat.providers.find((p) => p.id === providerId) ?? chat.providers[0];
    if (!provider) return res.status(500).json({ error: '未配置 LLM Provider，请先配置 .env' });
    const resolvedModel = model || session.model || provider.defaultModel;
    // 经济性（harness 管理认知资源）：会话累计成本超预算 → 强制注入成本警告
    // （不是"请 LLM 自觉节约"，而是 harness 直接告诉它预算边界）
    const sessionCost = store.listMessages(session.id).reduce((s, m) => s + (m.cost ?? 0), 0);
    const costBudget = kernel.config.get<number>('budget.maxSessionCost', 0);
    const costWarning = costBudget > 0 && sessionCost > costBudget
      ? `\n【成本预算警告】本会话累计成本 $${sessionCost.toFixed(5)} 已超过预算 $${costBudget.toFixed(5)}：请立即收敛——停止探索性工具调用，直接给出结论；如需继续深入，请告知用户新建会话。`
      : '';
    // 系统提示词：三层组装（L0 框架 + L1 用户人设 + L2 插件自述）+ 会话模式注入；body.systemPrompt 可临时覆盖（调试）
    const MODE_PROMPTS: Record<string, string> = {
      plan: '【当前模式：计划模式】先输出完整的执行计划（分步列表，含理由），等待用户确认后再执行任何工具；用户未明确同意前不得执行写操作。',
      goal: '【当前模式：目标模式】多步任务先用 create_plan 建立目标计划并随进度调用 update_plan_progress 更新；单步任务直接执行。',
    };
    const modePrompt = MODE_PROMPTS[session.mode];
    // 世界状态（context）：LLM 需要知道自己身处的世界——工作区、模式、可用工具、模型。
    // 内容只含会话内稳定事实（不含时间戳等易变项），同一会话内字节级稳定，
    // 不破坏 L3 前缀缓存；工作区/模式变更时内容随之更新（前缀失效一次，符合"世界变了"）。
    const sandboxNow = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    const worldState = [
      '【世界状态】',
      `- 沙箱根目录（工作区，文件工具路径相对此）: ${sandboxNow}`,
      `- 会话模式: ${session.mode}${modePrompt ? `（${modePrompt.replace(/^【当前模式：[^】]+】/, '').slice(0, 40)}…）` : ''}`,
      `- 模型: ${resolvedModel}`,
    ].join('\n');
    const systemPrompt = (typeof systemPromptParam === 'string' && systemPromptParam.trim()
      ? systemPromptParam
      : chat.getSystemPrompt()) + (modePrompt ? `\n\n${modePrompt}` : '') + `\n\n${worldState}` + costWarning;

    // 计划模式状态机：1=待出计划（不注入工具，强制先出计划）→ 2=已出计划待确认（放行工具）→ 0
    const planPending = session.planPending ?? 0;
    const toolsOverride = session.mode === 'plan' && planPending === 1 ? [] : undefined;

    // 历史组装：DB 消息 → LLM 消息（工具中间消息不入库，历史保持干净）
    const history: LLMMessage[] = store
      .listMessages(session.id)
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m): m is LLMMessage => m.role === 'user' || m.role === 'assistant');
    history.push({ role: 'user', content: message });

    store.addMessage({ sessionId: session.id, role: 'user', content: message });
    if (session.title === '新会话') store.updateSession(session.id, { title: message.slice(0, 30) });

    const traceId = randomUUID();
    // 上下文管理：超预算截断较早历史（保留 system 与最新消息，丢弃部分注入说明）
    const maxCtx = kernel.config.get<number>('context.maxTokens', 30000);
    const { messages: ctxHistory, truncated, droppedMessages } = truncateHistory(history, maxCtx);
    if (truncated) {
      kernel.trace.startStep({ traceId, turn: 0, type: 'system', name: '上下文截断' })
        .finish({ outputSummary: `超出预算（${maxCtx} tokens），已丢弃 ${droppedMessages} 条较早消息` });
    }
    const ac = new AbortController();
    // 客户端断开才中断（req close 在请求体读完即触发，不可用）
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 心跳：审批等待等长挂起场景防代理/客户端超时断开
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    res.on('close', () => clearInterval(heartbeat));
    sse(res, 'start', { traceId });

    let assistantText = '';
    let assistantReasoning = '';
    let usage = { input: 0, output: 0 };
    let cost = 0;
    try {
      for await (const ev of chat.runner.run({
        provider, model: resolvedModel, messages: ctxHistory, traceId,
        signal: ac.signal, systemPrompt, tools: toolsOverride,
        // 失败恢复：备用 provider（主服务宕机/限流时自动切换，LLM 无感）
        fallbackProviders: chat.providers.filter((p) => p.id !== provider.id),
      })) {
        if (ev.type === 'delta') {
          assistantText += ev.text;
          sse(res, 'delta', { text: ev.text });
        } else if (ev.type === 'reasoning') {
          assistantReasoning += ev.text;
          sse(res, 'reasoning', { text: ev.text });
        } else if (ev.type === 'tool_start') {
          sse(res, 'tool_start', { name: ev.name, args: ev.args });
        } else if (ev.type === 'approval_required') {
          sse(res, 'approval_required', { approvalId: ev.approvalId, name: ev.name, summary: ev.summary, args: ev.args });
        } else if (ev.type === 'tool_result') {
          sse(res, 'tool_result', { name: ev.name, summary: ev.summary, ok: ev.ok });
        } else if (ev.type === 'assistant_done') {
          usage = ev.usage;
          cost = ev.cost;
          sse(res, 'done', { content: ev.content, reasoning: ev.reasoning, usage: ev.usage, cost: ev.cost, cached: ev.cached ?? false });
        } else if (ev.type === 'error') {
          sse(res, 'error', { error: ev.error });
        }
      }
    } catch (err) {
      sse(res, 'error', { error: err instanceof Error ? err.message : String(err) });
    }
    if (assistantText) {
      store.addMessage({
        sessionId: session.id, role: 'assistant', content: assistantText,
        reasoning: assistantReasoning,
        tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
      });
    }
    // 计划模式状态推进：出计划轮完成 → 待确认；确认轮完成 → 回到无限制
    if (session.mode === 'plan' && planPending === 1) store.updateSession(session.id, { planPending: 2 });
    else if (session.mode === 'plan' && planPending === 2) store.updateSession(session.id, { planPending: 0 });
    store.touchSession(session.id);
    sse(res, 'end', {});
    res.end();
  });

  // ---------- 工作区（切换热生效：沙箱边界、文件 API、Agent 工具立即跟随） ----------
  app.get('/api/workspaces', (_req, res) => {
    const current = resolve(kernel.config.get<string>('sandboxRoot', kernel.rootDir));
    res.json(store.listWorkspaces().map((w) => ({
      id: w.id, path: w.path, current: resolve(w.path) === current,
    })));
  });

  app.post('/api/workspaces', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    if (!path) return res.status(400).json({ error: '缺少路径' });
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    const row = store.addWorkspace(abs);
    res.json({ id: row.id, path: row.path });
  });

  app.delete('/api/workspaces/:id', (req, res) => {
    if (!store.removeWorkspace(req.params.id)) return res.status(404).json({ error: '工作区不存在' });
    res.json({ ok: true });
  });

  app.post('/api/workspaces/switch', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    kernel.config.set('sandboxRoot', abs); // 运行时热切换（文件工具/文件 API 下一轮生效）
    res.json({ ok: true, current: abs });
  });

  /** 文件树（单层，前端懒加载展开；忽略噪音目录） */
  const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'data', '.dsh', '.idea', '__pycache__', 'coverage']);
  app.get('/api/files/tree', (req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const dir = resolveInSandbox(sandbox, String(req.query.path ?? '.'));
      if (!existsSync(dir)) return res.status(404).json({ error: '目录不存在' });
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !TREE_IGNORE.has(e.name) && !e.name.startsWith('.'))
        .map((e) => {
          const full = resolve(dir, e.name);
          try {
            const s = statSync(full);
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s.size };
          } catch {
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
          }
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.json({ path: relative(sandbox, dir) || '.', entries });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 文件（沙箱内） ----------
  app.get('/api/files', (req, res) => {
    try {
      const dir = resolveInSandbox(kernel.config.get<string>('sandboxRoot', kernel.rootDir), String(req.query.path ?? '.'));
      if (!existsSync(dir)) return res.status(404).json({ error: '目录不存在' });
      const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
        const full = resolve(dir, e.name);
        try {
          const s = statSync(full);
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
        } catch {
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
        }
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.json({ path: relative(kernel.config.get<string>('sandboxRoot', kernel.rootDir), dir) || '.', entries });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/read', (req, res) => {
    try {
      const file = resolveInSandbox(kernel.config.get<string>('sandboxRoot', kernel.rootDir), String(req.query.path ?? ''));
      if (!existsSync(file)) return res.status(404).json({ error: '文件不存在' });
      const r = readTextSmart(file);
      if (r.isBinary) return res.status(400).json({ error: '二进制文件不支持读取' });
      res.json({ path: relative(kernel.config.get<string>('sandboxRoot', kernel.rootDir), file), text: r.text, encoding: r.encoding });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/files/write', (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (!path || content === undefined) return res.status(400).json({ error: '需要 path 与 content' });
      const file = resolveInSandbox(kernel.config.get<string>('sandboxRoot', kernel.rootDir), String(path));
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, String(content), 'utf8');
      res.json({ ok: true, path: relative(kernel.config.get<string>('sandboxRoot', kernel.rootDir), file) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 插件管理 ----------
  app.get('/api/plugins', (_req, res) => {
    res.json(kernel.plugins.list().map((p) => ({
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
      state: p.state, caps: p.caps.map((c) => c.kind), error: p.error,
    })));
  });

  app.post('/api/plugins/:id/actions', async (req, res) => {
    const { action } = req.body ?? {};
    const id = req.params.id;
    try {
      if (action === 'enable') await kernel.plugins.enable(id);
      else if (action === 'disable') await kernel.plugins.disable(id);
      else if (action === 'reload') await kernel.plugins.reload(id);
      else return res.status(400).json({ error: `未知操作: ${action}` });
      const inst = kernel.plugins.get(id);
      res.json({ ok: true, state: inst?.state });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- Trace 观测 ----------
  app.get('/api/trace', (req, res) => {
    const traceId = req.query.trace_id ? String(req.query.trace_id) : undefined;
    const type = req.query.type ? String(req.query.type) : undefined;
    const name = req.query.name ? String(req.query.name) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ steps: kernel.trace.query(traceId, { type, name, limit }) });
  });

  app.get('/api/trace/stats', (_req, res) => {
    res.json({ trace: kernel.trace.statsSnapshot(), cache: kernel.cache.statsSnapshot(), l1Enabled: kernel.cache.l1Enabled });
  });

  // ---------- 统计（上下文用量 / 缓存命中率 / 总体概览） ----------
  app.get('/api/stats', (_req, res) => {
    const trace = kernel.trace.stats();
    const cache = kernel.cache.stats();
    const overview = store.statsOverview();
    const maxCtx = kernel.config.get<number>('context.maxTokens', 30000);
    const rate = (hits: number, misses: number): { hits: number; misses: number; rate: number } => {
      const total = hits + misses;
      return { hits, misses, rate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0 };
    };
    // 每会话：消息量 / 成本 / 估算上下文用量（与预算对比）/ 截断次数
    const perSession = store.listSessions().map((s) => {
      const msgs = store.listMessages(s.id);
      const truncations = msgs.filter((m) => m.role === 'system' && (m.content ?? '').includes('上下文管理')).length;
      const estimatedTokens = msgs.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
      return {
        id: s.id, title: s.title, mode: s.mode,
        messages: msgs.length,
        tokensIn: msgs.reduce((sum, m) => sum + (m.tokensIn ?? 0), 0),
        tokensOut: msgs.reduce((sum, m) => sum + (m.tokensOut ?? 0), 0),
        cost: msgs.reduce((sum, m) => sum + (m.cost ?? 0), 0),
        estimatedTokens,
        contextBudget: maxCtx,
        contextUsage: Math.min(999, Math.round((estimatedTokens / Math.max(maxCtx, 1)) * 1000) / 10),
        truncated: truncations > 0,
        truncations,
      };
    });
    res.json({
      overview: { ...overview, cacheHitSteps: trace.cacheHits },
      process: {
        steps: trace.steps, llmCalls: trace.llmCalls, toolCalls: trace.toolCalls,
        tokensIn: trace.totalTokensIn, tokensOut: trace.totalTokensOut, cost: trace.totalCost,
      },
      context: { maxTokens: maxCtx, perSession },
      taskProfile: kernel.budget.taskProfile(),
      cache: {
        l1Enabled: kernel.cache.l1Enabled,
        l1: rate(cache.l1Hits, cache.l1Misses),
        l2: rate(cache.l2Hits, cache.l2Misses),
        l3: { hits: cache.l3Hits, tokens: cache.l3Tokens },
        savedCost: cache.savedCost,
        // 综合命中率：L1 直接回答 + L2 工具结果 + L3 前缀复用 占总轮次比例
        overall: (() => {
          const served = cache.l1Hits + cache.l2Hits + cache.l3Hits;
          const total = trace.llmCalls + trace.toolCalls + cache.l1Hits;
          return { served, total, rate: total > 0 ? Math.round((served / total) * 1000) / 10 : 0 };
        })(),
      },
    });
  });

  // ---------- 审批（执行器级安全机制） ----------
  app.post('/api/approvals/:id', (req, res) => {
    const approved = req.body?.approved === true;
    const chat = getChatService(kernel);
    if (!chat) return res.status(500).json({ error: '对话服务未加载' });
    const ok = chat.approveApproval(req.params.id, approved);
    if (!ok) return res.status(404).json({ error: '审批不存在或已过期' });
    res.json({ ok: true, approved });
  });

  // ---------- 全局事件流（前端实时面板） ----------
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 心跳：长连接保活
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    const off = kernel.bus.on('*', (e) => {
      sse(res, 'event', { type: e.type, traceId: e.traceId, data: e.data, ts: e.ts });
    });
    req.on('close', () => { off(); clearInterval(heartbeat); });
  });
}
