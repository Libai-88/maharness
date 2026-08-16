/**
 * server/routes/plugins.ts —— 插件管理 + Capabilities Registry（能力发现）
 */
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { openInExplorer, type RouteDeps } from './shared';

export function registerPluginRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

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

  // ---------- 插件管理 ----------
  app.get('/api/plugins', (_req, res) => {
    // kernel 侧 list() 是不暴露内部结构的投影（无 caps 字段）；caps 从实例补齐
    res.json(kernel.plugins.list().map((p) => ({
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
      state: p.state,
      caps: (kernel.plugins.get(p.manifest.id)?.caps ?? []).map((c) => c.kind),
      error: p.error,
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
}
