/**
 * server/routes/providers.ts —— Provider 管理（网页端；DB 为唯一来源）
 */
import type { Express } from 'express';
import { assertPublicHttpUrl, getChatService, maskKey, refreshChatProviders, type RouteDeps } from './shared';

export function registerProviderRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  app.get('/api/providers', (_req, res) => {
    res.json(store.listProviders().map((r) => ({
      id: r.id, label: r.label, baseUrl: r.baseUrl, model: r.model,
      priceIn: r.priceIn, priceOut: r.priceOut, enabled: !!r.enabled,
      apiKeyMasked: maskKey(r.apiKey), hasKey: !!r.apiKey,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })));
  });

  app.post('/api/providers', async (req, res) => {
    const { label, baseUrl, apiKey, model, priceIn, priceOut } = req.body ?? {};
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
      id, label: label.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(),
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
  /** 拉取模型列表：GET {base}/models（OpenAI 兼容），网页端配置供应商时直接选择模型而非手敲。
   *  编辑已保存供应商时可不传 key（providerId 回退用已保存的）；
   *  SSRF 规则与保存路径一致（AGENT_ALLOW_PRIVATE_URLS=1 放行本地/内网——本机 Ollama 拉模型的主场景）。 */
  app.post('/api/providers/models', async (req, res) => {
    const { baseUrl, apiKey, providerId } = req.body ?? {};
    let useKey = apiKey;
    if (!useKey && providerId) {
      const row = store.getProvider(String(providerId));
      useKey = row?.apiKey;
    }
    if (!baseUrl?.trim() || !useKey?.trim()) {
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
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${useKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        // H5：不回显远端 body（内网探针/错误页可能泄露内部信息）——只给状态码
        return res.status(400).json({ ok: false, error: `HTTP ${r.status}${r.status === 401 || r.status === 403 ? '（Key 无效或无权限）' : ''}` });
      }
      const j = await r.json().catch(() => null) as { data?: unknown[] } | unknown[] | null;
      const arr = Array.isArray(j) ? j : Array.isArray((j as { data?: unknown[] })?.data) ? (j as { data: unknown[] }).data : [];
      const ids = arr
        .map((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : ''))
        .filter(Boolean);
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: '响应中没有模型列表（data 为空或非 OpenAI 兼容格式）' });
      }
      res.json({ ok: true, models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/models', (_req, res) => {
    const chat = getChatService(kernel);
    if (!chat) return res.json([]);
    res.json(chat.providers.map((p) => ({ id: p.id, label: p.label, model: p.defaultModel })));
  });
}
