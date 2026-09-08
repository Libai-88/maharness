/**
 * server/routes/providers.ts —— Provider 管理（网页端；DB 为唯一来源）
 */
import type { Express } from 'express';
import { assertPublicHttpUrl, getChatService, maskKey, refreshChatProviders, type RouteDeps } from './shared';
import { extractFromProviderMeta, resolveCapabilities } from '../../kernel/modelCatalog';

/** 支持的协议族（本地/内网地址需 AGENT_ALLOW_PRIVATE_URLS=1） */
type ProviderProtocol = 'openai' | 'anthropic' | 'ollama';
const PROTOCOLS: ProviderProtocol[] = ['openai', 'anthropic', 'ollama'];

interface PulledModel { id: string; label?: string; raw: unknown }

/** 按协议拉取模型列表（三家端点/鉴权头各异）；HTTP 非 2xx 抛错且不回显远端 body */
async function fetchProviderModels(base: string, protocol: ProviderProtocol, key: string): Promise<PulledModel[]> {
  const doFetch = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 || r.status === 403 ? '（Key 无效或无权限）' : ''}`);
    return await r.json().catch(() => null);
  };
  const asArray = (j: unknown): unknown[] => {
    if (Array.isArray(j)) return j;
    const o = j as Record<string, unknown> | null;
    for (const k of ['data', 'models', 'body']) {
      if (Array.isArray(o?.[k])) return o![k] as unknown[];
    }
    return [];
  };
  const pick = (m: unknown): PulledModel | null => {
    if (typeof m === 'string') return m ? { id: m, raw: {} } : null;
    if (!m || typeof m !== 'object') return null;
    const o = m as Record<string, unknown>;
    const id = (typeof o.id === 'string' && o.id) || (typeof o.model === 'string' && o.model)
      || (typeof o.name === 'string' && o.name) || '';
    if (!id) return null;
    const label = typeof o.display_name === 'string' ? o.display_name : (typeof o.title === 'string' ? o.title : undefined);
    return { id, label, raw: o };
  };

  if (protocol === 'anthropic') {
    const j = await doFetch(`${base}/v1/models?limit=1000`, {
      'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json',
    });
    return asArray(j).map(pick).filter((m): m is PulledModel => !!m);
  }
  if (protocol === 'ollama') {
    const j = await doFetch(`${base}/api/tags`, { Accept: 'application/json' });
    const list = asArray(j);
    return list.map(pick).filter((m): m is PulledModel => !!m);
  }
  const j = await doFetch(`${base}/models`, { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  return asArray(j).map(pick).filter((m): m is PulledModel => !!m);
}

export function registerProviderRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  app.get('/api/providers', (_req, res) => {
    const models = store.listModels();
    res.json(store.listProviders().map((r) => ({
      id: r.id, label: r.label, baseUrl: r.baseUrl, model: r.model, protocol: r.protocol ?? 'openai',
      priceIn: r.priceIn, priceOut: r.priceOut, enabled: !!r.enabled,
      apiKeyMasked: maskKey(r.apiKey), hasKey: !!r.apiKey,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      models: models.filter(m => m.providerId === r.id),
    })));
  });

  app.post('/api/providers', async (req, res) => {
    const { label, baseUrl, apiKey, model, priceIn, priceOut } = req.body ?? {};
    const protocol = (PROTOCOLS as string[]).includes(String(req.body?.protocol ?? '')) ? String(req.body.protocol) : 'openai';
    if (!label?.trim() || !baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
      return res.status(400).json({ error: '名称 / 地址 / Key / 模型 均为必填' });
    }
    // H5 SSRF：保存路径与 /test 同规则校验（真实对话会按此地址服务端 fetch）。
    // AGENT_ALLOW_PRIVATE_URLS=1 显式放行本地/内网地址（本机 Ollama 等本地模型场景）。
    if (process.env.AGENT_ALLOW_PRIVATE_URLS !== '1') {
      try {
        await assertPublicHttpUrl(String(baseUrl).trim());
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'provider'}-${Math.random().toString(36).slice(2, 6)}`;
    store.upsertProvider({
      id, label: label.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), protocol: protocol as ProviderProtocol,
      priceIn: priceIn === '' || priceIn == null ? undefined : Number(priceIn),
      priceOut: priceOut === '' || priceOut == null ? undefined : Number(priceOut),
    });
    refreshChatProviders(kernel, store);
    const row = store.getProvider(id)!;
    res.json({ id: row.id, label: row.label, baseUrl: row.baseUrl, model: row.model, enabled: !!row.enabled, apiKeyMasked: maskKey(row.apiKey) });
  });

  app.patch('/api/providers/:id', async (req, res) => {
    const existing = store.getProvider(req.params.id);
    if (!existing) return res.status(404).json({ error: '供应商不存在' });
    const { label, baseUrl, apiKey, model, priceIn, priceOut, enabled } = req.body ?? {};
    const protocol = (PROTOCOLS as string[]).includes(String(req.body?.protocol ?? '')) ? String(req.body.protocol) : existing.protocol;
    // H5 SSRF：仅当地址被修改时校验（沿用已保存地址无需重复检查）
    if (baseUrl?.trim() && baseUrl.trim() !== existing.baseUrl && process.env.AGENT_ALLOW_PRIVATE_URLS !== '1') {
      try {
        await assertPublicHttpUrl(String(baseUrl).trim());
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    store.upsertProvider({
      id: existing.id,
      label: label?.trim() || existing.label,
      baseUrl: baseUrl?.trim() || existing.baseUrl,
      // Key 留空/不传 = 保持不变
      apiKey: apiKey?.trim() || existing.apiKey,
      model: model?.trim() || existing.model,
      protocol: protocol as ProviderProtocol,
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
    const base = String(baseUrl).trim().replace(/\/+$/, '');
    // H5 SSRF 防护：协议白名单 + DNS 解析后拒绝私网/环回/链路本地段
    //（provider test 是「用户可控 URL + 服务端发请求」的经典 SSRF 入口）
    try {
      await assertPublicHttpUrl(base);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${useKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        // H5：不回显远端 body（内网探针/错误页可能泄露内部信息）——只给状态码
        return res.status(400).json({ ok: false, error: `HTTP ${r.status}` });
      }
      res.json({ ok: true, message: '连接成功' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 模型 ----------
  /** 拉取模型列表（openai / anthropic / ollama 三协议），并落 models 表：
   *  每个模型带能力位（contextWindow/vision/tools/reasoning/价格），来源优先级
   *  provider 真实字段 > 内置目录推断。网页端据此免手敲、免手填能力。
   *  persist=false 时只返回不落库（新增供应商尚未保存的场景）。 */
  app.post('/api/providers/models', async (req, res) => {
    const { baseUrl, apiKey, providerId, persist } = req.body ?? {};
    let useKey = apiKey;
    let protocol = String(req.body?.protocol ?? '').trim();
    const existingRow = providerId ? store.getProvider(String(providerId)) : undefined;
    if (!useKey && existingRow) useKey = existingRow.apiKey;
    if (!protocol) protocol = existingRow?.protocol ?? 'openai';
    if (!PROTOCOLS.includes(protocol as ProviderProtocol)) {
      return res.status(400).json({ ok: false, error: `protocol 非法: ${protocol}` });
    }
    if (!baseUrl?.trim()) return res.status(400).json({ ok: false, error: '地址为必填' });
    if (!useKey?.trim() && protocol !== 'ollama') {
      return res.status(400).json({ ok: false, error: '地址 / Key 均为必填（编辑已保存供应商时 Key 可留空）' });
    }
    const base = String(baseUrl).trim().replace(/\/+$/, '');
    if (process.env.AGENT_ALLOW_PRIVATE_URLS !== '1') {
      try {
        await assertPublicHttpUrl(base);
      } catch (err) {
        return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    try {
      const raw = await fetchProviderModels(base, protocol as ProviderProtocol, String(useKey ?? ''));
      if (!raw.length) {
        return res.status(400).json({ ok: false, error: '响应中没有模型列表（data 为空或非该协议格式）' });
      }
      const pid = existingRow?.id ?? String(req.body?.providerDraftId ?? 'draft');
      const out = raw.map((m) => {
        const meta = extractFromProviderMeta(m.raw);
        const caps = resolveCapabilities(m.id, pid, {}, meta);
        return {
          id: m.id, label: m.label,
          contextWindow: caps.contextWindow, maxOutput: caps.maxOutput,
          vision: caps.vision, tools: caps.tools, reasoning: caps.reasoning,
          priceIn: caps.priceIn, priceOut: caps.priceOut,
          source: Object.keys(meta).length ? 'pulled' : 'inferred',
        };
      });
      if (persist !== false && existingRow) {
        for (const o of out) {
          store.upsertModel({
            providerId: existingRow.id, modelId: o.id,
            contextWindow: o.contextWindow, maxOutput: o.maxOutput,
            vision: o.vision ? 1 : 0, tools: o.tools ? 1 : 0, reasoning: o.reasoning ? 1 : 0,
            priceIn: o.priceIn, priceOut: o.priceOut, source: o.source, enabled: 1,
          });
        }
        refreshChatProviders(kernel, store);
      }
      res.json({ ok: true, protocol, count: out.length, models: out.slice(0, 500) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** 已保存模型与能力（网页端展示/编辑） */
  app.get('/api/providers/:id/models', (req, res) => {
    if (!store.getProvider(req.params.id)) return res.status(404).json({ error: '供应商不存在' });
    res.json({ models: store.listModels(req.params.id) });
  });

  /** 手改单个模型的能力位/价格（用户是最终事实源） */
  app.patch('/api/providers/:id/models/:model(*)', async (req, res) => {
    const provider = store.getProvider(req.params.id);
    if (!provider) return res.status(404).json({ error: '供应商不存在' });
    const modelId = decodeURIComponent(String((req.params as Record<string, string>)['model(*)'] ?? ''));
    const prev = store.listModels(provider.id).find(m => m.modelId === modelId);
    if (!prev) return res.status(404).json({ error: '模型未登记，请先拉取模型列表' });
    const b = req.body ?? {};
    store.upsertModel({
      ...prev,
      contextWindow: b.contextWindow === undefined ? prev.contextWindow : Number(b.contextWindow) || null,
      maxOutput: b.maxOutput === undefined ? prev.maxOutput : Number(b.maxOutput) || null,
      vision: b.vision === undefined ? prev.vision : (b.vision ? 1 : 0),
      tools: b.tools === undefined ? prev.tools : (b.tools ? 1 : 0),
      reasoning: b.reasoning === undefined ? prev.reasoning : (b.reasoning ? 1 : 0),
      priceIn: b.priceIn === undefined ? prev.priceIn : Number(b.priceIn),
      priceOut: b.priceOut === undefined ? prev.priceOut : Number(b.priceOut),
      enabled: b.enabled === undefined ? prev.enabled : (b.enabled ? 1 : 0),
      source: 'manual',
    });
    refreshChatProviders(kernel, store);
    res.json({ ok: true });
  });

  app.get('/api/models', (_req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json([]);
    res.json(chat.providers.map((p) => ({ id: p.id, label: p.label, model: p.defaultModel })));
  });
}
