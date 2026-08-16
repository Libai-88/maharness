/**
 * server/routes.ts —— REST + SSE API
 * 与插件解耦：对话服务通过能力注册表获取（kind=service, id=chat），不认识插件内部实现。
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express, Response } from 'express';
import type { Kernel } from '../kernel';
import type { LLMMessage, LLMRole, ProviderDef } from '../kernel/types';
import type { Message } from '../kernel/types';
import type { AgentRunner } from '../core/chat/agent';
import type { ProviderConfig } from '../core/chat/provider';
import { resolveInSandbox, readTextSmart } from '../core/tools-fs/index';
import { annotateToolDef, textualizeHistory } from '../core/chat/agent';
import { statSync, readdirSync, existsSync, writeFileSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { truncateHistory, estimateTokens } from './context';
import { compactHistory } from '../core/chat/compact';
import type { Store } from './db';

// ============ 缓存预热/保活（L3 前缀缓存主动维护） ============
// 第一性原理：provider KV 缓存命中的充要条件是「请求前缀逐字节一致且缓存条目存活」。
// harness 已保证前缀一致（发送序列快照同步）；但网关对含 tool_calls 请求的缓存建立
// 存在延迟/条件限制，且前缀缓存有 TTL——跨 run 首轮因此可能全价 prefill。
// 预热机制：run 结束后延迟发送与最后请求同前缀的极小请求（max_tokens=1，成本≈0），
// 主动建立/刷新缓存条目；随后周期保活（默认 90s）维持缓存活性，直到会话长时间空闲。
interface WarmupEntry {
  timer: NodeJS.Timeout | null;
  systemPrompt: string;
  seq: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[];
  provider: ProviderDef;
  model: string;
  rounds: number;
  lastRunAt: number;
}

const warmups = new Map<string, WarmupEntry>();
const CONTINUE_HINT = '【继续】请根据工具结果继续处理任务；如任务已完成，直接给出最终回答。';
const WARMUP_DELAY_MS = 12_000;       // 首次预热延迟（网关缓存写入窗口）
const WARMUP_INTERVAL_MS = 90_000;  // 保活间隔（缓存 TTL 刷新）
const WARMUP_MAX_ROUNDS = 20;       // 最长保活 30 分钟（会话无新活动则停止）

/** 会话 run 结束后调度预热（新 run 到达时重置保活轮次） */
function scheduleWarmup(
  sessionId: string,
  systemPrompt: string,
  seq: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[],
  provider: ProviderDef,
  model: string,
  kernel: Kernel,
): void {
  const existing = warmups.get(sessionId);
  if (existing) {
    // 会话有新活动：重置保活轮次与计时
    existing.systemPrompt = systemPrompt;
    existing.seq = seq;
    existing.provider = provider;
    existing.model = model;
    existing.rounds = 0;
    existing.lastRunAt = Date.now();
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_DELAY_MS);
    return;
  }
  warmups.set(sessionId, {
    timer: setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_DELAY_MS),
    systemPrompt, seq, provider, model, rounds: 0, lastRunAt: Date.now(),
  });
}

