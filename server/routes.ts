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
import { statSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Store } from './db';

interface ChatService {
  providers: ProviderDef[];
  runner: AgentRunner;
  setProviders: (cfgs: ProviderConfig[]) => void;
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

  // ---------- 模型 ----------
  app.get('/api/models', (_req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json([]);
    res.json(chat.providers.map((p) => ({ id: p.id, label: p.label, model: p.defaultModel })));
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
    const { title, model } = req.body ?? {};
    store.updateSession(session.id, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof model === 'string' ? { model } : {}),
    });
    res.json(store.getSession(session.id));
  });

  app.delete('/api/sessions/:id', (req, res) => {
    if (!store.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    store.deleteSession(req.params.id);
    res.json({ ok: true });
  });

  // ---------- 对话（SSE 流式） ----------
  app.post('/api/sessions/:id/chat', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    const { message, model, provider: providerId, systemPrompt } = req.body ?? {};
    if (!message?.trim()) return res.status(400).json({ error: '消息不能为空' });

    const chat = getChatService(kernel);
    if (!chat) return res.status(500).json({ error: '对话服务未加载' });
    const provider = chat.providers.find((p) => p.id === providerId) ?? chat.providers[0];
    if (!provider) return res.status(500).json({ error: '未配置 LLM Provider，请先配置 .env' });
    const resolvedModel = model || session.model || provider.defaultModel;

    // 历史组装：DB 消息 → LLM 消息（工具中间消息不入库，历史保持干净）
    const history: LLMMessage[] = store
      .listMessages(session.id)
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m): m is LLMMessage => m.role === 'user' || m.role === 'assistant');
    history.push({ role: 'user', content: message });

    store.addMessage({ sessionId: session.id, role: 'user', content: message });
    if (session.title === '新会话') store.updateSession(session.id, { title: message.slice(0, 30) });

    const traceId = randomUUID();
    const ac = new AbortController();
    // 客户端断开才中断（req close 在请求体读完即触发，不可用）
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(res, 'start', { traceId });

    let assistantText = '';
    let assistantReasoning = '';
    let usage = { input: 0, output: 0 };
    let cost = 0;
    try {
      for await (const ev of chat.runner.run({
        provider, model: resolvedModel, messages: history, traceId,
        signal: ac.signal, systemPrompt,
      })) {
        if (ev.type === 'delta') {
          assistantText += ev.text;
          sse(res, 'delta', { text: ev.text });
        } else if (ev.type === 'reasoning') {
          assistantReasoning += ev.text;
          sse(res, 'reasoning', { text: ev.text });
        } else if (ev.type === 'tool_start') {
          sse(res, 'tool_start', { name: ev.name, args: ev.args });
        } else if (ev.type === 'tool_result') {
          sse(res, 'tool_result', { name: ev.name, summary: ev.summary, ok: ev.ok });
        } else if (ev.type === 'assistant_done') {
          usage = ev.usage;
          cost = ev.cost;
          sse(res, 'done', { content: ev.content, reasoning: ev.reasoning, usage: ev.usage, cost: ev.cost });
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
    store.touchSession(session.id);
    sse(res, 'end', {});
    res.end();
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
    res.json({ steps: kernel.trace.query(traceId) });
  });

  app.get('/api/trace/stats', (_req, res) => {
    res.json({ trace: kernel.trace.statsSnapshot(), cache: kernel.cache.statsSnapshot(), l1Enabled: kernel.cache.l1Enabled });
  });

  // ---------- 全局事件流（前端实时面板） ----------
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const off = kernel.bus.on('*', (e) => {
      sse(res, 'event', { type: e.type, traceId: e.traceId, data: e.data, ts: e.ts });
    });
    req.on('close', off);
  });
}
