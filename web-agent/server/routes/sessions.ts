/**
 * server/routes/sessions.ts —— 会话 CRUD / 消息查询 / 批量删除
 */
import type { Express } from 'express';
import type { RouteDeps } from './shared';

export function registerSessionRoutes(app: Express, deps: RouteDeps): void {
  const { store } = deps;

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
}