/** 执行一次预热 + 调度下一次保活 */
async function warmupOnce(sessionId: string, kernel: Kernel): Promise<void> {
  const entry = warmups.get(sessionId);
  if (!entry) return;
  entry.timer = null;
  // 保活上限：会话长时间无新活动则停止（避免无限消耗）
  if (entry.rounds >= WARMUP_MAX_ROUNDS) {
    warmups.delete(sessionId);
    return;
  }
  entry.rounds++;
  // 预热序列 = 与真实发送完全同形态：原始 sync 消息 → 共享文本化（与 run 内/跨 run 一致）
  // → 恒以 user（CONTINUE_HINT）结尾。网关只对纯文本 + user 结尾的请求稳定缓存。
  const rawSeq: LLMMessage[] = [
    { role: 'system', content: entry.systemPrompt },
    ...entry.seq.map((m) => ({
      role: m.role as LLMMessage['role'],
      content: m.content,
      ...(m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls as never } : {}),
      ...(m.role === 'tool' && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
  ];
  const msgs = textualizeHistory(rawSeq);
  if (msgs[msgs.length - 1]?.role !== 'user') {
    msgs.push({ role: 'user', content: CONTINUE_HINT });
  }
  try {
    // 预热请求：与最后发送序列同前缀 + 相同 tools（网关缓存键含 tools 参数，
    // 不带 tools 的预热建立的缓存对真实请求无效）；max_tokens=1 成本≈0
    const tools = kernel.plugins.capabilities('tool').map((c) => c.tool).map(annotateToolDef);
    let hit = 0, miss = 0;
    for await (const chunk of entry.provider.chat(msgs, { model: entry.model, maxTokens: 64, tools })) {
      if (chunk.type === 'usage') { hit = chunk.cachedInput ?? 0; miss = chunk.missInput ?? 0; }
    }
    console.log(`[warmup] ${sessionId.slice(0, 8)} 完成（round ${entry.rounds}，${msgs.length} 条，hit=${hit} miss=${miss}）`);
  } catch (err) {
    console.warn(`[warmup] ${sessionId.slice(0, 8)} 预热失败:`, err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
  // 调度下一次保活（会话有新 run 时 scheduleWarmup 会重置）
  const cur = warmups.get(sessionId);
  if (cur) {
    cur.timer = setTimeout(() => void warmupOnce(sessionId, kernel), WARMUP_INTERVAL_MS);
  }
}
import type { ClientTracker } from './client-tracker';

const execFileAsync = promisify(execFile);

/** 在沙箱根目录执行 git 命令（无 repo 时返回 null） */
async function gitIn(sandbox: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: sandbox, timeout: 15_000, windowsHide: true });
    return stdout;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 128 || code === 'ENOENT') return null; // 非 git 仓库 / git 未安装
    throw err;
  }
}

/** 用系统文件管理器打开目标（Windows: explorer） */
function openInExplorer(target: string): void {
  const args = process.platform === 'win32' ? [`/select,${target}`] : [target];
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, args, { windowsHide: true }, (err) => {
    if (err) console.warn(`[open] ${target} 失败:`, err.message);
  });
}

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
  // 共效应解析（v2）：依赖注册表按 key 解析，只返回 ACTIVE 提供者的绑定——比扫描能力表更直接
  return kernel.plugins.resolveService('service:chat') as ChatService | undefined;
}

/** 角色只读工具白名单（与 subagent 语义一致：侦查/搜索/记忆，不改变世界） */
const ROLE_READONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'web_search', 'list_skills', 'get_skill',
  'recall_facts', 'plugin_status',
]);

/**
 * 断点历史完整性校验：恢复前必须保证 assistant 的 tool_calls 与 tool 回填配对完整、
 * tool 消息带 tool_call_id——否则 provider 会拒绝请求（missing tool_call_id）。
 * 返回 null = 完整可恢复；返回字符串 = 不一致原因（调用方应清除断点并明确告知）。
 */
