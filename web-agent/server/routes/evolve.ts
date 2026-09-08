/**
 * server/routes/evolve.ts —— 技能提案（自进化）端点
 */
import type { Express } from 'express';
import type { RouteDeps } from './shared';

interface EvolveService {
  list: () => unknown[];
  accept: (id: string) => { ok: boolean; error?: string; name?: string };
  reject: (id: string) => { ok: boolean; error?: string };
  remove: (id: string) => { ok: boolean };
  toolStats: () => Record<string, { calls: number; fails: number; lastFailTs: number }>;
}

export function registerEvolveRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const svc = (): EvolveService | undefined =>
    kernel.plugins.resolveService('service:evolve') as EvolveService | undefined;

  const reloadSkills = async (): Promise<void> => {
    try { await kernel.plugins.reload('skills'); } catch { /* 重载失败：下次加载生效 */ }
  };

  app.get('/api/evolve/proposals', (_req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'evolve 插件未加载' });
    const proposals = s.list();
    res.json({
      proposals,
      pending: proposals.filter((p) => (p as { status?: string }).status === 'pending').length,
      toolStats: s.toolStats(),
    });
  });

  app.post('/api/evolve/:id/accept', async (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'evolve 插件未加载' });
    const r = s.accept(String(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    await reloadSkills();
    res.json({ ok: true, name: r.name });
  });

  app.post('/api/evolve/:id/reject', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'evolve 插件未加载' });
    const r = s.reject(String(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  });

  app.post('/api/evolve/:id/delete', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'evolve 插件未加载' });
    res.json(s.remove(String(req.params.id)));
  });
}
