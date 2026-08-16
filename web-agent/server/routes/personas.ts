/**
 * server/routes/personas.ts —— 人设管理（L1 用户人设）
 */
import type { Express } from 'express';
import { getChatService, refreshChatPersonas, type RouteDeps } from './shared';

export function registerPersonaRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

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
}