function validateCheckpointHistory(history: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]): string | null {
  const pending = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as { id?: string }[]) {
        if (tc?.id) pending.add(tc.id);
      }
    } else if (m.role === 'tool') {
      if (!m.tool_call_id) return `断点第 ${i + 1} 条消息（工具回填）缺少 tool_call_id`;
      pending.delete(m.tool_call_id);
    }
  }
  if (pending.size > 0) return `断点存在 ${pending.size} 个未配对的工具调用（${[...pending].slice(0, 3).join(', ')}${pending.size > 3 ? '…' : ''}）`;
  return null;
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerRoutes(app: Express, kernel: Kernel, store: Store, tracker?: ClientTracker): void {
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
  const getSkillsService = (): SkillService | undefined =>
    kernel.plugins.resolveService('service:skills') as SkillService | undefined;
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

  // ---------- 会话 ----------
  app.get('/api/sessions', (_req, res) => res.json(store.listSessions()));

  app.post('/api/sessions', (req, res) => {
    const model = String(req.body?.model ?? '');
    res.json(store.createSession(model));
  });

  app.get('/api/sessions/:id/messages', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    // 前端展示过滤：隐藏发送序列中的注入消息（失败教训/长期记忆/英文提醒/角色移交）
    // ——它们是 harness 内部上下文工程，不是用户可见的对话内容；
    // 组装（chat 端点）保留它们以保证 L3 前缀缓存逐字节延续。
    const visible = store.listMessages(session.id).filter((m) => {
      const c = String(m.content ?? '');
      if (m.role === 'system' && c.startsWith('Reason in ENGLISH')) return false;
      if (c.startsWith('【失败教训】') || c.startsWith('【长期记忆】') || c.startsWith('【角色移交】') || c.startsWith('【继续】')) return false;
      return true;
    });
    res.json(visible);
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const { title, model, mode, role, archived, pinned } = req.body ?? {};
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
      ...(typeof role === 'string' ? { role } : {}),
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

  // ---------- 断点状态查询（前端可据此显示「继续任务」入口） ----------
  app.get('/api/sessions/:id/checkpoint', (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const cp = store.loadCheckpoint(session.id);
    res.json({
      exists: !!cp,
      turn: cp?.turn ?? 0,
      historyMessages: cp?.history.length ?? 0,
      createdAt: cp?.createdAt ?? 0,
    });
  });
  // ---------- 对话（SSE 流式；body.resume=true 时从断点历史继续） ----------
  app.post('/api/sessions/:id/chat', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const { message, model, provider: providerId, systemPrompt: systemPromptParam, resume } = req.body ?? {};
    // 断点续跑：resume=true 时不需要新消息，从断点历史继续（中断的任务不白跑）
    if (!resume && !message?.trim()) return res.status(400).json({ error: '消息不能为空' });
    // 编码防御：拒绝含替换符/孤立代理项的消息（防外部工具写入乱码）
    if (!resume && (/\uFFFD/.test(message) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/.test(message))) {
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
    // 会话级成本硬上限（实时熔断）：总预算 - 会话历史累计 = 本任务剩余预算。
    // 剩余 ≤ 0 时不传（runner 不熔断——历史已超预算时由下方警告提示收敛，避免卡死续跑）。
    const remainingBudget = costBudget > 0 ? costBudget - sessionCost : 0;
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
    const baseSystemPrompt = (typeof systemPromptParam === 'string' && systemPromptParam.trim()
      ? systemPromptParam
      : chat.getSystemPrompt()) + (modePrompt ? `\n\n${modePrompt}` : '') + `\n\n${worldState}` + costWarning;

    // 角色接管（handoff）：会话处于某角色时，角色提示词置于最前（引导力最强），
    // 通用规则保留在后；角色工具集按声明过滤（readonly=只读白名单）。
    // 角色与模式正交：plan/goal 模式提示词照常注入，角色只管身份与工具边界。
    const roleDef = session.role
      ? kernel.plugins.capabilities('role').find((c) => c.role.id === session.role)?.role
      : undefined;
    const systemPrompt = roleDef
      ? `${roleDef.systemPrompt}\n\n（以下为通用规则，与角色纪律冲突时以角色纪律为准）\n${baseSystemPrompt}`
      : baseSystemPrompt;

    // 计划模式状态机：1=待出计划（不注入工具，强制先出计划）→ 2=已出计划待确认（放行工具）→ 0
    const planPending = session.planPending ?? 0;
    const roleToolsOverride = roleDef?.tools === 'readonly'
      ? kernel.plugins.capabilities('tool').map((c) => c.tool).filter((t) => ROLE_READONLY_TOOLS.has(t.name))
      : undefined;
    const toolsOverride = session.mode === 'plan' && planPending === 1 ? [] : roleToolsOverride;

    // 历史组装：DB 消息 → LLM 消息（完整重建：assistant 的 tool_calls 与 tool 回填
    // 全部保留——跨 run 请求序列字节级一致，L3 provider 前缀缓存持续命中；
    // system 消息（【历史摘要】/截断说明）也保留：它们是压缩持久化的产物）。
    // 配对修复：中断可能留下「assistant 带 tool_calls 但工具未执行」的残轮
    // （onHistoryMessage 在工具执行前已入库）——未配对的 tool_calls 剥离，
    // 否则 provider 校验失败（OpenAI 兼容要求 tool_calls 后有对应 tool 消息）。
    function buildHistory(rows: Message[]): LLMMessage[] {
      // 组装原始序列（system 保留、assistant 保留 tool_calls 配对、tool 保留 tool_call_id），
      // 然后统一走共享 textualizeHistory——与 run 内发送形态完全一致（纯文本 + user 结尾）
      const raw: LLMMessage[] = [];
      for (const m of rows) {
        if (m.role === 'system') {
          raw.push({ role: 'system', content: m.content });
          continue;
        }
        if (m.role === 'tool') {
          raw.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' });
          continue;
        }
        const base: LLMMessage = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.toolCalls?.length) {
          // 配对修复：中断可能留下「assistant 带 tool_calls 但工具未执行」的残轮
          const ids = new Set(rows.filter((x) => x.role === 'tool' && x.toolCallId).map((x) => x.toolCallId));
          const paired = m.toolCalls.filter((c) => ids.has(c.id));
          if (paired.length) base.tool_calls = paired;
        }
        raw.push(base);
      }
      return textualizeHistory(raw);
    }
    let history: LLMMessage[];
    if (resume) {
      // 断点续跑：用 checkpoint 的完整历史（含工具回填），末尾加恢复提示——
      // 恢复语义 = 从最后一轮继续决策，不追加用户消息、不落库（续跑结果由后续轮次落库）
      const cp = store.loadCheckpoint(session.id);
      if (!cp || !cp.history.length) return res.status(404).json({ error: '该会话没有可恢复的断点（任务已完成或从未中断）' });
      // 断点完整性校验：assistant 的 tool_calls 必须与 tool 回填配对、tool 消息必须带
      // tool_call_id——否则 provider 校验失败（旧版本遗留的缺字段断点直接报错白跑）。
      // 不一致 → 清除该断点并明确告知（用户重新发起任务即可），而不是把坏数据发给 LLM。
      const invalid = validateCheckpointHistory(cp.history);
      if (invalid) {
        store.clearCheckpoint(session.id);
        return res.status(400).json({ error: `${invalid}——该断点已清除，请重新发起任务` });
      }
      history = [
        ...cp.history as LLMMessage[],
        { role: 'system', content: '【任务恢复】任务曾被中断，请从断点继续完成未竟的目标；已有观察（工具结果）在上下文中可直接使用。' },
      ];
    } else {
      history = buildHistory(store.listMessages(session.id));
      history.push({ role: 'user', content: message });
      store.addMessage({ sessionId: session.id, role: 'user', content: message });
      if (session.title === '新会话') store.updateSession(session.id, { title: message.slice(0, 30) });
    }

    const traceId = randomUUID();
    const ac = new AbortController();
    // 上下文管理 v2：超预算时优先 LLM 摘要压缩（compact：旧对话变【历史摘要】，不丢事实），
    // 压缩不可用/失败才截断（truncate：丢弃较早消息并注入说明）。
    // 对标 Anthropic context compaction——截断是物理删除，压缩是信息保鲜。
    // 压缩结果持久化回 DB：长会话只在首次超预算时压缩一次，后续 run 直接复用
    // （否则每次提问都重新压缩 = 每轮一次全量 LLM 调用 + 前缀重建，成本失控）。
    const maxCtx = kernel.config.get<number>('context.maxTokens', 60000);
    const compactEnabled = kernel.config.get<boolean>('context.compact', true);
    let ctxHistory: LLMMessage[];
    let ctxMode: 'none' | 'compact' | 'truncate' = 'none';
    let droppedMessages = 0;
    if (compactEnabled) {
      const r = await compactHistory(history, maxCtx, { provider, model: resolvedModel, signal: ac.signal, traceId, trace: kernel.trace });
      ctxHistory = r.messages;
      ctxMode = r.mode;
      droppedMessages = r.droppedMessages;
    } else {
      const r = truncateHistory(history, maxCtx);
      ctxHistory = r.messages;
      ctxMode = r.truncated ? 'truncate' : 'none';
      droppedMessages = r.droppedMessages;
    }
    if (ctxMode === 'truncate') {
      kernel.trace.startStep({ traceId, turn: 0, type: 'system', name: '上下文截断' })
        .finish({ outputSummary: `超出预算（${maxCtx} tokens），已丢弃 ${droppedMessages} 条较早消息` });
    }
    // 压缩/截断持久化：把处理后的消息序列写回 DB（摘要/说明 + 保留消息，字段完整）。
    // 下次 run 组装即得压缩后历史——不重复压缩、前缀在重建后持续稳定。
    // 写回失败不阻断对话（仅损失一次压缩的复用）。
    if (ctxMode !== 'none') {
      try {
        const oldRows = store.listMessages(session.id);
        // 尽力复制原消息的 tokens/cost 统计（按 role+content 匹配，压缩后统计不丢）
        const meta = new Map(oldRows.map((r) => [`${r.role}|${r.content}`, r]));
        store.clearSessionMessages(session.id);
        for (const m of ctxHistory) {
          const old = meta.get(`${m.role}|${m.content}`);
          store.addMessage({
            sessionId: session.id,
            role: m.role,
            content: m.content,
            ...(m.role === 'assistant' && m.tool_calls?.length ? { toolCalls: m.tool_calls } : {}),
            ...(m.role === 'tool' ? { toolCallId: m.tool_call_id } : {}),
            tokensIn: old?.tokensIn ?? 0,
            tokensOut: old?.tokensOut ?? 0,
            cost: old?.cost ?? 0,
            traceId: old?.traceId,
          });
        }
      } catch (err) {
        console.warn('[routes] 压缩结果持久化失败（不影响本次对话）:', err instanceof Error ? err.message : String(err));
      }
    }
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
    // 最终 assistant 消息已通过 onHistoryMessage 入库（id 记录于此）：
    // run 结束后仅回填 tokens/cost/reasoning，避免同内容消息重复入库
    let lastAssistantId: string | null = null;
    // 发送序列累积（用于预热：run 结束后用同一前缀主动刷新网关缓存）
    const seqAcc: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[] = [];
    try {
      // 轮数上限按模式分配（配置可调）：目标模式=长任务（计划→执行→验证→总结），
      // 上限显著放宽；普通模式防无限循环（默认 12）。超限后断点仍在，可继续推进。
      const maxTurnsByMode: Record<string, number> = {
        goal: kernel.config.get<number>('agent.maxTurnsGoal', 48),
        plan: kernel.config.get<number>('agent.maxTurnsPlan', 24),
        normal: kernel.config.get<number>('agent.maxTurns', 12),
      };
      for await (const ev of chat.runner.run({
        provider, model: resolvedModel, messages: ctxHistory, traceId,
        maxTurns: maxTurnsByMode[session.mode] ?? 12,
        // L1 会话级缓存作用域：稳定会话 ID——同一会话多次提问共享"会话自产答案"，
        // 不同会话互不串用（答案依赖工具观察时仅本会话可命中）
        scope: session.id,
        // 工具上下文会话 ID：todo 等插件把状态挂到具体会话
        sessionId: session.id,
        signal: ac.signal, systemPrompt, tools: toolsOverride,
        // 失败恢复：备用 provider（主服务宕机/限流时自动切换，LLM 无感）
        fallbackProviders: chat.providers.filter((p) => p.id !== provider.id),
        // 成本实时熔断：剩余预算传执行器，超限强制停止（harness 硬边界）
        costBudget: remainingBudget > 0 ? remainingBudget : undefined,
        // 断点续跑：每轮工具执行完自动持久化完整历史（中断不白跑；resume 从断点继续）。
        // 必须存完整字段（tool_calls/tool_call_id 配对），否则恢复时 provider 校验失败。
        onCheckpoint: (turn, hist) => {
          store.saveCheckpoint(session.id, turn, hist.map((m) => ({
            role: m.role, content: m.content ?? null,
            tool_calls: m.tool_calls, tool_call_id: m.tool_call_id,
          })));
        },
        // 发送序列快照同步（assistant 含 tool_calls / tool 含 tool_call_id / 注入消息）：
        // DB = 发送序列的忠实镜像 → 跨 run 组装与上 run 序列构成纯追加 → L3 前缀逐字节延续。
        onHistorySync: (msgs) => {
          try {
            for (const m of msgs) {
              // history[0]（system prompt）已被 syncedCount 排除；此处所有 system 消息
              // （英文提醒/角色移交等）均为发送序列的忠实组成，全部入库
              seqAcc.push({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id });
              const saved = store.addMessage({
                sessionId: session.id,
                role: m.role as LLMRole,
                content: m.content,
                ...(m.role === 'assistant' && m.tool_calls?.length ? { toolCalls: m.tool_calls } : {}),
                ...(m.role === 'tool' ? { toolCallId: m.tool_call_id } : {}),
              });
              if (m.role === 'assistant') lastAssistantId = saved.id;
            }
          } catch (err) {
            console.warn('[routes] 发送序列同步入库失败:', err instanceof Error ? err.message : String(err));
          }
        },
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
        } else if (ev.type === 'budget_hit') {
          // 成本熔断：harness 硬边界触发（SSE 推送，前端可展示）
          sse(res, 'budget_hit', { cost: ev.cost, budget: ev.budget });
        } else if (ev.type === 'handoff') {
          // 角色移交：会话控制权交给目标角色（后续对话由该角色提示词/工具集接管）
          store.updateSession(session.id, { role: ev.role });
          sse(res, 'handoff', { role: ev.role, objective: ev.objective });
        } else if (ev.type === 'tool_result') {
          sse(res, 'tool_result', { name: ev.name, summary: ev.summary, ok: ev.ok, stored: ev.stored ?? false });
        } else if (ev.type === 'assistant_done') {
          usage = ev.usage;
          cost = ev.cost;
          // 任务正常完成 → 断点失效（恢复点只对未完成任务有意义）
          store.clearCheckpoint(session.id);
          sse(res, 'done', { content: ev.content, reasoning: ev.reasoning, usage: ev.usage, cost: ev.cost, cached: ev.cached ?? false });
        } else if (ev.type === 'error') {
          sse(res, 'error', { error: ev.error });
        }
      }
    } catch (err) {
      sse(res, 'error', { error: err instanceof Error ? err.message : String(err) });
    }
    if (assistantText && lastAssistantId) {
      // 最终轮已入库（onHistoryMessage）：回填结算字段（tokens/cost/reasoning）
      store.updateMessageStats(lastAssistantId, {
        reasoning: assistantReasoning,
        tokensIn: usage.input, tokensOut: usage.output, cost, traceId,
      });
    } else if (assistantText) {
      // L1 缓存命中路径（无 LLM 轮次，未走 onHistoryMessage）：直接入库
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
    // 缓存预热/保活：run 结束后用同一前缀主动刷新网关前缀缓存——
    // 网关对「含 tool_calls 的请求」的缓存建立有延迟/条件限制，且前缀缓存有 TTL；
    // 预热请求（max_tokens=1，成本≈0）主动建立/刷新缓存，把下一次提问的 turn0
    // 也拉入缓存窗口（跨 run 首轮不再全价 prefill）。
    // 预热仅在发送序列足够长时触发（≥5 条消息才有缓存价值；L1 命中的短序列跳过）
    if (seqAcc.length >= 5 && kernel.config.get<boolean>('cache.warmup', false)) {
      // 预热/保活（默认关闭）：实测本网关（opencode.ai/zen/go）对含 tool_calls 的
      // 请求缓存建立有延迟/条件限制，预热请求反而会占用/污染缓存条目；
      // 保留实现供兼容 provider 的网关启用（配置 cache.warmup=true）。
      scheduleWarmup(session.id, systemPrompt, seqAcc, provider, resolvedModel, kernel);
    }
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

  // 文件搜索：递归匹配文件名/相对路径（跳过 node_modules/.git/dist，上限 200 条）
  app.get('/api/files/search', (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim().toLowerCase();
      if (!q) return res.json({ query: '', results: [] });
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const skip = new Set(['node_modules', '.git', 'dist', '.dsh', 'data']);
      const results: { path: string; size: number }[] = [];
      const walk = (dir: string, rel: string): void => {
        if (results.length >= 200) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= 200) return;
          if (skip.has(e.name)) continue;
          const child = join(dir, e.name);
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(child, childRel);
          else if (e.name.toLowerCase().includes(q)) {
            let size = 0;
            try { size = statSync(child).size; } catch { /* 忽略 */ }
            results.push({ path: childRel, size });
          }
        }
      };
      walk(sandbox, '');
      res.json({ query: q, results });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 用系统文件管理器打开沙箱内文件/目录
  app.post('/api/files/open', (req, res) => {
    try {
      const relPath = String(req.body?.path ?? '');
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const target = relPath ? resolveInSandbox(sandbox, relPath) : sandbox;
      if (!existsSync(target)) return res.status(404).json({ error: '路径不存在' });
      openInExplorer(target);
      res.json({ ok: true, path: relPath || '.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- Git（沙箱仓库状态 / 提交 / 推送） ----------
  app.get('/api/git/status', async (_req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const out = await gitIn(sandbox, ['status', '--porcelain=v1', '-b']);
      if (out === null) return res.json({ repo: false, branch: '', ahead: 0, staged: [], changes: [] });
      const lines = out.split('\n').filter(Boolean);
      const head = lines[0]?.startsWith('## ') ? lines.shift()! : '';
      const branch = head.replace('## ', '').split('...')[0] || '';
      const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      const staged: { path: string; status: string }[] = [];
      const changes: { path: string; status: string }[] = [];
      for (const line of lines) {
        const x = line[0] ?? ' ', y = line[1] ?? ' ', p = line.slice(3);
        if (!p) continue;
        if (x === '?' && y === '?') { changes.push({ path: p, status: '??' }); continue; }
        if (x !== ' ' && x !== '?') staged.push({ path: p, status: x });
        if (y !== ' ' && y !== '?') changes.push({ path: p, status: y });
      }
      res.json({ repo: true, branch, ahead, staged, changes });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/git/commit', async (req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const message = String(req.body?.message ?? '').trim();
      if (!message) return res.status(400).json({ error: '提交信息不能为空' });
      await gitIn(sandbox, ['add', '-A']);
      const out = await gitIn(sandbox, ['commit', '-m', message]);
      if (out === null) return res.status(400).json({ error: '沙箱不是 git 仓库' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/git/push', async (_req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const out = await gitIn(sandbox, ['push']);
      if (out === null) return res.status(400).json({ error: '沙箱不是 git 仓库' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 运行时配置（上下文管理 / 缓存参数 / 思维链预算，config.changed 热生效） ----------
  app.get('/api/config', (_req, res) => {
    res.json({
      context: {
        maxTokens: kernel.config.get<number>('context.maxTokens', 60000),
        truncateInject: kernel.config.get<boolean>('context.truncateInject', true),
        compact: kernel.config.get<boolean>('context.compact', true),
      },
      cache: {
        l1Threshold: kernel.config.get<number>('cache.l1Threshold', 0.58),
        l2TtlMin: kernel.config.get<number>('cache.l2TtlMin', 30),
        l3Enabled: kernel.config.get<boolean>('cache.l3Enabled', true),
      },
      agent: {
        reasoningBudget: kernel.config.get<number>('agent.reasoningBudget', 800),
        reasoningTotalBudget: kernel.config.get<number>('agent.reasoningTotalBudget', 3000),
        thinkInEnglish: kernel.config.get<boolean>('agent.thinkInEnglish', true),
      },
    });
  });

  app.patch('/api/config', (req, res) => {
    try {
      const { context, cache, agent } = req.body ?? {};
      if (context?.maxTokens !== undefined) {
        kernel.config.set('context.maxTokens', Math.max(2000, Math.min(200_000, Number(context.maxTokens))));
      }
      if (context?.truncateInject !== undefined) kernel.config.set('context.truncateInject', Boolean(context.truncateInject));
      if (context?.compact !== undefined) kernel.config.set('context.compact', Boolean(context.compact));
      if (cache?.l1Threshold !== undefined) {
        const v = Math.min(1, Math.max(0.5, Number(cache.l1Threshold)));
        kernel.config.set('cache.l1Threshold', v);
        kernel.cache.setConfig({ l1TextThreshold: v });
      }
      if (cache?.l2TtlMin !== undefined) {
        const m = Math.max(1, Math.min(1440, Number(cache.l2TtlMin)));
        kernel.config.set('cache.l2TtlMin', m);
        kernel.cache.setConfig({ l2TtlMs: m * 60_000 });
      }
      if (cache?.l3Enabled !== undefined) kernel.config.set('cache.l3Enabled', Boolean(cache.l3Enabled));
      if (agent?.reasoningBudget !== undefined) {
        kernel.config.set('agent.reasoningBudget', Math.max(100, Math.min(16000, Number(agent.reasoningBudget))));
      }
      if (agent?.reasoningTotalBudget !== undefined) {
        kernel.config.set('agent.reasoningTotalBudget', Math.max(200, Math.min(64000, Number(agent.reasoningTotalBudget))));
      }
      if (agent?.thinkInEnglish !== undefined) {
        kernel.config.set('agent.thinkInEnglish', Boolean(agent.thinkInEnglish));
      }
      // 轮数上限（按模式可调）：超限后断点保留，可继续推进
      if (agent?.maxTurns !== undefined) {
        kernel.config.set('agent.maxTurns', Math.max(1, Math.min(200, Number(agent.maxTurns))));
      }
      if (agent?.maxTurnsPlan !== undefined) {
        kernel.config.set('agent.maxTurnsPlan', Math.max(1, Math.min(400, Number(agent.maxTurnsPlan))));
      }
      if (agent?.maxTurnsGoal !== undefined) {
        kernel.config.set('agent.maxTurnsGoal', Math.max(1, Math.min(400, Number(agent.maxTurnsGoal))));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 元信息（设置页「打开目录」等） ----------
  app.get('/api/meta/paths', (_req, res) => {
    const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    res.json({
      sandboxRoot: sandbox,
      dbFile: kernel.paths.dbFile,
      tracesDir: kernel.paths.traces,
      configFile: kernel.paths.configFile,
    });
  });

  app.post('/api/meta/open', (req, res) => {
    const kind = String(req.body?.kind ?? '');
    const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
    const targets: Record<string, string> = {
      sandbox,
      db: kernel.paths.dbFile,
      traces: kernel.paths.traces,
      config: kernel.paths.configFile,
    };
    const target = targets[kind];
    if (!target || !existsSync(target)) return res.status(404).json({ error: '目标不存在' });
    openInExplorer(target);
    res.json({ ok: true, kind, path: target });
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

  // 用系统文件管理器打开插件源码目录
  app.post('/api/plugins/:id/open', (req, res) => {
    const inst = kernel.plugins.get(req.params.id);
    if (!inst) return res.status(404).json({ error: '插件不存在' });
    if (!existsSync(inst.dir)) return res.status(404).json({ error: '插件目录不存在' });
    openInExplorer(inst.dir);
    res.json({ ok: true, path: inst.dir });
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
    const maxCtx = kernel.config.get<number>('context.maxTokens', 60000);
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
        // L3 双口径：估算（相邻调用公共前缀 token，无 provider 反馈时的降级度量）
        // + 真实（provider usage 确认的缓存命中 token，唯一权威）。
        // 真实命中率 = realTokens / (realTokens + realMissTokens)
        l3: {
          hits: cache.l3Hits, tokens: cache.l3Tokens,
          realHits: cache.l3RealHits, realTokens: cache.l3RealTokens, realMissTokens: cache.l3RealMissTokens,
          realRate: (() => {
            const total = cache.l3RealTokens + cache.l3RealMissTokens;
            return total > 0 ? Math.round((cache.l3RealTokens / total) * 1000) / 10 : 0;
          })(),
        },
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
    // 页面存活跟踪：SSE 常驻连接 = 前端页面开着的证据（关闭页面/刷新 → 连接断开）
    tracker?.onConnect(res);
    // SSE 心跳：长连接保活
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已关闭 */ } }, 15000);
    const off = kernel.bus.on('*', (e) => {
      sse(res, 'event', { type: e.type, traceId: e.traceId, data: e.data, ts: e.ts });
    });
    req.on('close', () => { off(); clearInterval(heartbeat); tracker?.onDisconnect(res); });
  });
}
